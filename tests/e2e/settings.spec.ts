import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectEventually, launchCallisto, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-conf-'));
  c = await launchCallisto([], dir);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function settingsPage(): Promise<Page> {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

/** Lo que ve el sitio de prueba (cookie y localStorage), en la pestaña activa. */
async function readSiteData(): Promise<string> {
  await typeAddress(c.ui, `${server.base}/datos/leer`);
  let title = '';
  await expectEventually(async () => {
    const p = c.app.windows().filter((w) => w.url().startsWith(`${server.base}/datos/leer`)).at(-1);
    title = p ? await p.title() : '';
    return title.startsWith('Lectura:');
  });
  return title;
}

test('borrar datos de navegación: solo lo elegido (cookies y datos de sitios, historial)', async () => {
  await typeAddress(c.ui, `${server.base}/datos/guardar?v=uno`);
  await expectEventually(async () => (await readSiteData()) === 'Lectura: cookie=uno almacenamiento=uno');

  // Solo la caché: los datos de los sitios siguen
  let p = await settingsPage();
  await p.getByTestId('clear-history').uncheck();
  await p.getByTestId('clear-siteData').uncheck();
  await p.getByTestId('clear-cache').check();
  await p.getByTestId('clear-run').click();
  await expect(p.getByTestId('clear-status')).toHaveText('Listo: se borraron los datos elegidos.');
  expect(await readSiteData()).toBe('Lectura: cookie=uno almacenamiento=uno');

  // Cookies y datos de sitios + historial (todo)
  p = await settingsPage();
  await p.getByTestId('clear-siteData').check();
  await p.getByTestId('clear-history').check();
  await p.getByTestId('clear-period').selectOption('all');
  await p.getByTestId('clear-run').click();
  await expect(p.getByTestId('clear-status')).toHaveText('Listo: se borraron los datos elegidos.');
  expect(await readSiteData()).toBe('Lectura: cookie=ninguna almacenamiento=ninguno');
  await typeAddress(c.ui, 'callisto://history');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://history')));
  const h = c.app.windows().find((w) => w.url().startsWith('callisto://history'))!;
  await h.waitForLoadState('domcontentloaded');
  // Solo queda lo visitado después de borrar (la lectura de datos), no lo de antes (guardar)
  await expect(h.getByTestId('history-title').first()).toBeVisible();
  expect(await h.getByTestId('history-title').allTextContents()).not.toContain('Guardado uno');
});

test('acerca de Callisto: la versión', async () => {
  const version = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string;
  const p = await settingsPage();
  await expect(p.getByTestId('settings-version')).toHaveText(`Callisto ${version}`);
});

test('navegador predeterminado: muestra el estado (en desarrollo, sin instalar)', async () => {
  const p = await settingsPage();
  await expect(p.getByTestId('default-browser-status')).not.toHaveText('');
  await expect(p.getByTestId('default-browser-status')).toContainText('Callisto');
});

test('abrir un archivo .html pasado por Windows (línea de comandos)', async () => {
  await c.close();
  const file = join(dir, 'documento de prueba.html');
  writeFileSync(file, '<!doctype html><title>Documento local</title><h1>Hola</h1>');
  c = await launchCallisto([file], dir);
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('file:') && w.url().endsWith('documento%20de%20prueba.html')));
  const page = c.app.windows().find((w) => w.url().startsWith('file:'))!;
  await expect(page).toHaveTitle('Documento local');
});
