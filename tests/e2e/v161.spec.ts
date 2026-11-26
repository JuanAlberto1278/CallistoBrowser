import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectEventually, launchCallisto, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';
import { TestStore, type StoreExtension } from './test-store';

// 1.6.1: las reglas de bloqueo (declarativeNetRequest) que el manifiesto marca activas se activan al instalar y al
// actualizar, como en Chrome (Electron se saltaba ese paso). Extensión de prueba: tests/fixtures/extensions/dnr.

let server: TestServer;
let store: TestStore;
let c: Callisto;
let dir: string;
let ext: StoreExtension;

test.beforeAll(async () => {
  server = await startServer();
  store = new TestStore();
  await store.start();
});
test.afterAll(async () => {
  await server.close();
  await store.close();
});
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-v161-'));
  c = await launchCallisto([], dir, store.env);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function install(e: StoreExtension) {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => c.app.windows().some((w) => w.url() === `${server.base}/page1`));
  const wcId = await c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id, `${server.base}/page1`);
  const answer = c.app.evaluate((_e, a) => (globalThis as unknown as { __callistoTestStoreInstall: (p: string, id: string, wc: number) => Promise<string> }).__callistoTestStoreInstall('default', a.id, a.wcId), { id: e.id, wcId });
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('allow');
}

/** La página de la extensión, en la pestaña activa. */
async function reportPage(): Promise<Page> {
  await c.app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => /^(http|chrome-extension)/.test(w.getURL()))!;
    void wc.loadURL(url);
  }, `chrome-extension://${ext.id}/report.html`);
  let p: Page | undefined;
  await expectEventually(() => !!(p = c.app.windows().find((w) => w.url() === `chrome-extension://${ext.id}/report.html`)));
  await p!.waitForFunction(() => !!(window as unknown as { reglas?: unknown }).reglas);
  return p!;
}
const enabled = (p: Page) => p.evaluate(() => (window as unknown as { reglas: { activas(): Promise<string[]> } }).reglas.activas());

/** ¿La navegación se bloqueó? (Chromium muestra su página de error: el título queda en la dirección) */
async function blocked(query: string): Promise<boolean> {
  const url = `${server.base}/page2?${query}`;
  await typeAddress(c.ui, url);
  let title = '';
  await expectEventually(async () => {
    title = await c.app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.getTitle() ?? '', url);
    return title === 'Página 2' || title.includes('page2');
  });
  return title !== 'Página 2';
}

test('reglas del manifiesto: activas al instalar, junto con las dinámicas y las de sesión', async () => {
  ext = store.publish('dnr', { version: '1.0' });
  await install(ext);
  const p = await reportPage();
  await expect.poll(() => enabled(p)).toEqual(['activas']);
  expect(await blocked('estatica=1')).toBe(true);
  expect(await blocked('apagada=1')).toBe(false);
  expect(await blocked('dinamica=1')).toBe(true);
  expect(await blocked('sesion=1')).toBe(true);
  expect(await blocked('ninguna=1')).toBe(false);
  // También los recursos de la página (una imagen)
  await typeAddress(c.ui, `${server.base}/site/img`);
  let img: Page | undefined;
  await expectEventually(() => !!(img = webPages(c.app, (u) => u.endsWith('/site/img'))[0]));
  await img!.waitForLoadState('load');
  expect(await img!.evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth)).toBe(0);
});

test('reglas del manifiesto: lo que la extensión cambia se respeta, y al actualizar vuelve a lo del manifiesto', async () => {
  ext = store.publish('dnr', { version: '1.0' });
  await install(ext);
  let p = await reportPage();
  await expect.poll(() => enabled(p)).toEqual(['activas']);
  // La extensión apaga sus reglas (como la configuración de un bloqueador): Callisto no las vuelve a prender
  expect(await p.evaluate(() => (window as unknown as { reglas: { apagar(id: string): Promise<string[]> } }).reglas.apagar('activas'))).toEqual([]);
  expect(await blocked('estatica=1')).toBe(false);

  // Una versión nueva desde la tienda: Chrome vuelve a los valores del manifiesto
  store.publish('dnr', { version: '1.1' });
  await typeAddress(c.ui, 'callisto://extensions');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://extensions')));
  const page = c.app.windows().find((w) => w.url().startsWith('callisto://extensions'))!;
  await page.getByTestId('extensions-update').click();
  await expect(page.getByTestId('extensions-message')).toHaveText('Se actualizaron 1 extensiones.');
  await typeAddress(c.ui, `${server.base}/page1?despues`);
  await expectEventually(() => c.app.windows().some((w) => w.url().endsWith('/page1?despues')));
  p = await reportPage();
  await expect.poll(() => enabled(p), { timeout: 15_000 }).toEqual(['activas']);
  expect(await blocked('estatica=1&v=2')).toBe(true);
});
