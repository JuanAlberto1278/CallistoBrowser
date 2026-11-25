import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, expectEventually, launchCallisto, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';

// 1.5 (bloque 3 de la 2.0): ajustes por sitio, bloqueador de ventanas emergentes y panel del sitio (el candado).

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server.close();
});
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-v15-'));
  c = await launchCallisto([], dir);
});
test.afterEach(async () => {
  await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');
const panel = () => c.ui.getByTestId('site-panel');

async function visit(path: string, title: string) {
  await typeAddress(c.ui, `${server.base}${path}`);
  await expect(activeTab()).toContainText(title);
}

/** La página web de la pestaña activa. */
async function activePage() {
  const url = await activeTabUrl(c.app);
  let page = webPages(c.app, (u) => u === url)[0];
  await expectEventually(() => !!(page = webPages(c.app, (u) => u === url)[0]));
  return page!;
}

async function openPanel() {
  await c.ui.getByTestId('security').click();
  await expect(panel()).toBeVisible();
}

const activeMuted = () =>
  c.app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]!;
    const views = win.contentView.children as Electron.WebContentsView[];
    const tab = views.find((v) => !v.webContents.getURL().startsWith('callisto://ui/') && v.getVisible());
    return tab!.webContents.isAudioMuted();
  });

test('ventanas emergentes: sin un clic se bloquean y el aviso permite abrirla o permitir el sitio', async () => {
  await visit('/site/popup-auto', 'Emergente sola');
  await expect(c.ui.getByTestId('notice')).toContainText('bloqueó una ventana emergente');
  await expect(tabs()).toHaveCount(1);

  // "Abrirla": esa vez, en una pestaña nueva
  await c.ui.getByTestId('notice-open-popup').click();
  await expect(tabs()).toHaveCount(2);
  await expect(c.ui.getByTestId('notice')).toBeHidden();
  await expect(tabs().nth(1)).toContainText('Página 2');

  // "Permitir siempre en este sitio": se abre y, de ahí en más, el sitio abre ventanas sin aviso
  await tabs().nth(0).click();
  await c.ui.getByTestId('reload').click();
  await expect(c.ui.getByTestId('notice')).toContainText('bloqueó una ventana emergente');
  await c.ui.getByTestId('notice-allow-popups').click();
  await expect(tabs()).toHaveCount(3);
  await tabs().nth(0).click();
  await c.ui.getByTestId('reload').click();
  await expect(tabs()).toHaveCount(4);
  await expect(c.ui.getByTestId('notice')).toBeHidden();

  // El panel del sitio lo muestra (y se puede volver al valor por defecto)
  await tabs().nth(0).click();
  await openPanel();
  await expect(c.ui.getByTestId('site-setting-popups')).toHaveValue('allow');
  await c.ui.getByTestId('site-setting-popups').selectOption('block');
  await c.ui.getByTestId('reload').click();
  await expect(c.ui.getByTestId('notice')).toContainText('bloqueó una ventana emergente');
  await expect(tabs()).toHaveCount(4);
});

test('ventanas emergentes: las que abre un clic del usuario pasan', async () => {
  await visit('/page1', 'Página 1');
  const page = await activePage();
  await page.click('#opentab');
  await expect(tabs()).toHaveCount(2);
  await expect(c.ui.getByTestId('notice')).toBeHidden();
});

test('panel del sitio: conexión, sonido, zoom y "no dormir"', async () => {
  await visit('/page1', 'Página 1');
  await openPanel();
  await expect(c.ui.getByTestId('site-host')).toHaveText(new URL(server.base).host);
  await expect(c.ui.getByTestId('site-connection')).toContainText('no es segura');
  // Los permisos que se preguntan empiezan en "Preguntar"; el contenido, en su valor por defecto
  await expect(c.ui.getByTestId('site-setting-camera')).toHaveValue('ask');
  await expect(c.ui.getByTestId('site-setting-sound')).toHaveValue('allow');
  await expect(c.ui.getByTestId('site-setting-popups')).toHaveValue('block');

  // Sonido: silencia la pestaña al instante, y otra página del mismo sitio también
  await c.ui.getByTestId('site-setting-sound').selectOption('block');
  await expectEventually(activeMuted);
  await c.ui.getByTestId('site-setting-camera').selectOption('block');
  await expect(c.ui.getByTestId('site-setting-camera')).toHaveValue('block');

  // Zoom
  await c.ui.getByTestId('site-zoom-in').click();
  await expect(c.ui.getByTestId('site-zoom')).toHaveText('110 %');
  await c.ui.getByTestId('site-zoom-reset').click();
  await expect(c.ui.getByTestId('site-zoom')).toHaveText('100 %');

  // No dormir nunca el sitio
  await c.ui.getByTestId('site-never-sleep').check();
  await expect(c.ui.getByTestId('site-never-sleep')).toBeChecked();

  // Esc cierra el panel; el ajuste del sonido sigue en otra página del sitio
  await c.ui.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await visit('/page2', 'Página 2');
  expect(await activeMuted()).toBe(true);
  await openPanel();
  await c.ui.getByTestId('site-setting-sound').selectOption('allow');
  await expectEventually(async () => !(await activeMuted()));

  // "Configuración de sitios": la sección, con lo que quedó guardado
  await c.ui.getByTestId('site-open-settings').click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === 'callisto://settings/#s-perms');
  const settings = webPages(c.app, (u) => u.startsWith('callisto://settings/'))[0]!;
  await expect(settings.getByTestId('settings-permissions')).toContainText('Cámara');
  await expect(settings.getByTestId('settings-permissions')).not.toContainText('Sonido');
  await expect(settings.getByTestId('never-sleep-site')).toContainText(new URL(server.base).hostname);
});

test('panel del sitio: JavaScript e imágenes bloqueados al recargar', async () => {
  await visit('/site/js', 'JS activo');
  await openPanel();
  await c.ui.getByTestId('site-setting-javascript').selectOption('block');
  await expect(c.ui.getByTestId('site-reload-hint')).toBeVisible();
  await c.ui.getByTestId('site-reload').click();
  await expect(activeTab()).toContainText('Prueba JS');

  await visit('/site/img', 'Prueba imagen');
  let page = await activePage();
  expect(await page.evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth)).toBe(1);
  await openPanel();
  await c.ui.getByTestId('site-setting-images').selectOption('block');
  await c.ui.getByTestId('site-reload').click();
  await expect(panel()).toBeVisible();
  page = await activePage();
  await page.waitForLoadState('load');
  expect(await page.evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth)).toBe(0);

  // Los iframes de otro sitio siguen el ajuste del sitio de la pestaña
  await visit('/site/frames', 'Con iframes');
  page = await activePage();
  const frameOf = (path: string) => page.frames().find((f) => f.url().endsWith(path))!;
  await expectEventually(() => !!frameOf('/site/js') && !!frameOf('/site/img'));
  await frameOf('/site/img').waitForLoadState('load');
  expect(await frameOf('/site/js').title()).toBe('Prueba JS');
  expect(await frameOf('/site/img').evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth)).toBe(0);

  // En la misma pestaña: otro sitio sin bloqueos funciona normal, y al volver se bloquea de nuevo
  const other = server.base.replace('127.0.0.1', 'localhost');
  await typeAddress(c.ui, `${other}/site/js`);
  await expect(activeTab()).toContainText('JS activo');
  await typeAddress(c.ui, `${server.base}/site/js?vuelta=1`);
  await expect(activeTab()).toContainText('Prueba JS');
  await typeAddress(c.ui, `${other}/site/img?otra=1`);
  await expect(activeTab()).toContainText('Prueba imagen');
  page = await activePage();
  await page.waitForLoadState('load');
  expect(await page.evaluate(() => (document.getElementById('i') as HTMLImageElement).naturalWidth)).toBe(1);

  // Volver al valor por defecto: JavaScript corre de nuevo
  await typeAddress(c.ui, `${server.base}/site/js?otra=2`);
  await expect(activeTab()).toContainText('Prueba JS');
  await openPanel();
  await c.ui.getByTestId('site-setting-javascript').selectOption('allow');
  await c.ui.getByTestId('site-reload').click();
  await expect(activeTab()).toContainText('JS activo');
});

test('panel del sitio: borrar los datos del sitio (cookies y almacenamiento)', async () => {
  await visit('/datos/guardar?v=hola', 'Guardado hola');
  await visit('/datos/leer', 'Lectura: cookie=hola almacenamiento=hola');
  await openPanel();
  await c.ui.getByTestId('site-clear').click();
  await c.ui.getByTestId('site-clear-confirm').click();
  await expect(c.ui.getByTestId('site-cleared')).toBeVisible();
  await c.ui.getByTestId('site-reload').click();
  await expect(activeTab()).toContainText('Lectura: cookie=ninguna almacenamiento=ninguno');
});

// ---------------------------------------------------------------- al abrir y al cerrar Callisto

async function openSettings() {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

async function restart() {
  await c.close();
  c = await launchCallisto([], dir);
}

test('al iniciar: abrir páginas específicas', async () => {
  await visit('/page1', 'Página 1');
  await c.ui.getByTestId('new-tab').click();
  await expect(tabs()).toHaveCount(2);
  const s = await openSettings();
  await s.getByTestId('settings-startup-pages').check();
  await expect(s.getByTestId('startup-pages')).toContainText('Todavía no hay páginas');
  // "Usar las páginas abiertas": las pestañas web de la ventana
  await s.getByTestId('startup-use-current').click();
  await expect(s.getByTestId('startup-page')).toHaveCount(1);
  await s.getByTestId('startup-page-input').fill('no es una dirección');
  await s.getByTestId('startup-page-add').click();
  await expect(s.getByRole('alert')).toContainText('Escribí una dirección');
  await s.getByTestId('startup-page-input').fill(`${new URL(server.base).host}/page2`);
  await s.getByTestId('startup-page-add').click();
  await expect(s.getByTestId('startup-page')).toHaveCount(2);
  await expect(s.getByTestId('startup-page').nth(1)).toContainText(`https://${new URL(server.base).host}/page2`);
  // La dirección sin esquema se completa con https; para la prueba (servidor http), se reemplaza por la http
  await s.getByTestId('startup-page-remove').nth(1).click();
  await s.getByTestId('startup-page-input').fill(`${server.base}/page2`);
  await s.getByTestId('startup-page-add').click();
  await expect(s.getByTestId('startup-page')).toHaveCount(2);

  await restart();
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(0)).toContainText('Página 1');
  await expect(tabs().nth(0)).toHaveAttribute('data-active', 'true');
  await expect(tabs().nth(1)).toContainText('Página 2');
});

test('al cerrar: borrar cookies, datos de sitios e historial (y nada si está apagado)', async () => {
  await visit('/datos/guardar?v=uno', 'Guardado uno');
  await restart();
  // Apagado (por defecto): los datos siguen
  await visit('/datos/leer', 'Lectura: cookie=uno almacenamiento=uno');

  const s = await openSettings();
  await expect(s.getByTestId('clear-on-exit-history')).not.toBeChecked();
  await expect(s.getByTestId('clear-on-exit-siteData')).not.toBeChecked();
  await expect(s.getByTestId('clear-on-exit-cache')).not.toBeChecked();
  await s.getByTestId('clear-on-exit-siteData').check();
  await s.getByTestId('clear-on-exit-history').check();
  await expect(s.getByTestId('clear-on-exit-history')).toBeChecked();
  await restart();
  await visit('/datos/leer', 'Lectura: cookie=ninguna almacenamiento=ninguno');
  // El historial empezó de cero: solo la visita de recién
  const h = await (async () => {
    await typeAddress(c.ui, 'callisto://history');
    await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://history')));
    return c.app.windows().find((w) => w.url().startsWith('callisto://history'))!;
  })();
  await expect(h.getByText('Guardado uno')).toHaveCount(0);
  await expect(h.getByText('Lectura: cookie=ninguna almacenamiento=ninguno').first()).toBeVisible();
});

test('al cerrar de golpe: se borra al volver a abrir', async () => {
  const s = await openSettings();
  await s.getByTestId('clear-on-exit-siteData').check();
  await expect(s.getByTestId('clear-on-exit-siteData')).toBeChecked();
  await visit('/datos/guardar?v=dos', 'Guardado dos');
  // Cierre de golpe: el proceso termina sin pasar por la salida normal
  await c.app.evaluate(async ({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) {
      await wc.session.cookies.flushStore();
      wc.session.flushStorageData();
    }
    setTimeout(() => process.exit(0), 300);
  });
  await c.app.waitForEvent('close').catch(() => undefined);
  c = await launchCallisto([], dir);
  await visit('/datos/leer', 'Lectura: cookie=ninguna almacenamiento=ninguno');
});

// ---------------------------------------------------------------- accesos directos de la nueva pestaña

test('nueva pestaña: accesos directos propios (agregar, renombrar, editar, quitar) y sugerencias', async () => {
  // Por defecto: solo los propios (ninguno todavía) y el botón para agregar
  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('new-tab-page')).toBeVisible();
  await expect(c.ui.getByTestId('ntp-shortcut')).toHaveCount(0);
  await expect(c.ui.getByTestId('ntp-tile')).toHaveCount(0);
  await expect(c.ui.getByTestId('ntp-show-top')).not.toBeChecked();

  // Agregar: dirección inválida, después una válida (sin nombre: queda el sitio)
  await c.ui.getByTestId('ntp-shortcut-add').click();
  await c.ui.getByTestId('ntp-editor-url').fill('no es una dirección');
  await c.ui.getByTestId('ntp-editor-save').click();
  await expect(c.ui.getByTestId('ntp-editor')).toContainText('Escribí una dirección');
  await c.ui.getByTestId('ntp-editor-url').fill(`${server.base}/page1`);
  await c.ui.getByTestId('ntp-editor-save').click();
  await expect(c.ui.getByTestId('ntp-editor')).toBeHidden();
  await expect(c.ui.getByTestId('ntp-shortcut')).toHaveCount(1);
  await expect(c.ui.getByTestId('ntp-shortcut')).toContainText(new URL(server.base).hostname);

  // Renombrar y cambiar la dirección
  await c.ui.getByTestId('ntp-shortcut').hover();
  await c.ui.getByTestId('ntp-shortcut-edit').click();
  await c.ui.getByTestId('ntp-editor-name').fill('Mi página');
  await c.ui.getByTestId('ntp-editor-url').fill(`${server.base}/page2`);
  await c.ui.getByTestId('ntp-editor-save').click();
  await expect(c.ui.getByTestId('ntp-shortcut').locator('.tile-title')).toHaveText('Mi página');
  await c.ui.getByTestId('ntp-shortcut').locator('.tile-link').click();
  await expect(activeTab()).toContainText('Página 2');

  // Sugerencias de los más visitados (otro sitio: localhost)
  const other = server.base.replace('127.0.0.1', 'localhost');
  await typeAddress(c.ui, `${other}/page1`);
  await expect(activeTab()).toContainText('Página 1');
  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('ntp-suggestion')).toHaveCount(1);
  await expect(c.ui.getByTestId('ntp-suggestion')).toContainText('localhost');
  await c.ui.getByTestId('ntp-suggestion').click();
  await expect(c.ui.getByTestId('ntp-shortcut')).toHaveCount(2);
  await expect(c.ui.getByTestId('ntp-suggestions')).toBeHidden();

  // "Mostrar también los más visitados": sin repetir lo que ya es acceso directo
  await c.ui.getByTestId('ntp-show-top').check();
  await expect(c.ui.getByTestId('ntp-empty')).toBeVisible();

  // Quitar; se recuerda al volver a abrir Callisto
  await c.ui.getByTestId('ntp-shortcut').first().hover();
  await c.ui.getByTestId('ntp-shortcut-edit').first().click();
  await c.ui.getByTestId('ntp-editor-remove').click();
  await expect(c.ui.getByTestId('ntp-shortcut')).toHaveCount(1);
  await restart();
  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('ntp-shortcut')).toHaveCount(1);
  await expect(c.ui.getByTestId('ntp-shortcut')).toContainText('localhost');
  await expect(c.ui.getByTestId('ntp-show-top')).toBeChecked();
});
