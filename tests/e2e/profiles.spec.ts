import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMenus, clickMenuItem, expectEventually, lastMenuLabels, launchCallisto, pressKey, startServer, typeAddress, windowCount, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-perfiles-'));
  c = await launchCallisto([], dir);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const isUi = (p: Page) => p.url().startsWith('callisto://ui/');

/** Interfaz de la ventana del perfil indicado (por el botón de perfil), o de una ventana privada. */
async function uiOf(which: string | 'privada', index = 0): Promise<Page> {
  let found: Page[] = [];
  await expectEventually(async () => {
    found = [];
    for (const p of c.app.windows().filter(isUi)) {
      const btn = p.getByTestId('profile-button');
      if (!(await btn.count())) continue;
      const priv = (await btn.getAttribute('data-private')) === 'true';
      const title = (await btn.getAttribute('title')) ?? '';
      if (which === 'privada' ? priv : !priv && title === `Perfil: ${which}`) found.push(p);
    }
    return found.length > index;
  });
  return found[index]!;
}

/** Visita una página en la pestaña activa de esa ventana y devuelve el título que dejó la página. */
async function visit(ui: Page, path: string, titlePrefix: string): Promise<string> {
  await typeAddress(ui, `${server.base}${path}`);
  let title = '';
  await expectEventually(async () => {
    title = (await ui.locator('[data-testid="tab"][data-active="true"] [data-testid="tab-title"]').textContent()) ?? '';
    return title.startsWith(titlePrefix);
  });
  return title;
}

const read = (ui: Page) => visit(ui, '/datos/leer', 'Lectura:');

async function internalPage(kind: string, n = 0): Promise<Page> {
  await expectEventually(() => c.app.windows().filter((p) => p.url().startsWith(`callisto://${kind}`)).length > n);
  const p = c.app.windows().filter((w) => w.url().startsWith(`callisto://${kind}`))[n]!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

async function createProfile(name: string, color = 'green'): Promise<Page> {
  await typeAddress(c.ui, 'callisto://profiles');
  const page = await internalPage('profiles');
  await page.getByTestId('profile-new-name').fill(name);
  await page.getByTestId(`color-${color}`).click();
  await page.getByTestId('profile-create').click();
  return uiOf(name);
}

// ---------------------------------------------------------------- aislamiento (criterio de V0.7)

test('perfiles: cookies, almacenamiento, historial y favoritos no se comparten', async () => {
  const personal = await uiOf('Personal');
  await visit(personal, '/datos/guardar?v=personal', 'Guardado');
  expect(await read(personal)).toBe('Lectura: cookie=personal almacenamiento=personal');

  const trabajo = await createProfile('Trabajo');
  expect(await windowCount(c.app)).toBe(2);
  expect(await read(trabajo)).toBe('Lectura: cookie=ninguna almacenamiento=ninguno');
  await visit(trabajo, '/datos/guardar?v=trabajo', 'Guardado');
  expect(await read(trabajo)).toBe('Lectura: cookie=trabajo almacenamiento=trabajo');
  expect(await read(personal)).toBe('Lectura: cookie=personal almacenamiento=personal'); // no se pisó

  // Favoritos: el de Personal no aparece en Trabajo
  await visit(personal, '/page1', 'Página 1');
  await personal.getByTestId('star').click();
  await personal.getByTestId('bookmark-save').click();
  await expect(personal.getByTestId('bookmark')).toHaveCount(1);
  await expect(trabajo.getByTestId('bookmark')).toHaveCount(0);

  // Historial: lo visitado en Personal no está en el de Trabajo
  await typeAddress(trabajo, 'callisto://history');
  const h = await internalPage('history');
  await expect(h.getByTestId('history-item').first()).toBeVisible();
  const titles = await h.getByTestId('history-title').allTextContents();
  expect(titles.some((t) => t.includes('personal') || t === 'Página 1')).toBe(false);
  expect(titles.some((t) => t.includes('trabajo'))).toBe(true);
});

test('ventana privada: aislada del perfil, sin historial, compartida entre privadas y borrada al cerrarlas', async () => {
  const personal = await uiOf('Personal');
  await visit(personal, '/datos/guardar?v=personal', 'Guardado');

  await pressKey(c.app, 'ui', 'N', ['control', 'shift']);
  const priv = await uiOf('privada');
  await expect(priv.getByTestId('chrome')).toHaveAttribute('data-private', 'true');
  await expect(priv.getByTestId('ntp-private')).toBeVisible();
  expect(await read(priv)).toBe('Lectura: cookie=ninguna almacenamiento=ninguno'); // no ve las del perfil
  await visit(priv, '/datos/guardar?v=privado', 'Guardado');
  expect(await read(personal)).toBe('Lectura: cookie=personal almacenamiento=personal'); // no las pisa
  await visit(priv, '/page2', 'Página 2');

  // Otra ventana privada (abierta desde la privada) comparte la misma sesión privada (como en Chrome)
  await pressKey(c.app, 'ui', 'N', ['control', 'shift'], 'newest');
  const priv2 = await uiOf('privada', 1);
  expect(await read(priv2)).toBe('Lectura: cookie=privado almacenamiento=privado');

  // Lo visitado en privado no está en el historial del perfil
  await typeAddress(personal, 'callisto://history');
  const h = await internalPage('history');
  await expect(h.getByTestId('history-item').first()).toBeVisible();
  expect(await h.getByTestId('history-title').allTextContents()).not.toContain('Página 2');

  // Al cerrar todas las privadas, la próxima empieza de cero
  await c.app.evaluate(({ BaseWindow }) => {
    for (const w of BaseWindow.getAllWindows()) if (w.getTitle().endsWith('(Privada)')) w.close();
  });
  await expectEventually(async () => (await windowCount(c.app)) === 1);
  await pressKey(c.app, 'ui', 'N', ['control', 'shift']);
  const priv3 = await uiOf('privada');
  expect(await read(priv3)).toBe('Lectura: cookie=ninguna almacenamiento=ninguno');

  // Nada de lo privado quedó en disco
  const partitions = join(dir, 'Partitions');
  expect(existsSync(partitions) ? readdirSync(partitions).filter((d) => d.includes('private')) : []).toEqual([]);
});

// ---------------------------------------------------------------- administrar perfiles

test('cambiar de perfil desde su botón, editar nombre y color, y ver el perfil en el título', async () => {
  await captureMenus(c.app);
  const trabajo = await createProfile('Trabajo');
  await expectEventually(async () => (await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((w) => w.getTitle()))).some((t) => t.endsWith('(Trabajo)')));
  // Sin franja de color arriba de las pestañas (1.4.1: se veía cortada junto a los botones de Windows); el perfil se ve en
  // su botón y en el título
  expect(await trabajo.locator('.tabstrip-row').evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  await expect(trabajo.getByTestId('profile-button')).toBeVisible();

  await trabajo.getByTestId('profile-button').click();
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Personal'));
  expect(await lastMenuLabels(c.app)).toEqual(expect.arrayContaining(['Personal', 'Trabajo', 'Nueva ventana privada', 'Agregar perfil…', 'Administrar perfiles']));
  await clickMenuItem(c.app, 'Personal'); // ya tiene ventana: se enfoca, no se abre otra
  expect(await windowCount(c.app)).toBe(2);

  await typeAddress(trabajo, 'callisto://profiles');
  const page = await internalPage('profiles', 1).catch(() => internalPage('profiles'));
  const row = page.locator('[data-testid="profile-row"]', { hasText: 'Trabajo' });
  await row.getByTestId('profile-edit-start').click();
  await page.getByTestId('profile-edit-name').fill('Oficina');
  await page.getByTestId('profile-edit').getByTestId('color-orange').click();
  await page.getByTestId('profile-edit-save').click();
  await uiOf('Oficina');
  await expectEventually(async () => (await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((w) => w.getTitle()))).some((t) => t.endsWith('(Oficina)')));
});

test('al reiniciar vuelven los perfiles que estaban abiertos, cada uno con sus pestañas', async () => {
  const trabajo = await createProfile('Trabajo');
  await visit(trabajo, '/page2', 'Página 2');
  const personal = await uiOf('Personal');
  await visit(personal, '/page1', 'Página 1'); // (la página de perfiles de esta pestaña queda reemplazada)
  await new Promise((r) => setTimeout(r, 300));

  await c.close();
  c = await launchCallisto([], dir);
  expect(await windowCount(c.app)).toBe(2);
  await expect((await uiOf('Personal')).locator('[data-testid="tab"][data-active="true"]')).toContainText('Página 1');
  await expect((await uiOf('Trabajo')).locator('[data-testid="tab"][data-active="true"]')).toContainText('Página 2');
});

test('eliminar un perfil cierra sus ventanas y sus archivos se borran al reiniciar', async () => {
  const trabajo = await createProfile('Trabajo');
  await visit(trabajo, '/datos/guardar?v=trabajo', 'Guardado');
  const registry = () => JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8')) as { profiles: Array<{ id: string; name: string }> };
  const id = registry().profiles.find((p) => p.name === 'Trabajo')!.id;
  expect(existsSync(join(dir, 'Profiles', id))).toBe(true);

  // La confirmación es un diálogo de Windows: se responde "Eliminar"
  await c.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  const personal = await uiOf('Personal');
  await typeAddress(personal, 'callisto://profiles');
  const page = await internalPage('profiles');
  await page.locator('[data-testid="profile-row"]', { hasText: 'Trabajo' }).getByTestId('profile-remove').click();
  await expectEventually(async () => (await windowCount(c.app)) === 1);
  await expect(page.getByTestId('profile-row')).toHaveCount(1);
  await expect(page.getByTestId('profile-remove')).toHaveCount(0); // el último perfil no se puede eliminar
  expect(registry().profiles.map((p) => p.name)).toEqual(['Personal']);

  await c.close();
  c = await launchCallisto([], dir);
  expect(existsSync(join(dir, 'Profiles', id))).toBe(false);
  expect(existsSync(join(dir, 'Partitions', `profile-${id}`))).toBe(false);
});

test('abrir un enlace en una ventana privada desde el menú contextual', async () => {
  await captureMenus(c.app);
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#to2', { button: 'right' });
  await clickMenuItem(c.app, 'Abrir enlace en una ventana privada');
  const priv = await uiOf('privada');
  await expect(priv.locator('[data-testid="tab"][data-active="true"]')).toContainText('Página 2');
});
