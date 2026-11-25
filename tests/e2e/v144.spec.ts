import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectEventually, launchCallisto, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';
import { TestStore, type StoreExtension } from './test-store';

// 1.4.4: scripts de usuario (chrome.userScripts, lo que usan Tampermonkey y Violentmonkey), con
// tests/fixtures/extensions/userscripts.

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
  dir = mkdtempSync(join(tmpdir(), 'callisto-v144-'));
  c = await launchCallisto([], dir, store.env);
  ext = store.publish('userscripts');
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => c.app.windows().some((w) => w.url() === `${server.base}/page1`));
  const wcId = await c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id, `${server.base}/page1`);
  const answer = c.app.evaluate((_e, a) => (globalThis as unknown as { __callistoTestStoreInstall: (p: string, id: string, wc: number) => Promise<string> }).__callistoTestStoreInstall('default', a.id, a.wcId), { id: ext.id, wcId });
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('allow');
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function extensionsPage(): Promise<Page> {
  await typeAddress(c.ui, 'callisto://extensions');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://extensions')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://extensions'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

/** Una página de la extensión (en una pestaña nueva), para usar su API. */
async function extensionPage(): Promise<Page> {
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page2`);
  await expectEventually(() =>
    c.app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/page2'));
      if (wc) void wc.loadURL(url);
      return !!wc;
    }, `chrome-extension://${ext.id}/page.html`),
  );
  // La más nueva (puede haber otra de antes, abierta en otra pestaña)
  const before = c.app.windows().filter((w) => w.url().startsWith(`chrome-extension://${ext.id}/page.html`)).length;
  let p: Page | undefined;
  await expectEventually(() => {
    const all = c.app.windows().filter((w) => w.url().startsWith(`chrome-extension://${ext.id}/page.html`));
    p = all.length > before ? all.at(-1) : undefined;
    return !!p;
  });
  await p!.waitForFunction(() => document.title === 'listo');
  return p!;
}

async function visitPage(path: string): Promise<Page> {
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}${path}`);
  // (cada visita con su propia dirección: si ya hubiera una pestaña con la misma, Enter iría a esa — 1.3)
  await expectEventually(() => webPages(c.app, (u) => u.endsWith(path)).length > 0);
  const p = webPages(c.app, (u) => u.endsWith(path)).at(-1)!;
  await p.waitForLoadState('load');
  return p;
}

const toggle = (p: Page) => p.getByTestId('extension-user-scripts-toggle');

test('sin "Permitir scripts de usuario" no hay API ni scripts; al permitirlo, la extensión se recarga y los registra', async () => {
  // Apagado al instalar: la tarjeta lo ofrece, la API no está y nada corre en las páginas
  let page = await extensionsPage();
  await expect(page.getByTestId('extension-user-scripts')).toContainText('Permitir scripts de usuario');
  await expect(toggle(page)).not.toBeChecked();
  const extPage = await extensionPage();
  expect(await extPage.evaluate(() => (window as unknown as { us: { available(): string } }).us.available())).toBe('undefined');
  const before = await visitPage('/us-page?v=1');
  expect(await before.evaluate(() => (window as unknown as { __seenByPage: string }).__seenByPage)).toBe('undefined');

  // Permitido
  page = await extensionsPage();
  await toggle(page).check();
  await expect(toggle(page)).toBeChecked();
  const extPage2 = await extensionPage();
  expect(await extPage2.evaluate(() => (window as unknown as { us: { available(): string } }).us.available())).toBe('object');
  await expect
    .poll(async () => ((await extPage2.evaluate(() => (window as unknown as { us: { call(p: string): Promise<Array<{ id: string }>> } }).us.call('userScripts.getScripts'))) as Array<{ id: string }>).map((s) => s.id))
    .toEqual(['main-start', 'iso-end', 'frames']);

  // document_start en el mundo de la página: la página ya lo ve en su primer script
  const p = await visitPage('/us-page?v=2');
  expect(await p.evaluate(() => (window as unknown as { __seenByPage: string }).__seenByPage)).toBe('start');
  // document_end en el mundo USER_SCRIPT: aislado (no ve las variables de la página) y con mensajería y puertos
  await expect.poll(() => p.evaluate(() => document.documentElement.dataset.usIso)).toBe('undefined');
  await expect.poll(() => p.evaluate(() => document.documentElement.dataset.usReply)).toBe('eco /us-page con pestaña');
  await expect.poll(() => p.evaluate(() => document.documentElement.dataset.usPort)).toBe('ping-pong canal');

  // Apagado otra vez: ya no corren
  page = await extensionsPage();
  await toggle(page).uncheck();
  const after = await visitPage('/us-page?v=3');
  expect(await after.evaluate(() => (window as unknown as { __seenByPage: string }).__seenByPage)).toBe('undefined');
});

test('iframes (allFrames), excludeMatches, archivos de la extensión y execute(); se recuerdan al reiniciar', async () => {
  const page = await extensionsPage();
  await toggle(page).check();
  await expect(toggle(page)).toBeChecked();
  let extPage = await extensionPage();
  await expect.poll(async () => ((await extPage.evaluate(() => (window as unknown as { us: { call(p: string): Promise<unknown[]> } }).us.call('userScripts.getScripts'))) as unknown[]).length).toBe(3);

  // allFrames + archivo de la extensión: en la página y en su iframe; excludeMatches: el iframe (/page3) no tiene el de USER_SCRIPT
  const p = await visitPage('/us-frames');
  await expect.poll(() => p.evaluate(() => (window as unknown as { __usFrame?: string }).__usFrame)).toBe('arriba');
  const frame = p.frames().find((f) => f.url().endsWith('/page3'))!;
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __usFrame?: string }).__usFrame)).toBe('iframe');
  expect(await frame.evaluate(() => document.documentElement.dataset.usIso)).toBeUndefined();
  await expect.poll(() => p.evaluate(() => document.documentElement.dataset.usIso)).toBe('undefined');

  // execute(): ahora, en la pestaña (devuelve el resultado de cada frame)
  const tabId = await extPage.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, `${server.base}/us-frames`);
  const result = await extPage.evaluate((id) => (window as unknown as { us: { call(p: string, ...a: unknown[]): Promise<unknown> } }).us.call('userScripts.execute', { target: { tabId: id }, js: [{ code: 'document.title + " " + (6 * 7)' }], world: 'MAIN' }), tabId);
  expect(result).toEqual([{ frameId: 0, result: 'Con iframe 42' }]);

  // Errores como en Chrome
  expect(await extPage.evaluate(() => (window as unknown as { us: { call(p: string, ...a: unknown[]): Promise<unknown> } }).us.call('userScripts.register', [{ id: 'main-start', matches: ['<all_urls>'], js: [{ code: '1' }] }]))).toBe("ERROR: Duplicate script ID 'main-start'");
  expect(await extPage.evaluate(() => (window as unknown as { us: { call(p: string, ...a: unknown[]): Promise<unknown> } }).us.call('userScripts.register', [{ id: '_privado', matches: ['<all_urls>'], js: [{ code: '1' }] }]))).toBe('ERROR: Invalid script id.');

  // Al reiniciar: el permiso y los scripts siguen (Chrome los guarda)
  await c.close();
  c = await launchCallisto([], dir, store.env);
  const again = await visitPage('/us-page?v=4');
  expect(await again.evaluate(() => (window as unknown as { __seenByPage: string }).__seenByPage)).toBe('start');
  extPage = await extensionPage();
  expect(await extPage.evaluate(() => (window as unknown as { us: { available(): string } }).us.available())).toBe('object');
});
