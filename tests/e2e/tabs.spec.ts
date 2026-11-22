import { expect, test, type Page } from '@playwright/test';
import {
  activeTabUrl,
  activeTabZoom,
  captureMenus,
  clickMenuItem,
  expectEventually,
  lastMenuLabels,
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

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => { c = await launchCallisto(); });
test.afterEach(async () => { await c.close(); });

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');
const windowTitle = () => c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getTitle());

/** Página web cuya URL termina en `suffix` (la única que hay). */
async function pageAt(suffix: string): Promise<Page> {
  await expectEventually(() => webPages(c.app, (u) => u.endsWith(suffix)).length === 1);
  return webPages(c.app, (u) => u.endsWith(suffix))[0]!;
}

async function openTabWith(url: string): Promise<void> {
  const before = await tabs().count();
  await c.ui.getByTestId('new-tab').click();
  await expect(tabs()).toHaveCount(before + 1);
  await typeAddress(c.ui, url);
  await expectEventually(async () => (await activeTabUrl(c.app)) === url);
}

test('Ctrl+T abre una pestaña con la barra de direcciones enfocada; Ctrl+W la cierra', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await pressKey(c.app, 'tab', 'T', ['control']);
  await expect(tabs()).toHaveCount(2);
  await expect(activeTab()).toContainText('Nueva pestaña');
  await expect(c.ui.getByTestId('address')).toBeFocused();
  await expect(c.ui.getByTestId('address')).toHaveValue('');
  await expectEventually(async () => (await windowTitle()) === 'Nueva pestaña — Callisto');

  await pressKey(c.app, 'ui', 'W', ['control']);
  await expect(tabs()).toHaveCount(1);
  await expect(activeTab()).toContainText('Página 1');
  await expect(c.ui.getByTestId('address')).toHaveValue(`${server.base}/page1`);
});

test('botón + y clic para cambiar: cada pestaña conserva su dirección y su estado', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#to2');
  await expect(c.tab).toHaveTitle('Página 2');
  await openTabWith(`${server.base}/page3`);
  await expect(c.ui.getByTestId('address')).toHaveValue(`${server.base}/page3`);

  await tabs().nth(0).click();
  await expect(c.ui.getByTestId('address')).toHaveValue(`${server.base}/page2`);
  await expect(c.ui.getByTestId('back')).toBeEnabled();
  await expectEventually(async () => (await windowTitle()) === 'Página 2 — Callisto');

  await tabs().nth(1).getByTestId('tab-close').click();
  await expect(tabs()).toHaveCount(1);
});

test('target=_blank abre una pestaña al lado; Ctrl+clic la abre en segundo plano', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#blank');
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(tabs().nth(1)).toContainText('Página 2');
  expect(await windowCount(c.app)).toBe(1);

  await tabs().nth(0).click();
  await c.tab.click('#to2', { modifiers: ['Control'] });
  await expect(tabs()).toHaveCount(3);
  await expect(tabs().nth(0)).toHaveAttribute('data-active', 'true'); // la de origen sigue activa
  await expect(tabs().nth(2)).toContainText('Página 2'); // a la derecha de la hija anterior
});

test('window.open con tamaño abre una ventana emergente que conserva window.opener', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#popup');
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  const popup = await pageAt('/page2');
  expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
  await expect(tabs()).toHaveCount(1);
});

test('una pestaña abierta por la página que se cierra sola (window.close) desaparece', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#opentab');
  await expect(tabs()).toHaveCount(2);
  const child = await pageAt('/self-close');
  expect(await child.evaluate(() => window.opener !== null)).toBe(true);
  await child.click('#close');
  await expect(tabs()).toHaveCount(1);
  await expect(activeTab()).toContainText('Página 1');
});

test('Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1 y Ctrl+9 cambian de pestaña', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith(`${server.base}/page2`);
  await openTabWith(`${server.base}/page3`);

  await pressKey(c.app, 'tab', '1', ['control']);
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page1'));
  await pressKey(c.app, 'tab', 'Tab', ['control']);
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page2'));
  await pressKey(c.app, 'tab', '9', ['control']);
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page3'));
  await pressKey(c.app, 'tab', 'Tab', ['control']); // da la vuelta
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page1'));
  await pressKey(c.app, 'tab', 'Tab', ['control', 'shift']);
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page3'));
});

test('cerrar y volver a abrir (Ctrl+Shift+T) recupera la pestaña con su historial', async () => {
  await typeAddress(c.ui, `${server.base}/page3`);
  await openTabWith(`${server.base}/page1`);
  const p1 = await pageAt('/page1');
  await p1.click('#to2');
  await expectEventually(async () => (await activeTabUrl(c.app)).endsWith('/page2'));

  await pressKey(c.app, 'tab', 'W', ['control']);
  await expect(tabs()).toHaveCount(1);
  await pressKey(c.app, 'tab', 'T', ['control', 'shift']);
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(activeTab()).toContainText('Página 2');
  await expect(c.ui.getByTestId('back')).toBeEnabled();
  await c.ui.getByTestId('back').click();
  await expect(activeTab()).toContainText('Página 1');
});

test('duplicar (Ctrl+Shift+K) copia la pestaña con su historial', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await c.tab.click('#to2');
  await expect(c.tab).toHaveTitle('Página 2');
  await pressKey(c.app, 'tab', 'K', ['control', 'shift']);
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');
  await expect(tabs().nth(1)).toContainText('Página 2');
  await expect(c.ui.getByTestId('back')).toBeEnabled();
});

test('menú de la pestaña: cerrar las demás y mover a una ventana nueva', async () => {
  await captureMenus(c.app);
  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith(`${server.base}/page2`);
  await openTabWith(`${server.base}/page3`);

  await tabs().nth(2).click({ button: 'right' });
  await clickMenuItem(c.app, 'Mover a una ventana nueva');
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  await expect(tabs()).toHaveCount(2);

  await tabs().nth(0).click({ button: 'right' });
  expect(await lastMenuLabels(c.app)).toEqual(expect.arrayContaining(['Duplicar', 'Cerrar pestaña', 'Cerrar las demás pestañas', 'Cerrar las pestañas de la derecha']));
  await clickMenuItem(c.app, 'Cerrar las demás pestañas');
  await expect(tabs()).toHaveCount(1);
  await expect(activeTab()).toContainText('Página 1');
});

test('menú contextual de la página: abrir enlace en pestaña nueva y copiar su dirección', async () => {
  await captureMenus(c.app);
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');

  await c.tab.click('#to2', { button: 'right' });
  await clickMenuItem(c.app, 'Abrir enlace en una pestaña nueva');
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(0)).toHaveAttribute('data-active', 'true');
  await expect(tabs().nth(1)).toContainText('Página 2');

  await c.tab.click('#to2', { button: 'right' });
  await clickMenuItem(c.app, 'Copiar dirección del enlace');
  await expectEventually(async () => (await c.app.evaluate(({ clipboard }) => clipboard.readText())) === `${server.base}/page2`);

  await c.tab.click('h1', { button: 'right' });
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Volver a cargar'));
  // "Adelante" no aparece porque está deshabilitado; "Atrás" vuelve a la pestaña en blanco inicial
  expect(await lastMenuLabels(c.app)).toEqual(['Atrás', 'Volver a cargar', 'Inspeccionar']);

  await c.tab.click('#field', { button: 'right' });
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Seleccionar todo'));
});

test('barra de direcciones: menú con "Pegar e ir"', async () => {
  await captureMenus(c.app);
  await c.app.evaluate(({ clipboard }, url) => clipboard.writeText(url), `${server.base}/page2`);
  await c.ui.getByTestId('address').click({ button: 'right' });
  await clickMenuItem(c.app, 'Pegar e ir');
  await expect(c.tab).toHaveTitle('Página 2');
});

test('arrastrar una pestaña la cambia de lugar', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await openTabWith(`${server.base}/page2`);
  await openTabWith(`${server.base}/page3`);
  const box = (await tabs().nth(0).boundingBox())!;
  await tabs().nth(2).dragTo(tabs().nth(0), { targetPosition: { x: 4, y: box.height / 2 } });
  await expect(tabs().nth(0)).toContainText('Página 3');
  await expect(tabs().nth(1)).toContainText('Página 1');
});

test('buscar en la página: Ctrl+F, conteo, siguiente/anterior, F3 y Esc', async () => {
  await typeAddress(c.ui, `${server.base}/find`);
  await expect(c.tab).toHaveTitle('Buscar');
  await pressKey(c.app, 'tab', 'F', ['control']);
  const input = c.ui.getByTestId('find-input');
  await expect(input).toBeFocused();
  await input.fill('callisto');
  const status = c.ui.getByTestId('find-status');
  await expect(status).toHaveText('1 de 3');
  await input.press('Enter');
  await expect(status).toHaveText('2 de 3');
  await input.press('Shift+Enter');
  await expect(status).toHaveText('1 de 3');
  await pressKey(c.app, 'tab', 'F3');
  await expect(status).toHaveText('2 de 3');
  await input.fill('no-existe-xyz');
  await expect(status).toHaveText('Sin resultados');
  await input.press('Escape');
  await expect(c.ui.getByTestId('find-bar')).toBeHidden();
});

test('la búsqueda y los avisos son de cada pestaña', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.click('#download');
  await expect(c.ui.getByTestId('notice')).toBeVisible();
  await pressKey(c.app, 'tab', 'F', ['control']);
  await c.ui.getByTestId('find-input').fill('Descargar');
  await expect(c.ui.getByTestId('find-status')).toHaveText('1 de 1');

  await openTabWith(`${server.base}/page2`);
  await expect(c.ui.getByTestId('find-bar')).toBeHidden();
  await expect(c.ui.getByTestId('notice')).toBeHidden();

  await tabs().nth(0).click();
  await expect(c.ui.getByTestId('find-input')).toHaveValue('Descargar');
  await expect(c.ui.getByTestId('notice')).toBeVisible();
});

test('zoom: Ctrl +, Ctrl -, Ctrl 0 e indicador para restablecer', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await expect(c.ui.getByTestId('zoom')).toBeHidden();

  await pressKey(c.app, 'tab', '=', ['control']);
  await expect(c.ui.getByTestId('zoom')).toHaveText('110 %');
  expect(await activeTabZoom(c.app)).toBeCloseTo(1.1);
  await pressKey(c.app, 'tab', '-', ['control']);
  await pressKey(c.app, 'tab', '-', ['control']);
  await expect(c.ui.getByTestId('zoom')).toHaveText('90 %');
  await pressKey(c.app, 'tab', '0', ['control']);
  await expect(c.ui.getByTestId('zoom')).toBeHidden();

  await pressKey(c.app, 'tab', '=', ['control']);
  await expect(c.ui.getByTestId('zoom')).toBeVisible();
  await c.ui.getByTestId('zoom').click();
  await expect(c.ui.getByTestId('zoom')).toBeHidden();
  expect(await activeTabZoom(c.app)).toBeCloseTo(1);
});

test('el zoom se recuerda por sitio, como en Chrome y Edge', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await pressKey(c.app, 'tab', '=', ['control']);
  await expect(c.ui.getByTestId('zoom')).toHaveText('110 %');

  await openTabWith(`${server.base}/page2`); // mismo sitio
  await expect(c.ui.getByTestId('zoom')).toHaveText('110 %');
  await openTabWith(`${server.base.replace('127.0.0.1', 'localhost')}/page3`); // otro sitio
  await expect(c.ui.getByTestId('zoom')).toBeHidden();
});

test('favicons: el declarado por la página (SVG) y /favicon.ico por defecto (ICO)', async () => {
  await typeAddress(c.ui, `${server.base}/icon-page`);
  const icon = activeTab().getByTestId('tab-favicon');
  await expect(icon).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await expectEventually(() => icon.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));

  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(icon).toHaveAttribute('src', /^data:image\/x-icon;base64,/);
  await expectEventually(() => icon.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
});

test('Ctrl+N abre una ventana nueva y Ctrl+Shift+W la cierra', async () => {
  await pressKey(c.app, 'ui', 'N', ['control']);
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  // Esperar a que cargue la interfaz de la ventana nueva
  await expectEventually(() => c.app.windows().filter((p) => p.url().startsWith('callisto://ui/')).length === 2);
  await pressKey(c.app, 'ui', 'W', ['control', 'shift'], 'newest');
  await expectEventually(async () => (await windowCount(c.app)) === 1);
  await expect(c.ui.getByTestId('address')).toBeVisible(); // quedó la ventana original
});

test('cerrar pestañas mientras cargan no rompe el proceso principal', async () => {
  // Registra cualquier excepción no capturada del proceso principal (en uso real aparecería como un diálogo de error)
  await c.app.evaluate(() => {
    const g = globalThis as unknown as { __errors: string[] };
    g.__errors = [];
    process.on('uncaughtException', (e) => g.__errors.push(String(e)));
  });
  await typeAddress(c.ui, `${server.base}/page1`);
  for (let i = 0; i < 5; i++) {
    await openTabWith(`${server.base}/icon-page?${i}`);
    await c.ui.getByTestId('new-tab').click();
    await typeAddress(c.ui, `${server.base}/slow?${i}`);
    await pressKey(c.app, 'ui', 'W', ['control']); // se cierra con la carga en curso
    await pressKey(c.app, 'ui', 'W', ['control']); // y la del favicon recién pedido
  }
  server.releaseSlow();
  await new Promise((r) => setTimeout(r, 500));
  await expect(tabs()).toHaveCount(1);
  expect(await c.app.evaluate(() => (globalThis as unknown as { __errors: string[] }).__errors)).toEqual([]);
});
