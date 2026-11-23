import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectEventually, launchCallisto, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto | undefined;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'callisto-pw-')); });
test.afterEach(async () => {
  await c?.close();
  c = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Arranca Callisto; `auth`: respuesta simulada al cuadro de Windows Hello (solo existe sin empaquetar). */
async function launch(auth: 'allow' | 'deny' = 'deny') {
  c = await launchCallisto([], dir, { CALLISTO_TEST_AUTH: auth });
}

const offer = () => c!.ui.getByTestId('password-offer');

/** Pestaña web activa (ir a callisto://passwords la reemplaza por una interna y volver, por otra web). */
async function webTab(path: string): Promise<Page> {
  let t: Page | undefined;
  await expectEventually(() => {
    t = c!.app.windows().filter((w) => w.url().startsWith(`${server.base}${path}`)).at(-1);
    return !!t;
  });
  c!.tab = t!;
  return t!;
}

/** Inicia sesión en la página de prueba (o la indicada) con la pestaña activa. */
async function login(user: string, pass: string, path = '/login') {
  await typeAddress(c!.ui, `${server.base}${path}`);
  await webTab(path);
  await expect(c!.tab.locator('#pass')).toBeVisible();
  await c!.tab.fill('#user', user);
  await c!.tab.fill('#pass', pass);
  await c!.tab.click('#enter');
}

async function saveOffered(user: string, pass: string) {
  await login(user, pass);
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await expect(offer()).toBeVisible();
  await c!.ui.getByTestId('password-offer-save').click();
  await expect(offer()).toBeHidden();
}

async function passwordsPage(): Promise<Page> {
  await typeAddress(c!.ui, 'callisto://passwords');
  await expectEventually(() => c!.app.windows().some((p) => p.url().startsWith('callisto://passwords')));
  const p = c!.app.windows().find((w) => w.url().startsWith('callisto://passwords'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

/** ¿Está a la vista el menú de sugerencias de contraseñas? */
const autofillVisible = () =>
  c!.app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows().some((w) => (w.contentView.children as Electron.WebContentsView[]).some((v) => v.webContents.getURL().includes('/autofill.html') && v.getVisible())),
  );

async function autofillPage(): Promise<Page> {
  await expectEventually(() => c!.app.windows().some((p) => p.url().includes('/autofill.html')));
  return c!.app.windows().find((p) => p.url().includes('/autofill.html'))!;
}

const authRequests = () => c!.app.evaluate(() => (globalThis as unknown as { __callistoAuthRequests?: number }).__callistoAuthRequests ?? 0);

/** Contenido (bytes) de los archivos de la base de datos de los perfiles. */
function databaseBytes(root: string): Buffer {
  const out: Buffer[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (name.startsWith('callisto.db')) out.push(readFileSync(f));
    }
  };
  walk(root);
  return Buffer.concat(out);
}

test('cada preload es un solo archivo (un preload en sandbox no puede cargar otros)', () => {
  // Si dos preloads comparten un módulo con código, Vite lo saca a out/preload/chunks y el preload deja de cargar
  // entero (contraseñas, WebAuthn y descargas blob: incluidas)
  const out = resolve(__dirname, '../../out/preload');
  const entries = readdirSync(out);
  expect(entries.filter((e) => statSync(join(out, e)).isDirectory())).toEqual([]);
  for (const f of entries) expect(readFileSync(join(out, f), 'utf8')).not.toMatch(/require\(["']\.\.?\//);
});

test('ofrece guardar después de iniciar sesión; queda cifrada y aparece en callisto://passwords', async () => {
  await launch();
  await login('ana', 'Secreto-Unico-7391');
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await expect(offer()).toBeVisible();
  await expect(offer()).toHaveAttribute('data-mode', 'save');
  await expect(c!.ui.getByTestId('password-offer-site')).toHaveText(new URL(server.base).host);
  await expect(c!.ui.getByTestId('password-offer-username')).toHaveValue('ana');
  // La contraseña no llega a la interfaz
  expect(await c!.ui.content()).not.toContain('Secreto-Unico-7391');
  await c!.ui.getByTestId('password-offer-save').click();
  await expect(offer()).toBeHidden();

  const p = await passwordsPage();
  await expect(p.getByTestId('password-row')).toHaveCount(1);
  await expect(p.getByTestId('password-username')).toHaveText('ana');
  await expect(p.getByTestId('password-site')).toHaveText(new URL(server.base).host);
  await expect(p.getByTestId('password-value')).toHaveText('••••••••••');

  // En disco: ni la contraseña ni nada que se le parezca, en ningún archivo de la base
  await c!.close();
  const bytes = databaseBytes(dir);
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes.includes(Buffer.from('Secreto-Unico-7391', 'utf8'))).toBe(false);
  expect(bytes.includes(Buffer.from('Secreto-Unico-7391', 'utf16le'))).toBe(false);
  c = undefined;
});

test('un inicio de sesión fallido (vuelve a pedir la contraseña) no ofrece guardar', async () => {
  await launch();
  await login('ana', 'mala');
  await expect(c!.tab.locator('#error')).toBeVisible();
  await new Promise((r) => setTimeout(r, 1500));
  await expect(offer()).toBeHidden();
});

test('autocompletar: nada al cargar; la sugerencia aparece bajo el campo y rellena solo al elegirla', async () => {
  await launch();
  await saveOffered('ana', 'clave-ana');

  await typeAddress(c!.ui, `${server.base}/login`);
  await expect(c!.tab.locator('#pass')).toBeVisible();
  await new Promise((r) => setTimeout(r, 500));
  await expect(c!.tab.locator('#user')).toHaveValue(''); // nunca se rellena solo
  await expect(c!.tab.locator('#pass')).toHaveValue('');

  // Con el mouse
  await c!.tab.click('#user');
  await expectEventually(autofillVisible);
  const menu = await autofillPage();
  await expect(menu.getByTestId('autofill-item')).toHaveCount(1);
  await expect(menu.getByTestId('autofill-item')).toContainText('ana');
  await menu.getByTestId('autofill-item').first().click();
  await expect(c!.tab.locator('#user')).toHaveValue('ana');
  await expect(c!.tab.locator('#pass')).toHaveValue('clave-ana');
  await expectEventually(async () => !(await autofillVisible()));

  // Con el teclado: flecha abajo y Enter en el campo de contraseña
  await c!.tab.reload();
  await expect(c!.tab.locator('#pass')).toHaveValue('');
  await c!.tab.click('#pass');
  await expectEventually(autofillVisible);
  await c!.tab.keyboard.press('ArrowDown');
  await expect(menu.locator('[data-testid="autofill-item"][aria-selected="true"]')).toHaveCount(1);
  await c!.tab.keyboard.press('Enter');
  await expect(c!.tab.locator('#pass')).toHaveValue('clave-ana');
  await expect(c!.tab.locator('#user')).toHaveValue('ana');
  await expect(c!.tab).toHaveTitle('Iniciar sesión'); // el Enter eligió la sugerencia, no envió el formulario

  // Escape cierra el menú
  await c!.tab.click('#user');
  await expectEventually(autofillVisible);
  await c!.tab.keyboard.press('Escape');
  await expectEventually(async () => !(await autofillVisible()));
});

test('sin sugerencias en un iframe de otro sitio ni en sitios sin contraseñas guardadas', async () => {
  await launch();
  await saveOffered('ana', 'clave-ana');
  // El formulario de 127.0.0.1 dentro de una página de 127.0.0.1, pero en un iframe de localhost
  await typeAddress(c!.ui, `${server.base}/iframe-login`);
  const frame = c!.tab.frameLocator('#frame');
  await expect(frame.locator('#user')).toBeVisible();
  await frame.locator('#user').click();
  await new Promise((r) => setTimeout(r, 800));
  expect(await autofillVisible()).toBe(false);
  // Otro sitio (localhost no es 127.0.0.1): sin sugerencias
  await typeAddress(c!.ui, server.base.replace('127.0.0.1', 'localhost') + '/login');
  await c!.tab.click('#user');
  await new Promise((r) => setTimeout(r, 800));
  expect(await autofillVisible()).toBe(false);
});

test('actualizar una contraseña cambiada, y "Nunca para este sitio"', async () => {
  await launch('allow');
  await saveOffered('ana', 'vieja');
  // Ya guardada igual: no vuelve a ofrecer
  await login('ana', 'vieja');
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await new Promise((r) => setTimeout(r, 1200));
  await expect(offer()).toBeHidden();
  // Cambió: ofrece actualizar
  await login('ana', 'nueva');
  await expect(offer()).toHaveAttribute('data-mode', 'update');
  await expect(c!.ui.getByTestId('password-offer-never')).toHaveCount(0);
  await c!.ui.getByTestId('password-offer-save').click();
  await expect(offer()).toBeHidden();

  const p = await passwordsPage();
  await expect(p.getByTestId('password-row')).toHaveCount(1);
  await p.getByTestId('password-reveal').click();
  await expect(p.getByTestId('password-value')).toHaveText('nueva');

  // Nunca para este sitio
  await login('beto', 'otra');
  await expect(offer()).toHaveAttribute('data-mode', 'save');
  await c!.ui.getByTestId('password-offer-never').click();
  await expect(offer()).toBeHidden();
  await login('carla', 'otra-mas');
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await new Promise((r) => setTimeout(r, 1200));
  await expect(offer()).toBeHidden();

  const p2 = await passwordsPage();
  await expect(p2.getByTestId('passwords-blocked')).toHaveCount(1);
  await p2.getByTestId('passwords-unblock').click();
  await expect(p2.getByTestId('passwords-blocked')).toHaveCount(0);
  await login('carla', 'otra-mas');
  await expect(offer()).toBeVisible();
});

test('ver, copiar y editar requieren verificar la identidad: sin verificación no se muestra nada', async () => {
  await launch('deny');
  await saveOffered('ana', 'muy-secreta');
  const p = await passwordsPage();
  await p.getByTestId('password-reveal').click();
  await expect(p.getByTestId('password-error')).toHaveText('No se verificó tu identidad.');
  await expect(p.getByTestId('password-value')).toHaveText('••••••••••');
  await c!.app.evaluate(({ clipboard }) => clipboard.writeText('antes'));
  await p.getByTestId('password-copy').click();
  await expect(p.getByTestId('password-error')).toHaveText('No se verificó tu identidad.');
  expect(await c!.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('antes');
  await p.getByTestId('password-edit-button').click();
  await expect(p.getByTestId('password-edit')).toHaveCount(0);
  expect(await authRequests()).toBe(3);
  expect(await p.content()).not.toContain('muy-secreta');
});

test('con la identidad verificada: ver, copiar, editar y eliminar (una verificación vale un minuto)', async () => {
  await launch('allow');
  await saveOffered('ana', 'muy-secreta');
  const p = await passwordsPage();
  await p.getByTestId('password-reveal').click();
  await expect(p.getByTestId('password-value')).toHaveText('muy-secreta');
  await p.getByTestId('password-reveal').click();
  await expect(p.getByTestId('password-value')).toHaveText('••••••••••');

  await p.getByTestId('password-copy').click();
  await expect(p.getByTestId('passwords-message')).toContainText('Se copió la contraseña');
  expect(await c!.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('muy-secreta');

  await p.getByTestId('password-edit-button').click();
  await expect(p.getByTestId('password-edit-password')).toHaveValue('muy-secreta');
  await p.getByTestId('password-edit-username').fill('ana.maria');
  await p.getByTestId('password-edit-password').fill('cambiada');
  await p.getByTestId('password-edit-save').click();
  await expect(p.getByTestId('password-username')).toHaveText('ana.maria');
  expect(await authRequests()).toBe(1);

  // Lo editado es lo que se autocompleta
  await typeAddress(c!.ui, `${server.base}/login`);
  await webTab('/login');
  await c!.tab.click('#user');
  const menu = await autofillPage();
  await expect(menu.getByTestId('autofill-item')).toContainText('ana.maria');
  await menu.getByTestId('autofill-item').first().click();
  await expect(c!.tab.locator('#pass')).toHaveValue('cambiada');

  const p2 = await passwordsPage();
  await p2.getByTestId('password-delete').click();
  await p2.getByTestId('password-delete-confirm').click();
  await expect(p2.getByTestId('passwords-empty')).toBeVisible();
});

test('inicio de sesión en dos pasos y en una aplicación que no recarga', async () => {
  await launch();
  // Primero el correo, después (en otra página) solo la contraseña
  await typeAddress(c!.ui, `${server.base}/two-step`);
  await c!.tab.fill('#email', 'ana@ejemplo.com');
  await c!.tab.click('#next');
  await expect(c!.tab).toHaveTitle('Paso 2');
  await c!.tab.fill('#pass', 'dos-pasos');
  await c!.tab.click('#enter');
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await expect(c!.ui.getByTestId('password-offer-username')).toHaveValue('ana@ejemplo.com');
  await c!.ui.getByTestId('password-offer-close').click();
  await expect(offer()).toBeHidden();

  // Sin navegar: el formulario desaparece al iniciar sesión
  await login('beto', 'spa-clave', '/spa-login');
  await expect(c!.tab.locator('#ok')).toBeVisible();
  await expect(offer()).toBeVisible();
  await expect(c!.ui.getByTestId('password-offer-username')).toHaveValue('beto');
});

test('ventana privada: no ofrece guardar; desactivar la oferta en callisto://passwords', async () => {
  await launch();
  await pressKey(c!.app, 'ui', 'N', ['control', 'shift']);
  let priv: Page | undefined;
  await expectEventually(async () => {
    for (const p of c!.app.windows().filter((w) => w.url().startsWith('callisto://ui/index'))) {
      if ((await p.getByTestId('chrome').getAttribute('data-private')) === 'true') priv = p;
    }
    return !!priv;
  });
  await typeAddress(priv!, `${server.base}/login`);
  const privTab = await (async () => {
    let t: Page | undefined;
    await expectEventually(() => {
      t = c!.app.windows().filter((w) => w.url() === `${server.base}/login`).at(-1);
      return !!t;
    });
    return t!;
  })();
  await privTab.fill('#user', 'ana');
  await privTab.fill('#pass', 'privada');
  await privTab.click('#enter');
  await expect(privTab).toHaveTitle('Bienvenida');
  await new Promise((r) => setTimeout(r, 1200));
  await expect(priv!.getByTestId('password-offer')).toBeHidden();
  await c!.app.evaluate(({ BaseWindow }) => {
    for (const w of BaseWindow.getAllWindows()) if (w.getTitle().endsWith('(Privada)')) w.close();
  });

  // Oferta desactivada en el perfil: tampoco se ofrece en ventanas normales
  const p = await passwordsPage();
  await expect(p.getByTestId('passwords-offer')).toBeChecked();
  await p.getByTestId('passwords-offer').uncheck();
  await expect(p.getByTestId('passwords-offer')).not.toBeChecked();
  await login('ana', 'normal');
  await expect(c!.tab).toHaveTitle('Bienvenida');
  await new Promise((r) => setTimeout(r, 1200));
  await expect(offer()).toBeHidden();
});
