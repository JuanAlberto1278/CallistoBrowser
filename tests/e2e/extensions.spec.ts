import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMenus, clickMenuItem, expectEventually, lastMenuLabels, launchCallisto, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';
import { TestStore, type StoreExtension } from './test-store';
import { NOT_ON_WINDOWS_APIS, UNSUPPORTED_APIS } from '../../src/shared/extensions';

let server: TestServer;
let store: TestStore;
let c: Callisto;
let dir: string;

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
  dir = mkdtempSync(join(tmpdir(), 'callisto-ext-'));
  c = await launchCallisto([], dir, store.env);
  await captureMenus(c.app);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const PAGE = () => `${server.base}/page1`;
const extDir = (id: string) => join(dir, 'Profiles', 'default', 'Extensions', id);
const loaded = (id: string) => c.app.evaluate(({ session }, id) => !!session.fromPartition('persist:profile-default').extensions.getExtension(id), id);
const actionButtons = () => c.ui.locator('browser-action-list button');

/** Pestaña web cuya dirección empieza así (la más nueva). */
async function pageAt(prefix: string): Promise<Page> {
  let p: Page | undefined;
  await expectEventually(() => {
    p = c.app.windows().filter((w) => w.url().startsWith(prefix)).at(-1);
    return !!p;
  });
  await p!.waitForLoadState('domcontentloaded');
  return p!;
}

/**
 * Empieza la instalación como "Agregar a Chrome" en la tienda (desde la pestaña activa, que muestra /page1).
 * Devuelve (envuelta: una función async aplanaría la promesa y esperaría la respuesta) lo que recibiría la tienda
 * ('allow' o 'deny'), que se resuelve al contestar.
 */
async function requestInstall(ext: StoreExtension): Promise<{ answer: Promise<string> }> {
  await typeAddress(c.ui, PAGE());
  await expectEventually(async () => (await pageAt(PAGE())).title().then((t) => t === 'Página 1'));
  const wcId = await c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id, PAGE());
  const answer = c.app.evaluate((_e, a) => (globalThis as unknown as { __callistoTestStoreInstall: (p: string, id: string, wc: number) => Promise<string> }).__callistoTestStoreInstall('default', a.id, a.wcId), { id: ext.id, wcId });
  await expect(c.ui.getByTestId('extension-prompt')).toBeVisible();
  return { answer };
}

async function install(ext: StoreExtension): Promise<void> {
  const { answer } = await requestInstall(ext);
  await expect(c.ui.getByTestId('extension-prompt-add')).toBeEnabled();
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('allow');
  await expectEventually(() => loaded(ext.id));
}

/** Abre una página de la extensión en la pestaña activa (la barra de direcciones no navega a chrome-extension://). */
async function openExtensionPage(id: string, path: string): Promise<Page> {
  await c.app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!;
    void wc.loadURL(url);
  }, `chrome-extension://${id}/${path}`);
  return pageAt(`chrome-extension://${id}/${path}`);
}

test('instalar: confirmación con permisos; cancelar no instala; agregar instala, botón, popup y script de contenido', async () => {
  const ext = store.publish('action');
  // Cancelar
  const { answer: first } = await requestInstall(ext);
  await expect(c.ui.getByTestId('extension-prompt-title')).toHaveText('¿Agregar «Callisto: botón de prueba»?');
  await expect(c.ui.getByTestId('extension-prompt-warnings')).toContainText('Leer y cambiar tus datos en 127.0.0.1');
  await c.ui.getByTestId('extension-prompt-cancel').click();
  expect(await first).toBe('deny');
  await expect(c.ui.getByTestId('extension-prompt')).toBeHidden();
  expect(await loaded(ext.id)).toBe(false);
  expect(existsSync(extDir(ext.id))).toBe(false);

  // Agregar
  await install(ext);
  expect(readdirSync(extDir(ext.id))).toEqual([expect.stringMatching(/^1\.0_/)]);
  await expect(actionButtons()).toHaveCount(1);
  await expect(actionButtons().first()).toHaveAttribute('id', ext.id);

  // El script de contenido corre en las páginas de 127.0.0.1
  const tab = await pageAt(PAGE());
  await tab.reload();
  await expect.poll(() => tab.evaluate(() => document.documentElement.dataset.callistoExtension)).toBe('activa');

  // El popup del botón
  await actionButtons().first().click();
  const popup = await pageAt(`chrome-extension://${ext.id}/popup.html`);
  await expect(popup).toHaveTitle('Popup de prueba');

  // chrome.contextMenus: el ítem de la extensión en el menú de la página
  await tab.click('h1', { button: 'right' });
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Callisto: ítem de prueba'));
});

test('menú del botón, opciones, desactivar, activar y quitar (callisto://extensions)', async () => {
  const ext = store.publish('action');
  await install(ext);
  await expect(actionButtons()).toHaveCount(1);

  await actionButtons().first().click({ button: 'right' });
  await expectEventually(async () => (await lastMenuLabels(c.app)).join('|') === 'Callisto: botón de prueba|Opciones|Administrar extensiones|Quitar de Callisto…');
  await clickMenuItem(c.app, 'Opciones');
  await expect(await pageAt(`chrome-extension://${ext.id}/options.html`)).toHaveTitle('Opciones de prueba');

  await typeAddress(c.ui, 'callisto://extensions');
  const p = await pageAt('callisto://extensions');
  await expect(p.getByTestId('extension-name')).toHaveText(['Callisto: botón de prueba']);

  // Desactivar: deja de correr y desaparece el botón (pero queda instalada)
  await p.getByTestId('extension-toggle').uncheck();
  await expectEventually(async () => !(await loaded(ext.id)));
  await expect(actionButtons()).toHaveCount(0);
  await typeAddress(c.ui, PAGE());
  const tab = await pageAt(PAGE());
  await expect(tab).toHaveTitle('Página 1');
  expect(await tab.evaluate(() => document.documentElement.dataset.callistoExtension ?? 'no')).toBe('no');
  expect(existsSync(extDir(ext.id))).toBe(true);

  // Activar de nuevo, y quitar
  await typeAddress(c.ui, 'callisto://extensions');
  const p2 = await pageAt('callisto://extensions');
  await p2.getByTestId('extension-toggle').check();
  await expectEventually(() => loaded(ext.id));
  await p2.getByTestId('extension-remove').click();
  await p2.getByTestId('extension-remove-confirm').click();
  await expect(p2.getByTestId('extensions-empty')).toBeVisible();
  expect(await loaded(ext.id)).toBe(false);
  expect(existsSync(extDir(ext.id))).toBe(false);
});

test('actualizar desde la tienda; una firma que no es de la tienda no se instala', async () => {
  const ext = store.publish('action', { version: '1.0' });
  await install(ext);
  store.publish('action', { version: '1.1' });
  await typeAddress(c.ui, 'callisto://extensions');
  const p = await pageAt('callisto://extensions');
  await p.getByTestId('extensions-update').click();
  await expect(p.getByTestId('extensions-message')).toHaveText('Se actualizaron 1 extensiones.');
  await expect(p.getByTestId('extension-card')).toContainText('1.1');
  expect(readdirSync(extDir(ext.id))).toEqual([expect.stringMatching(/^1\.1_/)]); // la versión anterior se borró
  expect(await loaded(ext.id)).toBe(true);

  // Paquete firmado por otra "tienda": se rechaza y se avisa en la pestaña
  const forged = store.publish('apis', { forgedSignature: true });
  const { answer } = await requestInstall(forged);
  await expect(c.ui.getByTestId('extension-prompt-add')).toBeEnabled();
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('deny');
  await expect(c.ui.getByTestId('notice')).toContainText('El paquete no está firmado por la Chrome Web Store');
  expect(await loaded(forged.id)).toBe(false);
  expect(existsSync(extDir(forged.id)) ? readdirSync(extDir(forged.id)) : []).toEqual([]);
});

test('APIs de Callisto: browser = chrome, chrome.bookmarks sobre los favoritos y chrome.tabGroups sobre los grupos', async () => {
  const ext = store.publish('apis');
  await install(ext);
  const page = await openExtensionPage(ext.id, 'page.html');
  expect(await page.evaluate(() => (globalThis as unknown as { browser: unknown }).browser === chrome)).toBe(true);

  // Favoritos: el árbol de Callisto, y lo que crea la extensión aparece en la barra
  const roots = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children!.map((n) => [n.id, n.title]));
  expect(roots).toEqual([['1', 'Barra de favoritos'], ['2', 'Otros favoritos']]);
  const created = await page.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Desde la extensión', url: 'https://ejemplo.com/' }));
  await expect(c.ui.getByTestId('bookmarks-bar')).toContainText('Desde la extensión');
  await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Renombrado' }), created.id);
  await expect(c.ui.getByTestId('bookmarks-bar')).toContainText('Renombrado');
  expect(await page.evaluate(() => chrome.bookmarks.search('Renombrado').then((r) => r.map((n) => n.url)))).toEqual(['https://ejemplo.com/']);
  await page.evaluate((id) => chrome.bookmarks.remove(id), created.id);
  await expect(c.ui.getByTestId('bookmarks-bar')).not.toContainText('Renombrado');
  const events = await page.evaluate(() => (window as unknown as { events: unknown[][] }).events.map((e) => e[0]));
  expect(events).toEqual(expect.arrayContaining(['bookmarks.onCreated', 'bookmarks.onChanged', 'bookmarks.onRemoved']));

  // Grupos: chrome.tabs.group crea un grupo de Callisto; tabGroups.update le cambia nombre y color
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page2`);
  await pageAt(`${server.base}/page2`);
  const groupId = await page.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    return chrome.tabs.group({ tabIds: [t!.id!] });
  }, `${server.base}/page2`);
  await expect(c.ui.getByTestId('group-chip')).toHaveCount(1);
  await page.evaluate((id) => chrome.tabGroups.update(id, { title: 'De la extensión', color: 'red' }), groupId);
  await expect(c.ui.getByTestId('group-chip')).toHaveText('De la extensión');
  const groups = await page.evaluate(() => chrome.tabGroups.query({ title: 'De la extensión' }));
  expect(groups.map((g) => [g.id, g.color])).toEqual([[groupId, 'red']]);
  const tabGroupId = await page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.groupId, `${server.base}/page2`);
  expect(tabGroupId).toBe(groupId);
  await expect.poll(() => page.evaluate(() => (window as unknown as { events: unknown[][] }).events.map((e) => e[0]))).toEqual(expect.arrayContaining(['tabGroups.onCreated', 'tabGroups.onUpdated']));
  await page.evaluate(async (url) => chrome.tabs.ungroup((await chrome.tabs.query({ url }))[0]!.id!), `${server.base}/page2`);
  await expect(c.ui.getByTestId('group-chip')).toHaveCount(0);

  // Lo que pide una extensión con chrome.tabs sí actúa sobre las pestañas de Callisto (activar y cerrar)
  const tabCount = await c.ui.getByTestId('tab').count();
  await page.evaluate(async (url) => chrome.tabs.update((await chrome.tabs.query({ url }))[0]!.id!, { active: true }), `${server.base}/page2`);
  await expect(c.ui.locator('[data-testid="tab"][data-active="true"]')).toContainText('Página 2');
  await page.evaluate(async (url) => chrome.tabs.remove((await chrome.tabs.query({ url }))[0]!.id!), `${server.base}/page2`);
  await expect(c.ui.getByTestId('tab')).toHaveCount(tabCount - 1);
});

test('la compatibilidad medida coincide con la tabla de Callisto (extensión sonda con todos los permisos)', async () => {
  const ext = store.publish('probe');
  await install(ext);
  const page = await openExtensionPage(ext.id, 'probe.html');
  await expect.poll(() => page.title(), { timeout: 20_000 }).toMatch(/^\{"exists"/);
  const { exists, calls } = JSON.parse(await page.title()) as { exists: Record<string, boolean>; calls: Record<string, string> };
  expect(exists['browser===chrome']).toBe(true);
  expect(exists.bookmarks).toBe(true);
  expect(exists.tabGroups).toBe(true);
  // Todo lo que no existe figura como no disponible (o es de ChromeOS, que Chrome en Windows tampoco tiene), y viceversa
  // (userScripts existe solo con "Permitir scripts de usuario" activado para la extensión: ver v144.spec.ts)
  expect(exists.userScripts).toBe(false);
  const missing = Object.entries(exists).filter(([k, v]) => !v && k !== 'action' && k !== 'browser===chrome' && k !== 'userScripts').map(([k]) => k).sort();
  expect(missing).toEqual([...Object.keys(UNSUPPORTED_APIS), ...NOT_ON_WINDOWS_APIS].sort());
  // 1.4.3: un programa que no está instalado responde como en Chrome (antes la llamada se quedaba sin respuesta)
  expect(calls.nativeMessaging).toBe('Specified native messaging host not found.');
  const brokenCalls = ['nativeMessaging'];
  // 1.4.2: las que Callisto completó existen y responden
  for (const k of ['history', 'sessions', 'search', 'browsingData', 'identity', 'pageCapture', 'proxy', 'system.display', 'downloads', 'topSites']) expect(exists[k], k).toBe(true);
  for (const k of brokenCalls) expect(calls[k], k).not.toBe('ok');
  // Y lo que existe responde
  for (const [k, v] of Object.entries(calls)) if (!brokenCalls.includes(k)) expect(v, k).toBe('ok');
});

test('ventana privada: sin extensiones', async () => {
  const ext = store.publish('action');
  await install(ext);
  await expect(actionButtons()).toHaveCount(1);
  await pressKey(c.app, 'ui', 'N', ['control', 'shift']);
  let priv: Page | undefined;
  await expectEventually(async () => {
    for (const p of c.app.windows().filter((w) => w.url().startsWith('callisto://ui/index'))) {
      if ((await p.getByTestId('chrome').getAttribute('data-private')) === 'true') priv = p;
    }
    return !!priv;
  });
  await expect(priv!.locator('browser-action-list')).toHaveCount(0);
  await typeAddress(priv!, 'callisto://extensions');
  const page = await pageAt('callisto://extensions');
  await expect(page.getByTestId('extensions-private')).toBeVisible();
});
