import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeTabUrl,
  captureMenus,
  clickMenuItem,
  expectEventually,
  launchCallisto,
  pressKey,
  startServer,
  typeAddress,
  webPages,
  windowCount,
  type Callisto,
  type TestServer,
} from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'callisto-v13-')); });
test.afterEach(async () => {
  await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');
const address = () => c.ui.getByTestId('address');
const suggestions = () => c.ui.getByTestId('suggestion');

async function openTabWith(path: string, title: string): Promise<void> {
  const before = await tabs().count();
  await c.ui.getByTestId('new-tab').click();
  await expect(tabs()).toHaveCount(before + 1);
  await typeAddress(c.ui, `${server.base}${path}`);
  await expect(activeTab()).toContainText(title);
}

async function settingsPage() {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

// ---------------------------------------------------------------- pestañas fijadas

test('fijar una pestaña: va a la izquierda, solo con el ícono, y sigue fijada al reiniciar', async () => {
  c = await launchCallisto([], dir);
  await captureMenus(c.app);
  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith('/page2', 'Página 2');
  await openTabWith('/page3', 'Página 3');

  await tabs().nth(2).click({ button: 'right' });
  await clickMenuItem(c.app, 'Fijar');
  await expect(tabs().nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(0).getByTestId('tab-title')).toBeHidden(); // solo el ícono
  await expect(tabs().nth(0).getByTestId('tab-close')).toBeHidden();
  const box = (await tabs().nth(0).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(44);

  // La segunda fijada va después de la primera
  await tabs().nth(2).click({ button: 'right' });
  await clickMenuItem(c.app, 'Fijar');
  await expect(tabs().nth(1)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(2)).toHaveAttribute('data-pinned', 'false');

  await c.close();
  c = await launchCallisto([], dir);
  await expect(tabs()).toHaveCount(3);
  await expect(tabs().nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(1)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(2)).toHaveAttribute('data-pinned', 'false');
  await expect(tabs().nth(2)).toContainText('Página 1');

  // Desfijar: queda primera después de las fijadas
  await captureMenus(c.app);
  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Desfijar');
  await expect(tabs().nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(1)).toHaveAttribute('data-pinned', 'false');
  await expect(tabs().nth(1).getByTestId('tab-title')).toBeVisible();
});

test('una pestaña fijada no se duerme sola', async () => {
  // Un "minuto" de 300 ms: 5 minutos sin usarla = 1,5 s
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '300' });
  await captureMenus(c.app);
  const settings = await settingsPage();
  await settings.getByTestId('settings-sleep').selectOption('5');
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(activeTab()).toContainText('Página 1');
  await openTabWith('/page3', 'Página 3');
  await openTabWith('/find', 'Buscar');
  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Fijar');

  await expect(tabs().nth(1)).toHaveAttribute('data-asleep', 'true', { timeout: 15_000 }); // la de /page3
  await new Promise((r) => setTimeout(r, 2000));
  await expect(tabs().nth(0)).toHaveAttribute('data-pinned', 'true');
  await expect(tabs().nth(0)).toHaveAttribute('data-asleep', 'false');
  expect(webPages(c.app, (u) => u.endsWith('/page1'))).toHaveLength(1);
});

// ---------------------------------------------------------------- sonido

test('sonido: la pestaña muestra el parlante; un clic la silencia y otro le devuelve el sonido', async () => {
  c = await launchCallisto([], dir);
  await captureMenus(c.app);
  await typeAddress(c.ui, `${server.base}/sound`);
  const audio = activeTab().getByTestId('tab-audio');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('data-muted', 'false');
  const muted = () => c.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.isAudioMuted(), `${server.base}/sound`);

  await audio.click();
  await expect(audio).toHaveAttribute('data-muted', 'true');
  expect(await muted()).toBe(true);
  await audio.click();
  await expect(audio).toHaveAttribute('data-muted', 'false');
  expect(await muted()).toBe(false);

  // También desde el menú de la pestaña (y una silenciada muestra el ícono aunque no suene)
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(activeTab()).toContainText('Página 1');
  await expect(activeTab().getByTestId('tab-audio')).toHaveCount(0);
  await activeTab().click({ button: 'right' });
  await clickMenuItem(c.app, 'Silenciar la pestaña');
  await expect(activeTab().getByTestId('tab-audio')).toHaveAttribute('data-muted', 'true');
});

// ---------------------------------------------------------------- cerrar una ventana con varias pestañas

test('cerrar una ventana con 2 pestañas o más pregunta; Cancelar la deja abierta; se puede desactivar', async () => {
  c = await launchCallisto([], dir, { CALLISTO_TEST_CLOSE_ANSWER: 'cancel' });
  const asked = () => c.app.evaluate(() => (globalThis as unknown as { __callistoCloseAsked?: number }).__callistoCloseAsked ?? 0);
  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith('/page3', 'Página 3');

  await pressKey(c.app, 'ui', 'W', ['control', 'shift']);
  await expectEventually(async () => (await asked()) === 1);
  await new Promise((r) => setTimeout(r, 300));
  expect(await windowCount(c.app)).toBe(1);
  await expect(tabs()).toHaveCount(2);

  // Una ventana con una sola pestaña se cierra sin preguntar
  await pressKey(c.app, 'ui', 'N', ['control']);
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  await expectEventually(() => c.app.windows().filter((p) => p.url().startsWith('callisto://ui/')).length === 2);
  await pressKey(c.app, 'ui', 'W', ['control', 'shift'], 'newest');
  await expectEventually(async () => (await windowCount(c.app)) === 1);
  expect(await asked()).toBe(1);

  // Desactivado en la configuración: ya no pregunta
  const settings = await settingsPage();
  await expect(settings.getByTestId('settings-confirm-close')).toBeChecked();
  await settings.getByTestId('settings-confirm-close').uncheck();
  await pressKey(c.app, 'ui', 'N', ['control']);
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  await expectEventually(() => c.app.windows().filter((p) => p.url().startsWith('callisto://ui/')).length === 2);
  await pressKey(c.app, 'ui', 'T', ['control'], 'newest');
  await expectEventually(() => c.app.evaluate(({ BaseWindow }) => {
    const all = BaseWindow.getAllWindows();
    const newest = all.reduce((a, b) => (b.id > a.id ? b : a));
    return newest.contentView.children.length >= 3; // interfaz + 2 pestañas
  }));
  await pressKey(c.app, 'ui', 'W', ['control', 'shift'], 'newest');
  await expectEventually(async () => (await windowCount(c.app)) === 1);
  expect(await asked()).toBe(1);
});

// ---------------------------------------------------------------- cerradas recientemente

/** Etiquetas del submenú "Cerradas recientemente" del último menú ⋯ capturado. */
const recentLabels = () =>
  c.app.evaluate(() => {
    const g = globalThis as unknown as { __menus: Electron.Menu[] };
    const m = g.__menus[g.__menus.length - 1]!;
    return m.items.find((i) => i.label === 'Cerradas recientemente')!.submenu!.items.map((i) => i.label);
  });

test('cerradas recientemente: el menú ⋯ las lista y reabre la elegida', async () => {
  c = await launchCallisto([], dir);
  await captureMenus(c.app);
  await c.ui.getByTestId('app-menu').click();
  await expectEventually(async () => (await recentLabels().catch(() => [])).length > 0);
  expect(await recentLabels()).toEqual(['(vacío)']);
  await c.ui.keyboard.press('Escape');

  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith('/page2', 'Página 2');
  await openTabWith('/page3', 'Página 3');
  await pressKey(c.app, 'ui', 'W', ['control']); // cierra Página 3
  await expect(tabs()).toHaveCount(2);
  await tabs().nth(1).click();
  await pressKey(c.app, 'ui', 'W', ['control']); // cierra Página 2
  await expect(tabs()).toHaveCount(1);

  await c.ui.getByTestId('app-menu').click();
  await expectEventually(async () => (await recentLabels()).length === 2);
  expect(await recentLabels()).toEqual(['Página 2', 'Página 3']); // la más reciente primero
  await c.app.evaluate(() => {
    const g = globalThis as unknown as { __menus: Electron.Menu[] };
    const m = g.__menus[g.__menus.length - 1]!;
    const item = m.items.find((i) => i.label === 'Cerradas recientemente')!.submenu!.items[1]!;
    (item.click as unknown as () => void)();
  });
  await expect(tabs()).toHaveCount(2);
  await expect(activeTab()).toContainText('Página 3');

  await c.ui.getByTestId('app-menu').click();
  await expectEventually(async () => JSON.stringify(await recentLabels()) === JSON.stringify(['Página 2']));
});

// ---------------------------------------------------------------- búsqueda unificada

test('barra de direcciones: sugiere pestañas abiertas y favoritos; Enter va a la pestaña ya abierta', async () => {
  c = await launchCallisto([], dir);
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(activeTab()).toContainText('Página 1');
  await openTabWith('/page3', 'Página 3');

  // Escribir la dirección de una pestaña abierta: primero "cambiar a esa pestaña", y Enter lleva a ella
  await address().click();
  await address().fill(`${server.base}/page1`);
  await expect(suggestions().first()).toHaveAttribute('data-kind', 'tab');
  await expect(suggestions().first()).toContainText('Ya está abierta');
  await address().press('Enter');
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(0)).toHaveAttribute('data-active', 'true');
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);

  // Por título: clic en la sugerencia de pestaña
  await address().click();
  await address().fill('Página 3');
  const tabItem = c.ui.locator('[data-testid="suggestion"][data-kind="tab"]');
  await expect(tabItem).toHaveCount(1);
  await expect(tabItem).toContainText('Cambiar a esta pestaña');
  await tabItem.click();
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(tabs()).toHaveCount(2);

  // Favoritos: aparecen con su nombre
  await c.ui.getByTestId('star').click();
  await c.ui.getByTestId('bookmark-title').fill('Mi favorito rarísimo');
  await c.ui.getByTestId('bookmark-title').press('Enter');
  await typeAddress(c.ui, `${server.base}/find`); // la página del favorito ya no está abierta
  await expect(activeTab()).toContainText('Buscar');
  await address().click();
  await address().fill('favorito rarísimo');
  const bookmarkItem = c.ui.locator('[data-testid="suggestion"][data-kind="bookmark"]');
  await expect(bookmarkItem).toHaveCount(1);
  await expect(bookmarkItem).toContainText('Mi favorito rarísimo');
  await bookmarkItem.click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page3`);
});

test('Ctrl+Shift+A: lista las pestañas abiertas, filtra mientras se escribe y Enter va a la elegida', async () => {
  c = await launchCallisto([], dir);
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(activeTab()).toContainText('Página 1');
  await openTabWith('/page2', 'Página 2');
  await openTabWith('/page3', 'Página 3');

  await pressKey(c.app, 'tab', 'A', ['control', 'shift']);
  await expect(address()).toHaveAttribute('data-mode', 'tabs');
  await expect(address()).toHaveAttribute('placeholder', 'Buscá entre las pestañas abiertas');
  await expect(address()).toHaveValue('');
  await expect(suggestions()).toHaveCount(2); // las otras dos (no la que se está viendo)
  await expect(suggestions().nth(0)).toContainText('Página 1');

  await address().fill('/page2');
  await expect(suggestions()).toHaveCount(1);
  await expect(suggestions().first()).toContainText('Página 2');
  await address().press('Enter');
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(address()).toHaveAttribute('data-mode', 'address');

  // Sin coincidencias, lo dice; Esc vuelve a la dirección de la pestaña
  await pressKey(c.app, 'ui', 'A', ['control', 'shift']);
  await expect(address()).toHaveAttribute('data-mode', 'tabs');
  await address().fill('no existe nada así');
  await expect(c.ui.getByTestId('suggestions-empty')).toHaveText('Ninguna pestaña abierta coincide');
  await address().press('Escape');
  await expect(address()).toHaveAttribute('data-mode', 'address');
  await expect(address()).toHaveValue(/page2/);
  await expect(tabs()).toHaveCount(3);
});
