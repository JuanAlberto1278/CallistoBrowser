import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closedPort, expectEventually, launchCallisto, online, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => { c = await launchCallisto(); });
test.afterEach(async () => { await c.close(); });

const windowTitle = () => c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getTitle());

/**
 * Vuelve a una página local después de verificar una búsqueda real: tras muchas búsquedas automatizadas, Google
 * responde con su página anti-robots, que hace lento el cierre de Playwright. (Callisto sale rápido igual: verificado.)
 */
const leaveSearchEngine = () => typeAddress(c.ui, 'about:blank');

test('arranca con la barra de direcciones vacía y enfocada', async () => {
  const address = c.ui.getByTestId('address');
  await expect(address).toHaveValue('');
  await expect(address).toBeFocused();
  await expect(c.ui.getByTestId('back')).toBeDisabled();
  await expect(c.ui.getByTestId('forward')).toBeDisabled();
  expect(await windowTitle()).toBe('Nueva pestaña — Callisto');
});

test('navega escribiendo una URL y muestra estado HTTP "No seguro"', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await expect(c.ui.getByTestId('address')).toHaveValue(`${server.base}/page1`);
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'insecure');
  await expect(c.ui.getByTestId('security')).toContainText('No seguro');
  await expectEventually(async () => (await windowTitle()) === 'Página 1 — Callisto');
});

test('atrás y adelante (botones y Alt+flechas)', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#to2');
  await expect(c.tab).toHaveTitle('Página 2');
  await expect(c.ui.getByTestId('back')).toBeEnabled();

  await c.ui.getByTestId('back').click();
  await expect(c.tab).toHaveTitle('Página 1');
  await expect(c.ui.getByTestId('forward')).toBeEnabled();
  await c.ui.getByTestId('forward').click();
  await expect(c.tab).toHaveTitle('Página 2');

  await pressKey(c.app, 'tab', 'Left', ['alt']);
  await expect(c.tab).toHaveTitle('Página 1');
  await pressKey(c.app, 'tab', 'Right', ['alt']);
  await expect(c.tab).toHaveTitle('Página 2');
});

test('recargar (botón y F5)', async () => {
  await typeAddress(c.ui, `${server.base}/count`);
  await expect(c.tab).toHaveTitle(/Carga \d+/);
  const n = Number((await c.tab.title()).split(' ')[1]);
  await c.ui.getByTestId('reload').click();
  await expect(c.tab).toHaveTitle(`Carga ${n + 1}`);
  await pressKey(c.app, 'tab', 'F5');
  await expect(c.tab).toHaveTitle(`Carga ${n + 2}`);
  await pressKey(c.app, 'tab', 'R', ['control']);
  await expect(c.tab).toHaveTitle(`Carga ${n + 3}`);
});

test('indicador de carga y detener (botón y Esc)', async () => {
  await typeAddress(c.ui, `${server.base}/slow`);
  await expect(c.ui.getByTestId('loading')).toHaveAttribute('data-loading', 'true');
  await expect(c.ui.getByTestId('stop')).toBeVisible();
  await c.ui.getByTestId('stop').click();
  await expect(c.ui.getByTestId('loading')).toHaveAttribute('data-loading', 'false');
  await expect(c.ui.getByTestId('reload')).toBeVisible();
  server.releaseSlow();

  await typeAddress(c.ui, `${server.base}/slow?2`);
  await expect(c.ui.getByTestId('stop')).toBeVisible();
  await pressKey(c.app, 'tab', 'Escape');
  await expect(c.ui.getByTestId('loading')).toHaveAttribute('data-loading', 'false');
  server.releaseSlow();
});

test('texto que no es una dirección se busca en Google', async () => {
  // Se verifica la petición que envía Callisto (Google puede redirigir pruebas automáticas a su página anti-bots)
  const request = c.tab.waitForRequest(/^https:\/\/www\.google\.com\/search\?q=hola\+callisto$/);
  await typeAddress(c.ui, 'hola callisto');
  await request;
  await leaveSearchEngine();
});

test('página de error propia cuando falla la conexión', async () => {
  const url = `http://127.0.0.1:${await closedPort()}/`;
  await typeAddress(c.ui, url);
  await expect(c.tab.locator('h1')).toHaveText('Conexión rechazada');
  await expect(c.tab.locator('#callisto-retry')).toBeVisible();
  await expect(c.ui.getByTestId('address')).toHaveValue(url);
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'error');
  await expectEventually(async () => (await windowTitle()) === 'Conexión rechazada — Callisto');
});

test('puertos peligrosos bloqueados por Chromium muestran su propio mensaje', async () => {
  await typeAddress(c.ui, 'http://127.0.0.1:1/');
  await expect(c.tab.locator('h1')).toHaveText('Puerto bloqueado');
});

test('Ctrl+L, Alt+D y F6 enfocan la barra de direcciones desde la página', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  const address = c.ui.getByTestId('address');
  for (const [key, mods] of [['L', ['control']], ['D', ['alt']], ['F6', []]] as const) {
    await address.evaluate((el) => (el as HTMLInputElement).blur());
    await expect(address).not.toBeFocused();
    await pressKey(c.app, 'tab', key, [...mods]);
    await expect(address).toBeFocused();
  }
});

test('las descargas se bloquean, se avisa y no se guarda nada', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#download');
  const notice = c.ui.getByTestId('notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('callisto-prueba.bin');
  await expect(notice).toContainText('no se guardó nada');
  await new Promise((r) => setTimeout(r, 500));
  expect(readdirSync(join(c.userData, 'Quarantine'))).toEqual([]);
  await c.ui.getByTestId('notice-close').click();
  await expect(notice).toBeHidden();
});

test('user-agent honesto: Callisto, sin Electron', async () => {
  await typeAddress(c.ui, `${server.base}/echo-headers`);
  await expect(c.tab.locator('body')).toContainText('user-agent');
  const headers = JSON.parse(await c.tab.evaluate(() => document.body.innerText));
  expect(headers['user-agent']).toMatch(/ Callisto\/\d+\.\d+\.\d+ Chrome\/\d+/);
  expect(headers['user-agent']).not.toContain('Electron');
  expect(await c.tab.evaluate(() => navigator.userAgent)).toBe(headers['user-agent']);
});

test('corrección de passkeys: no se anuncia autocompletado', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  expect(await c.tab.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable())).toBe(false);
});

test('las páginas web no pueden llegar a la interfaz ni a su API', async () => {
  expect(await c.tab.evaluate(() => typeof (window as unknown as { callisto?: unknown }).callisto)).toBe('undefined');
  const r = await c.tab.evaluate(() => fetch('callisto://ui/index.html').then(() => 'accesible', () => 'bloqueado'));
  expect(r).toBe('bloqueado');
  await typeAddress(c.ui, 'callisto://ui/index.html');
  // No es un esquema navegable: se trata como búsqueda, nunca carga la interfaz dentro de la pestaña
  await expect(c.ui.getByTestId('address')).toHaveValue(/google\.com\/search/);
  await leaveSearchEngine();
});

test('HTTPS real muestra conexión segura', async () => {
  test.skip(!(await online()), 'sin conexión a Internet');
  await typeAddress(c.ui, 'example.com');
  await expect(c.ui.getByTestId('address')).toHaveValue('https://example.com/');
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'secure');
});

test('certificado inválido: se bloquea sin opción de continuar', async () => {
  test.skip(!(await online()), 'sin conexión a Internet');
  await typeAddress(c.ui, 'https://expired.badssl.com/');
  await expect(c.tab.locator('h1')).toHaveText('La conexión no es privada', { timeout: 20_000 });
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'error');
});
