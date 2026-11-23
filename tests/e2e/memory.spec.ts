import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMenus, clickMenuItem, expectEventually, lastMenuLabels, launchCallisto, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
/** Cantidad de procesos de pestañas web (renderizadores con una página de 127.0.0.1). */
const livePages = (path: string) => webPages(c.app, (u) => u.startsWith(`${server.base}${path}`)).length;

async function twoTabs() {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#to2'); // historial: página 1 -> página 2
  await expect(c.tab).toHaveTitle('Página 2');
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page3`);
  await expectEventually(() => livePages('/page3') === 1);
}

test('dormir una pestaña desde su menú: libera la página, queda atenuada y vuelve con su historial', async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-mem-'));
  c = await launchCallisto([], dir);
  await captureMenus(c.app);
  await twoTabs();
  expect(livePages('/page2')).toBe(1);

  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Dormir la pestaña (liberar memoria)');
  await expect(tabs().nth(0)).toHaveAttribute('data-asleep', 'true');
  await expect(tabs().nth(0)).toContainText('Página 2'); // conserva el título
  await expectEventually(() => livePages('/page2') === 0); // sin proceso
  // La activa no se puede dormir
  await tabs().nth(1).click({ button: 'right' });
  await expectEventually(async () => !(await lastMenuLabels(c.app)).includes('Dormir la pestaña (liberar memoria)'));

  // Al tocarla se despierta, en la misma página y con su historial
  await tabs().nth(0).click();
  await expect(tabs().nth(0)).toHaveAttribute('data-asleep', 'false');
  await expectEventually(() => livePages('/page2') === 1);
  await expect(c.ui.getByTestId('back')).toBeEnabled();
  await c.ui.getByTestId('back').click();
  await expectEventually(() => livePages('/page1') === 1);
});

test('dormir sola después del tiempo configurado; nunca la que tiene texto escrito', async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-mem-'));
  // Un "minuto" de 300 ms: 5 minutos sin usarla = 1,5 s
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '300' });
  await captureMenus(c.app);
  await typeAddress(c.ui, 'callisto://settings');
  const settings = await (async () => {
    await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
    return c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  })();
  await settings.getByTestId('settings-sleep').selectOption('5');
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => livePages('/page1') === 1);
  const page1 = webPages(c.app, (u) => u.startsWith(`${server.base}/page1`))[0]!;
  await page1.click('#field');
  await page1.keyboard.press('End');
  await page1.keyboard.type(' y algo más'); // texto sin guardar
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page3`);
  await expectEventually(() => livePages('/page3') === 1);
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/find`);
  await expectEventually(() => livePages('/find') === 1);

  // La de /page3 (sin texto) se duerme sola; la de /page1 (con texto escrito) no; la activa tampoco
  await expect(tabs().nth(1)).toHaveAttribute('data-asleep', 'true', { timeout: 15_000 });
  expect(livePages('/page3')).toBe(0);
  await expect(tabs().nth(0)).toHaveAttribute('data-asleep', 'false');
  await expect(tabs().nth(2)).toHaveAttribute('data-asleep', 'false');
  expect(await page1.inputValue('#field')).toBe('texto de prueba y algo más');
});

test('el service worker de un sitio sin pestañas despiertas se detiene (libera su proceso)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-mem-'));
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '300' });
  await captureMenus(c.app);
  const other = server.base.replace('127.0.0.1', 'localhost'); // otro sitio
  const running = () => c.app.evaluate(({ session }) => Object.values(session.fromPartition('persist:profile-default').serviceWorkers.getAllRunning()).map((w) => w.scope));
  await typeAddress(c.ui, `${other}/sw-page`);
  await expectEventually(async () => (await running()).some((s) => s.startsWith(other)));
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => livePages('/page1') === 1);
  // Con su pestaña despierta (aunque no sea la activa) sigue corriendo
  await new Promise((r) => setTimeout(r, 1500));
  expect((await running()).some((s) => s.startsWith(other))).toBe(true);
  // Dormida la pestaña del sitio: se detiene
  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Dormir la pestaña (liberar memoria)');
  await expectEventually(async () => !(await running()).some((s) => s.startsWith(other)), 15_000);
  // Detenerlo no borra nada: al despertar la pestaña, el sitio carga y sigue registrado
  await tabs().nth(0).click();
  await expectEventually(() => webPages(c.app, (u) => u.startsWith(`${other}/sw-page`)).length === 1);
  const page = webPages(c.app, (u) => u.startsWith(`${other}/sw-page`))[0]!;
  await expect(page).toHaveTitle('Con service worker');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
});
