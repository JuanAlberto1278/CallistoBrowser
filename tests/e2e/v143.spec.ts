import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureMenus, clickMenuItem, expectEventually, launchCallisto, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';
import { TestStore, type StoreExtension } from './test-store';

// 1.4.3: panel lateral, reglas según el contenido de la página y programas instalados (tests/fixtures/extensions/tools).

let server: TestServer;
let store: TestStore;
let c: Callisto;
let dir: string;
let hostsDir: string;
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
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-v143-'));
  hostsDir = mkdtempSync(join(tmpdir(), 'callisto-hosts-'));
  ext = store.publish('tools');
});
test.afterEach(async () => {
  await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(hostsDir, { recursive: true, force: true });
});

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');
const actionButton = () => c.ui.locator('browser-action-list').locator('button');

async function start(env: Record<string, string> = {}) {
  c = await launchCallisto([], dir, { ...store.env, CALLISTO_TEST_NATIVE_HOSTS_DIR: hostsDir, ...env });
  await captureMenus(c.app);
}

async function install() {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expectEventually(() => c.app.windows().some((w) => w.url() === `${server.base}/page1`));
  const wcId = await c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.id, `${server.base}/page1`);
  const answer = c.app.evaluate((_e, a) => (globalThis as unknown as { __callistoTestStoreInstall: (p: string, id: string, wc: number) => Promise<string> }).__callistoTestStoreInstall('default', a.id, a.wcId), { id: ext.id, wcId });
  await c.ui.getByTestId('extension-prompt-add').click();
  expect(await answer).toBe('allow');
}

async function visit(path: string, title: string) {
  await typeAddress(c.ui, `${server.base}${path}`);
  await expect(activeTab()).toContainText(title);
}

/** La página de la extensión en el panel lateral, y el encabezado de Callisto. */
async function panelPages(): Promise<{ panel: Page; head: Page }> {
  let panel: Page | undefined;
  let head: Page | undefined;
  await expectEventually(() => {
    panel = c.app.windows().find((w) => w.url().startsWith(`chrome-extension://${ext.id}/panel.html`));
    head = c.app.windows().find((w) => w.url().includes('sidepanel.html'));
    return !!panel && !!head;
  });
  await panel!.waitForFunction(() => document.title === 'Panel listo');
  return { panel: panel!, head: head! };
}

const pageWidth = () =>
  c.app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]!;
    const views = win.contentView.children as Electron.WebContentsView[];
    return views.find((v) => v.webContents.getURL().endsWith('/page2'))!.getBounds().width;
  });
const windowWidth = () => c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getContentBounds().width);

test('reglas según el contenido: el botón se activa solo donde corresponde, también después de reiniciar', async () => {
  await start();
  await install();
  // /page1 tiene un campo #field (regla CSS): activo
  await expect(actionButton()).toHaveAttribute('aria-disabled', 'false');
  await visit('/page3', 'Página 3'); // ninguna regla
  await expect(actionButton()).toHaveAttribute('aria-disabled', 'true');
  await visit('/page2', 'Página 2'); // regla de dirección
  await expect(actionButton()).toHaveAttribute('aria-disabled', 'false');

  // Las reglas se recuerdan (Chrome las guarda): sin volver a instalar, siguen valiendo
  await c.close();
  await start();
  await expect(activeTab()).toContainText('Página 2');
  await expect(actionButton()).toHaveAttribute('aria-disabled', 'false');
  await visit('/page3', 'Página 3');
  await expect(actionButton()).toHaveAttribute('aria-disabled', 'true');
});

test('panel lateral: se abre desde el menú del botón, ocupa la derecha, cambia de ancho y se cierra', async () => {
  await start();
  await install();
  await visit('/page2', 'Página 2');
  const full = await windowWidth();
  expect(await pageWidth()).toBe(full);

  await actionButton().click({ button: 'right' });
  await clickMenuItem(c.app, 'Abrir el panel lateral');
  const { panel, head } = await panelPages();
  await expect(head.getByTestId('side-panel-name')).toHaveText('Callisto: herramientas de prueba');
  await expect.poll(pageWidth).toBe(full - 380);
  // La extensión se entera (sidePanel.onOpened) y ve sus opciones
  await expect.poll(() => panel.evaluate(() => (window as unknown as { tools: { events(): Promise<unknown[]> } }).tools.events())).toContainEqual(['sidePanel.onOpened', 'panel.html']);
  expect(await panel.evaluate(() => (window as unknown as { tools: { call(p: string, ...a: unknown[]): Promise<unknown> } }).tools.call('sidePanel.getOptions', {}))).toEqual({ enabled: true, path: 'panel.html' });

  // Arrastrar el borde hacia la izquierda lo agranda (y se recuerda)
  const edge = (await head.getByTestId('side-panel-edge').boundingBox())!;
  await head.mouse.move(edge.x + 2, edge.y + 200);
  await head.mouse.down();
  await head.mouse.move(edge.x - 100, edge.y + 200, { steps: 5 });
  await head.mouse.up();
  await expect.poll(pageWidth).toBeLessThan(full - 440);

  // Cerrar
  await head.getByTestId('side-panel-close').click();
  await expect.poll(pageWidth).toBe(full);
  await expectEventually(() => !c.app.windows().some((w) => w.url().includes('sidepanel.html')));

  // openPanelOnActionClick: el botón abre el panel (y lo cierra)
  await c.ui.getByTestId('new-tab').click();
  await visit('/page2', 'Página 2');
  await actionButton().click({ button: 'right' });
  await clickMenuItem(c.app, 'Abrir el panel lateral');
  const again = await panelPages();
  await again.panel.evaluate(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
  await again.head.getByTestId('side-panel-close').click();
  await expectEventually(() => !c.app.windows().some((w) => w.url().includes('sidepanel.html')));
  await actionButton().click();
  await panelPages();
  await actionButton().click();
  await expectEventually(() => !c.app.windows().some((w) => w.url().includes('sidepanel.html')));
  expect(await tabs().count()).toBe(2);
});

/** Registra el programa de prueba (una carpeta temporal en vez del registro de Windows). */
function registerHost(name: string, origins: string[]) {
  writeFileSync(
    join(hostsDir, `${name}.json`),
    JSON.stringify({ name, description: 'Programa de prueba de Callisto', path: resolve(__dirname, '../fixtures/native-host/host.bat'), type: 'stdio', allowed_origins: origins }),
  );
}

test('programas instalados: con permiso del usuario (una vez), mensajes en los dos sentidos', async () => {
  await start({ CALLISTO_TEST_NATIVE_ANSWER: 'allow' });
  await install();
  registerHost('com.callisto.prueba', [`chrome-extension://${ext.id}/`]);
  await visit('/page2', 'Página 2');
  await actionButton().click({ button: 'right' });
  await clickMenuItem(c.app, 'Abrir el panel lateral');
  const { panel } = await panelPages();
  const tools = <T = unknown>(fn: string, ...args: unknown[]) => panel.evaluate(({ fn, args }) => (window as unknown as { tools: Record<string, (...a: unknown[]) => Promise<unknown>> }).tools[fn]!(...args), { fn, args }) as Promise<T>;

  // Puerto: UTF-8 con acentos y emoji, y un mensaje de 300 KB (llega en varios pedazos)
  const got = await tools<unknown[]>('connect', 'com.callisto.prueba', 'ñandú 🌎');
  expect(got).toEqual([{ echo: 'ñandú 🌎', origin: `chrome-extension://${ext.id}/`, parent: '--parent-window' }, { bigLength: 300000 }]);
  // Un mensaje suelto
  expect(await tools('call', 'runtime.sendNativeMessage', 'com.callisto.prueba', { text: 'hola' })).toMatchObject({ echo: 'hola' });
  // Se preguntó una sola vez (Recordar)
  expect(await c.app.evaluate(() => (globalThis as unknown as { __callistoNativeAsked?: string[] }).__callistoNativeAsked)).toEqual([`${ext.id} com.callisto.prueba`]);

  // Lo que no está registrado, o no autoriza a esta extensión: el error de Chrome
  expect(await tools('call', 'runtime.sendNativeMessage', 'com.callisto.no.existe', {})).toBe('ERROR: Specified native messaging host not found.');
  registerHost('com.callisto.ajeno', ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);
  expect(await tools('call', 'runtime.sendNativeMessage', 'com.callisto.ajeno', {})).toBe('ERROR: Access to the specified native messaging host is forbidden.');
  expect(await tools('call', 'runtime.sendNativeMessage', 'NO VÁLIDO', {})).toBe('ERROR: Invalid native messaging host name specified.');
});

test('programas instalados: si el usuario no lo permite, no se abre', async () => {
  await start({ CALLISTO_TEST_NATIVE_ANSWER: 'deny' });
  await install();
  registerHost('com.callisto.prueba', [`chrome-extension://${ext.id}/`]);
  await visit('/page2', 'Página 2');
  await actionButton().click({ button: 'right' });
  await clickMenuItem(c.app, 'Abrir el panel lateral');
  const { panel } = await panelPages();
  const result = await panel.evaluate(() => (window as unknown as { tools: { call(p: string, ...a: unknown[]): Promise<unknown> } }).tools.call('runtime.sendNativeMessage', 'com.callisto.prueba', { text: 'hola' }));
  expect(result).toBe('ERROR: Access to the specified native messaging host is forbidden.');
  const port = await panel.evaluate(() => (window as unknown as { tools: { connect(n: string, t: string): Promise<unknown> } }).tools.connect('com.callisto.prueba', 'hola'));
  expect(port).toEqual(['desconectado: Access to the specified native messaging host is forbidden.']);
});
