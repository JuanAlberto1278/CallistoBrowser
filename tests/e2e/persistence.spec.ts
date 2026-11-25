import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, activeTabZoom, expectEventually, launchCallisto, pressKey, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let dir: string;
let c: Callisto;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'callisto-persist-')); });
test.afterEach(async () => {
  await c?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Arranca Callisto sobre la carpeta de datos de la prueba (que sobrevive a los reinicios). */
const start = async () => { c = await launchCallisto([], dir); return c; };
const restart = async () => { await c.close(); return start(); };

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');

async function internalPage(kind: 'history' | 'settings'): Promise<Page> {
  await expectEventually(() => c.app.windows().some((p) => p.url().startsWith(`callisto://${kind}`)));
  const p = c.app.windows().find((w) => w.url().startsWith(`callisto://${kind}`))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

async function visit(url: string, title: string) {
  await typeAddress(c.ui, url);
  await expectEventually(async () => (await activeTabUrl(c.app)) === url);
  await expect(activeTab()).toContainText(title);
}

// ---------------------------------------------------------------- historial

test('historial: Ctrl+H lo abre, registra visitas, busca, borra una y borra todo', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await visit(`${server.base}/page2`, 'Página 2');
  await visit(`${server.base}/find`, 'Buscar');

  await pressKey(c.app, 'tab', 'H', ['control']);
  const h = await internalPage('history');
  await expect(activeTab()).toContainText('Historial');
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'internal');
  await expect(h.getByTestId('history-item')).toHaveCount(3);
  await expect(h.getByTestId('history-title').first()).toHaveText('Buscar'); // la más reciente primero

  await h.getByTestId('history-search').fill('Página');
  await expect(h.getByTestId('history-item')).toHaveCount(2);
  await h.getByTestId('history-search').fill('');
  await expect(h.getByTestId('history-item')).toHaveCount(3);

  await h.getByTestId('history-item').first().hover();
  await h.getByTestId('history-delete').first().click();
  await expect(h.getByTestId('history-item')).toHaveCount(2);

  await h.getByTestId('history-clear-open').click();
  await h.getByTestId('history-clear-period').selectOption('all');
  await h.getByTestId('history-clear-confirm').click();
  await expect(h.getByTestId('history-empty')).toBeVisible();
});

test('historial: no registra páginas que fallaron ni repite al recargar o ir atrás', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await pressKey(c.app, 'tab', 'F5');
  await c.tab.click('#to2');
  await expect(activeTab()).toContainText('Página 2');
  await c.ui.getByTestId('back').click();
  await expect(activeTab()).toContainText('Página 1');
  await typeAddress(c.ui, 'http://127.0.0.1:1/'); // puerto bloqueado: página de error
  await expect(activeTab()).toContainText('Puerto bloqueado');

  await pressKey(c.app, 'ui', 'H', ['control']);
  const h = await internalPage('history');
  await expect(h.getByTestId('history-title')).toHaveText(['Página 2', 'Página 1']);
});

test('historial: abrir una entrada vuelve a una pestaña web', async () => {
  await start();
  await visit(`${server.base}/page2`, 'Página 2');
  await typeAddress(c.ui, 'callisto://history');
  const h = await internalPage('history');
  await h.getByTestId('history-item').first().click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page2`);
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'insecure');
  await expect(tabs()).toHaveCount(1);
});

// ---------------------------------------------------------------- sugerencias

test('sugerencias: historial, búsqueda y autocompletado del nombre del sitio', async () => {
  await start();
  const local = server.base.replace('127.0.0.1', 'localhost');
  await visit(`${local}/page1`, 'Página 1');

  const address = c.ui.getByTestId('address');
  await address.click();
  await address.pressSequentially('local');
  // "local" + "host" autocompletado y seleccionado
  await expect(address).toHaveValue('localhost');
  expect(await address.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 9]);
  await address.press('Backspace'); // borra el autocompletado
  await expect(address).toHaveValue('local');
  await address.pressSequentially('h');
  await expect(address).toHaveValue('localhost');
  await address.press('Enter');
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${local}/`);

  await address.click();
  await address.fill('');
  await address.pressSequentially('Página 1');
  const items = c.ui.getByTestId('suggestion');
  await expect(items.first()).toHaveAttribute('data-kind', 'search');
  await expect(items.first()).toContainText('Buscar en Google');
  await expect(c.ui.locator('[data-testid="suggestion"][data-kind="history"]')).toContainText(['Página 1']);
  await address.press('ArrowDown');
  await address.press('Enter');
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${local}/page1`);

  await address.click();
  await address.pressSequentially('algo');
  await expect(c.ui.getByTestId('suggestions')).toBeVisible();
  await address.press('Escape');
  await expect(c.ui.getByTestId('suggestions')).toBeHidden();
});

// ---------------------------------------------------------------- sesión

test('al reiniciar vuelven las ventanas y pestañas, con su historial, y las cerradas', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await c.tab.click('#to2');
  await expect(activeTab()).toContainText('Página 2');
  await c.ui.getByTestId('new-tab').click();
  await visit(`${server.base}/page3`, 'Página 3');
  await c.ui.getByTestId('new-tab').click();
  await visit(`${server.base}/find`, 'Buscar');
  await pressKey(c.app, 'ui', 'W', ['control']); // cerrada: debe poder reabrirse después del reinicio
  await expect(tabs()).toHaveCount(2);
  await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 90, width: 1000, height: 700 }));
  await tabs().nth(1).click();

  await restart();
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(0)).toContainText('Página 2'); // sin cargar todavía, pero con su título
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(tabs().nth(1)).toContainText('Página 3');
  expect(webPages(c.app, (u) => u.endsWith('/page2'))).toHaveLength(0); // la de fondo no se cargó
  const bounds = await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getBounds());
  expect(bounds).toMatchObject({ x: 120, y: 90, width: 1000, height: 700 });

  await tabs().nth(0).click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page2`);
  await expect(c.ui.getByTestId('back')).toBeEnabled();
  await c.ui.getByTestId('back').click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);

  await pressKey(c.app, 'ui', 'T', ['control', 'shift']);
  await expect(tabs()).toHaveCount(3);
  await expect(activeTab()).toContainText('Buscar');
});

test('con "Abrir una pestaña nueva" al iniciar, no se restaura la sesión', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, 'callisto://settings');
  const s = await internalPage('settings');
  await s.getByTestId('settings-startup-newtab').check();
  await expect(s.getByTestId('settings-startup-newtab')).toBeChecked();

  await restart();
  await expect(tabs()).toHaveCount(1);
  await expect(activeTab()).toContainText('Nueva pestaña');
});

test('el zoom de cada sitio se recuerda después de reiniciar', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await pressKey(c.app, 'tab', '=', ['control']);
  await expect(c.ui.getByTestId('zoom')).toHaveText('110 %');
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, 'about:blank');

  await restart();
  await tabs().nth(0).click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);
  await expect(c.ui.getByTestId('zoom')).toHaveText('110 %');
  expect(await activeTabZoom(c.app)).toBeCloseTo(1.1);
});

// ---------------------------------------------------------------- permisos

const askNotifications = (p: Page) => p.evaluate(() => Notification.requestPermission());

test('permisos: se pregunta; Bloquear con "Recordar" ya no vuelve a preguntar (ni tras reiniciar)', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  const media = c.tab.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => 'concedido', (e) => e.name));
  const bar = c.ui.getByTestId('permission');
  await expect(bar).toBeVisible();
  await expect(c.ui.getByTestId('permission-text')).toHaveText(/127\.0\.0\.1:\d+ quiere usar tu cámara y tu micrófono/);
  await expect(c.ui.getByTestId('permission-remember')).toBeChecked();
  await c.ui.getByTestId('permission-block').click();
  expect(await media).toBe('NotAllowedError');
  await expect(bar).toBeHidden();

  await restart();
  await visit(`${server.base}/page1`, 'Página 1');
  // La pestaña restaurada puede seguir terminando su propia carga de /page1 mientras se vuelve a visitar: si la página
  // cambia en medio de la consulta, se repite (en 1.3 y 1.4 falló así, de vez en cuando)
  let result = '';
  await expectEventually(async () => {
    result = await c.tab.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(() => 'concedido', (e) => e.name)).catch(() => '');
    return result !== '';
  });
  expect(result).toBe('NotAllowedError');
  await expect(c.ui.getByTestId('permission')).toBeHidden();
});

test('permisos: Permitir con "Recordar" queda concedido; sin recordar, vuelve a preguntar', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  let answer = askNotifications(c.tab);
  await expect(c.ui.getByTestId('permission-text')).toContainText('quiere mostrarte notificaciones');
  await c.ui.getByTestId('permission-remember').uncheck();
  await c.ui.getByTestId('permission-allow').click();
  expect(await answer).toBe('granted');

  answer = askNotifications(c.tab); // no se recordó: pregunta otra vez
  await expect(c.ui.getByTestId('permission')).toBeVisible();
  await c.ui.getByTestId('permission-allow').click();
  expect(await answer).toBe('granted');
  expect(await c.tab.evaluate(() => Notification.permission)).toBe('granted');
  expect(await askNotifications(c.tab)).toBe('granted'); // recordado: sin preguntar
  await expect(c.ui.getByTestId('permission')).toBeHidden();
});

test('permisos: el pedido es de cada pestaña y se descarta al irse del sitio', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  const answer = askNotifications(c.tab);
  await expect(c.ui.getByTestId('permission')).toBeVisible();
  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('permission')).toBeHidden();
  await tabs().nth(0).click();
  await expect(c.ui.getByTestId('permission')).toBeVisible();
  await typeAddress(c.ui, `${server.base.replace('127.0.0.1', 'localhost')}/page2`);
  await expect(c.ui.getByTestId('permission')).toBeHidden();
  await answer.catch(() => 'denied'); // la página que pidió ya no está
});

test('configuración: lista y quita permisos guardados', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  const answer = askNotifications(c.tab);
  await c.ui.getByTestId('permission-block').click();
  expect(await answer).toBe('denied');

  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, 'callisto://settings');
  const s = await internalPage('settings');
  await expect(s.getByTestId('settings-permissions')).toContainText('Notificaciones');
  await expect(s.getByTestId('settings-permissions')).toContainText('Bloqueado');
  await s.getByRole('button', { name: 'Quitar' }).click();
  await expect(s.getByTestId('settings-no-permissions')).toBeVisible();

  await tabs().nth(0).click();
  const again = askNotifications(c.tab);
  await expect(c.ui.getByTestId('permission')).toBeVisible(); // vuelve a preguntar
  await c.ui.getByTestId('permission-block').click();
  await again;
});

// ---------------------------------------------------------------- configuración

test('configuración: el buscador elegido se usa en la barra y se recuerda', async () => {
  await start();
  await typeAddress(c.ui, 'callisto://settings');
  const s = await internalPage('settings');
  await s.getByTestId('settings-engine').selectOption('duckduckgo');
  await expect(c.ui.getByTestId('address')).toHaveAttribute('placeholder', /DuckDuckGo/);
  await typeAddress(c.ui, 'about:blank'); // la pestaña vuelve a ser web (es la que se restaura)
  await expect(c.ui.getByTestId('security')).toHaveAttribute('data-level', 'none');

  await restart();
  await expect(c.ui.getByTestId('address')).toHaveAttribute('placeholder', /DuckDuckGo/);
  const request = c.tab.waitForRequest(/^https:\/\/duckduckgo\.com\/\?q=hola\+callisto$/);
  await typeAddress(c.ui, 'hola callisto');
  await request;
  await typeAddress(c.ui, 'about:blank'); // no depender de lo que muestre el buscador real
});

// ---------------------------------------------------------------- seguridad de las páginas internas

test('las páginas web no pueden abrir ni usar las páginas internas', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  expect(await c.tab.evaluate(() => typeof (window as unknown as { callistoInternal?: unknown }).callistoInternal)).toBe('undefined');
  expect(await c.tab.evaluate(() => fetch('callisto://history/').then(() => 'accesible', () => 'bloqueado'))).toBe('bloqueado');
  await c.tab.evaluate(() => { location.href = 'callisto://history/'; });
  await new Promise((r) => setTimeout(r, 800));
  expect(c.app.windows().some((p) => p.url().startsWith('callisto://history'))).toBe(false);
  expect(await activeTabUrl(c.app)).toBe(`${server.base}/page1`);
});

test('cada página interna solo puede usar su parte de la API', async () => {
  await start();
  await typeAddress(c.ui, 'callisto://settings');
  const s = await internalPage('settings');
  const r = await s.evaluate(() => window.callistoInternal.history.query({}).then(() => 'permitido', () => 'rechazado'));
  expect(r).toBe('rechazado');
  expect(await s.evaluate(() => window.callistoInternal.settings.get().then((x) => typeof x.settings.searchEngine))).toBe('string');
});

test('si la base de datos está dañada, Callisto arranca igual, avisa y guarda la copia', async () => {
  const profileDir = join(dir, 'Profiles', 'default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'callisto.db'), Buffer.alloc(8192, 0x5a));
  await start();
  await expect(c.ui.getByTestId('notice')).toContainText('estaban dañados');
  expect(readdirSync(profileDir).some((f) => f.startsWith('callisto.db.danada-'))).toBe(true);
  expect(existsSync(join(profileDir, 'callisto.db'))).toBe(true);
  await visit(`${server.base}/page1`, 'Página 1'); // y funciona normalmente
});

test('cerrar Callisto con un sitio que usa service workers no produce errores', async () => {
  // Regresión: los service workers consultan permisos durante el cierre; con la base ya cerrada aparecía
  // "A JavaScript error occurred in the main process: database is not open".
  await start();
  const proc = c.app.process();
  const output: string[] = [];
  proc.stdout?.on('data', (d) => output.push(String(d)));
  await c.app.evaluate(() => process.on('uncaughtException', (e) => console.log('EXCEPCION:', e.message)));
  await visit(`${server.base.replace('127.0.0.1', 'localhost')}/sw-page`, 'Con service worker');
  await new Promise((r) => setTimeout(r, 1000));
  const exited = new Promise((r) => proc.once('exit', r));
  await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close());
  await exited;
  expect(output.join('')).not.toContain('EXCEPCION');
});

test('sugerencias: pasar el mouse por una sugerencia no cambia adónde lleva Enter', async () => {
  await start();
  await visit(`${server.base}/page1`, 'Página 1');
  await visit(`${server.base}/page2`, 'Página 2');
  const address = c.ui.getByTestId('address');
  await address.click();
  await address.fill('');
  await address.pressSequentially(`${server.base}/page`); // coincide con las páginas 1 y 2 del historial
  const history = c.ui.locator('[data-testid="suggestion"][data-kind="history"]').first();
  await expect(history).toBeVisible();
  await history.hover(); // el mouse queda sobre otra sugerencia
  await expect(address).toHaveValue(`${server.base}/page`); // el texto no cambia
  await address.press('Enter');
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page`);
});
