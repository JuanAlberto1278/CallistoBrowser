import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, captureMenus, clickMenuItem, closedPort, expectEventually, lastMenuLabels, launchCallisto, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';
import { TestStore, type StoreExtension } from './test-store';

// 1.4.2: APIs de extensiones que faltaban o existían sin funcionar, probadas con una extensión que las usa de verdad
// (tests/fixtures/extensions/audit).

let server: TestServer;
let store: TestStore;
let c: Callisto;
let dir: string;
let ext: StoreExtension;
let page: Page;

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
  dir = mkdtempSync(join(tmpdir(), 'callisto-v142-'));
  c = await launchCallisto([], dir, store.env);
  await captureMenus(c.app);
  ext = store.publish('audit');
  // Instalar como desde la tienda (con la confirmación)
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => c.app.windows().some((w) => w.url() === `${server.base}/page1`));
  const wcId = await c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id, `${server.base}/page1`);
  const answer = c.app.evaluate((_e, a) => (globalThis as unknown as { __callistoTestStoreInstall: (p: string, id: string, wc: number) => Promise<string> }).__callistoTestStoreInstall('default', a.id, a.wcId), { id: ext.id, wcId });
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('allow');
  // La página de la extensión, en una pestaña propia
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page2`);
  await expectEventually(() =>
    c.app.evaluate(({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/page2'));
      if (wc) void wc.loadURL(url);
      return !!wc;
    }, `chrome-extension://${ext.id}/audit.html`),
  );
  await expectEventually(() => !!c.app.windows().find((w) => w.url().startsWith(`chrome-extension://${ext.id}/audit.html`)));
  page = c.app.windows().find((w) => w.url().startsWith(`chrome-extension://${ext.id}/audit.html`))!;
  await page.waitForFunction(() => document.title === 'listo');
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
const audit = <T = unknown>(name: string, ...args: unknown[]) => page.evaluate(({ name, args }) => (window as unknown as { audit: Record<string, (...a: unknown[]) => unknown> }).audit[name]!(...args), { name, args }) as Promise<T>;
const api = <T = unknown>(path: string, ...args: unknown[]) => audit<T>('call', path, ...args);
const events = () => audit<unknown[][]>('events');
const P1 = () => `${server.base}/page1`;

test('ciclo de vida, atajos, palabra clave en la barra y menú del botón', async () => {
  // runtime.onInstalled al instalar
  await expect.poll(events).toContainEqual(['runtime.onInstalled', 'install']);

  // chrome.commands: el atajo del manifiesto queda asignado y llega a la extensión
  expect(await api('commands.getAll')).toEqual([{ name: 'hacer-algo', description: 'Hacer algo', shortcut: 'Ctrl+Shift+Y' }]);
  await pressKey(c.app, 'tab', 'Y', ['control', 'shift']);
  await expect.poll(events).toContainEqual(['commands.onCommand', 'hacer-algo']);

  // chrome.omnibox: "aud texto" muestra las sugerencias de la extensión y Enter se lo pasa (sin navegar)
  const before = await activeTabUrl(c.app);
  const address = c.ui.getByTestId('address');
  await address.click();
  await address.fill('aud hola mundo');
  const items = c.ui.locator('[data-testid="suggestion"][data-kind="extension"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText('Sugerencia de la extensión');
  await address.press('Enter');
  await expect.poll(events).toContainEqual(['omnibox.onInputEntered', 'hola mundo', 'currentTab']);
  expect(await activeTabUrl(c.app)).toBe(before);

  // Menú del botón: los ítems de la extensión (contexts: "action"), también después de contextMenus.update
  const button = c.ui.locator('browser-action-list');
  await button.click({ button: 'right' });
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Ítem del botón'));
  expect(await audit('updateMenu')).toBe('ok');
  await button.click({ button: 'right' });
  await clickMenuItem(c.app, 'Ítem renombrado');
  await expect.poll(events).toContainEqual(['contextMenus.onClicked', 'en-boton']);
});

test('pestañas: captura, mover, duplicar, dormir, resaltar e idioma; sitios más visitados', async () => {
  // La página de la extensión es la activa: la pestaña 1 (/page1) queda detrás
  expect(await api<string>('tabs.captureVisibleTab')).toMatch(/^data:image\/jpeg;base64,/);
  expect(await api<string>('tabs.captureVisibleTab', { format: 'png' })).toMatch(/^data:image\/png;base64,/);
  const [p1] = await api<Array<{ id: number; index: number }>>('tabs.query', { url: P1() });
  expect(p1!.index).toBe(0); // la posición real (antes la librería decía -1)
  await api('tabs.move', p1!.id, { index: 1 });
  await expect(tabs().nth(1)).toContainText('Página 1');
  const dup = await api<{ url: string }>('tabs.duplicate', p1!.id);
  expect(dup.url).toBe(P1());
  await expect(tabs()).toHaveCount(3);
  expect(await api('tabs.detectLanguage', p1!.id)).toBe('es');
  const discarded = await api<{ discarded: boolean }>('tabs.discard', p1!.id);
  expect(discarded.discarded).toBe(true);
  await expect(c.ui.locator('[data-testid="tab"][data-asleep="true"]')).toHaveCount(1);
  const w = await api<{ id: number }>('windows.getCurrent');
  await api('tabs.highlight', { windowId: w.id, tabs: 2 });
  await expect(tabs().nth(2)).toHaveAttribute('data-active', 'true');

  // chrome.topSites: los sitios de la página nueva de Callisto
  expect(await api<Array<{ url: string }>>('topSites.get')).toContainEqual(expect.objectContaining({ url: `${server.base}/` }));
});

test('historial, cerradas recientemente, búsqueda, borrar datos y pantallas', async () => {
  // chrome.history sobre el historial de Callisto (y onVisited al visitar)
  const found = await api<Array<{ url: string; title: string }>>('history.search', { text: 'Página 1' });
  expect(found.map((h) => h.url)).toContain(P1());
  await api('history.addUrl', { url: `${server.base}/page3`, title: 'Página 3' });
  await expect.poll(events).toContainEqual(['history.onVisited', `${server.base}/page3`]);
  expect((await api<unknown[]>('history.getVisits', { url: P1() })).length).toBe(1);
  await api('history.deleteUrl', { url: P1() });
  expect((await api<Array<{ url: string }>>('history.search', { text: '' })).map((h) => h.url)).not.toContain(P1());

  // chrome.sessions: lo que se cerró, y restaurarlo
  await tabs().nth(0).hover();
  await tabs().nth(0).getByTestId('tab-close').click();
  await expect(tabs()).toHaveCount(1);
  const closed = await api<Array<{ tab?: { sessionId: string; url: string; title: string } }>>('sessions.getRecentlyClosed');
  expect(closed[0]!.tab).toMatchObject({ url: P1(), title: 'Página 1' });
  await api('sessions.restore', closed[0]!.tab!.sessionId);
  await expect(tabs()).toHaveCount(2);

  // chrome.search: con el buscador elegido (sin salir a Internet: se corta la carga y se mira adónde iba)
  await c.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __searched: string[] };
    g.__searched = [];
    session.fromPartition('persist:profile-default').webRequest.onBeforeRequest({ urls: ['https://www.google.com/*'] }, (d, cb) => {
      g.__searched.push(d.url);
      cb({ cancel: true });
    });
  });
  await api('search.query', { text: 'callisto navegador', disposition: 'NEW_TAB' });
  await expectEventually(async () => (await c.app.evaluate(() => (globalThis as unknown as { __searched: string[] }).__searched)).some((u) => u.startsWith('https://www.google.com/search?q=callisto+navegador')));

  // chrome.browsingData: el historial sí; cookies de un período no (Electron solo las borra enteras); contraseñas nunca
  await api('browsingData.removeHistory', { since: 0 });
  expect(await api('history.search', { text: '', startTime: 0 })).toEqual([]);
  expect(await api('browsingData.removeCookies', { since: Date.now() - 3600_000 })).toMatch(/^ERROR: Callisto solo puede borrar cookies/);
  expect(await api('browsingData.removePasswords', { since: 0 })).toMatch(/^ERROR: Callisto no permite/);
  await api('cookies.set', { url: P1(), name: 'galleta', value: '1' });
  await api('browsingData.removeCookies', { since: 0 });
  expect(await api('cookies.getAll', { url: P1() })).toEqual([]);

  // chrome.system.display
  const displays = await api<Array<{ isPrimary: boolean; bounds: { width: number } }>>('system.display.getInfo');
  expect(displays.some((d) => d.isPrimary && d.bounds.width > 0)).toBe(true);
});

test('descargas (pasan por la autorización de Callisto), iniciar sesión, MHTML y proxy', async () => {
  // chrome.downloads.download: Callisto pregunta, diciendo qué extensión la pidió; al guardar, la extensión recibe el id
  const id = audit<number>('download', `${server.base}/download`);
  await expect(c.ui.getByTestId('download-prompt')).toContainText('la extensión «Callisto: auditoría de APIs»');
  await expect(c.ui.getByTestId('download-save')).toBeEnabled({ timeout: 5000 });
  await c.ui.getByTestId('download-save').click();
  const downloadId = await id;
  expect(typeof downloadId).toBe('number');
  await expect.poll(async () => (await api<Array<{ state: string }>>('downloads.search', { id: downloadId }))[0]?.state, { timeout: 15_000 }).toBe('complete');
  await expect.poll(events).toContainEqual(['downloads.onCreated', downloadId]);
  // Rechazada: la extensión recibe el error
  const denied = audit<string>('download', `${server.base}/download?otra`);
  await c.ui.getByTestId('download-deny').click();
  expect(await denied).toMatch(/^ERROR: Download canceled by the user/);

  // chrome.identity.launchWebAuthFlow: termina al volver a https://<id>.chromiumapp.org/
  const redirect = `https://${ext.id}.chromiumapp.org/cb?code=123`;
  expect(await api('identity.getRedirectURL', 'cb')).toBe(`https://${ext.id}.chromiumapp.org/cb`);
  expect(await api('identity.launchWebAuthFlow', { url: `${server.base}/redirect-to?to=${encodeURIComponent(redirect)}`, interactive: true })).toBe(redirect);
  expect(await api('identity.getAuthToken', { interactive: false })).toMatch(/^ERROR: The user is not signed in/);

  // chrome.pageCapture: la página como MHTML
  expect(await audit('mhtml', P1())).toEqual([expect.any(Number), true]);

  // chrome.proxy: cambia el proxy del perfil, y "clear" lo devuelve al del sistema
  const port = await closedPort();
  await api('proxy.settings.set', { value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port } } } });
  expect(await api('proxy.settings.get', {})).toMatchObject({ levelOfControl: 'controlled_by_this_extension' });
  const resolve = () => c.app.evaluate(({ session }) => session.fromPartition('persist:profile-default').resolveProxy('http://example.com/'));
  expect(await resolve()).toBe(`PROXY 127.0.0.1:${port}`);
  await api('proxy.settings.clear', {});
  expect(await resolve()).not.toContain(`127.0.0.1:${port}`);
});
