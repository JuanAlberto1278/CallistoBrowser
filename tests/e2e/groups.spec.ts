import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, captureMenus, clickMenuItem, expectEventually, launchCallisto, pressKey, startServer, typeAddress, windowCount, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-grupos-'));
  c = await launchCallisto([], dir);
  await captureMenus(c.app);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
const chips = () => c.ui.getByTestId('group-chip');
const titles = () => c.ui.getByTestId('tab-title').allTextContents();

async function threeTabs() {
  await typeAddress(c.ui, `${server.base}/page1`);
  for (const p of ['/page2', '/page3']) {
    await c.ui.getByTestId('new-tab').click();
    await typeAddress(c.ui, `${server.base}${p}`);
  }
  await expect(tabs()).toHaveText(['Página 1', 'Página 2', 'Página 3']);
}

/** Elige una opción de un submenú del último menú capturado. */
async function clickSubmenuItem(parent: string, label: string) {
  await expectEventually(() =>
    c.app.evaluate((_e, parent) => {
      const m = (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.at(-1);
      return !!m?.items.find((i) => i.label === parent);
    }, parent),
  );
  await c.app.evaluate((_e, { parent, label }) => {
    const m = (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.at(-1)!;
    const item = m.items.find((i) => i.label === parent)!.submenu!.items.find((i) => i.label === label)!;
    (item.click as unknown as () => void)();
  }, { parent, label });
}

async function groupFirstTab(name: string) {
  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Agregar la pestaña a un grupo nuevo');
  await expect(c.ui.getByTestId('group-editor')).toBeVisible();
  await c.ui.getByTestId('group-name').fill(name);
  await c.ui.getByTestId('group-name').press('Enter');
  await expect(c.ui.getByTestId('group-editor')).toBeHidden();
  await expect(chips()).toHaveText([name]);
}

test('crear un grupo desde el menú de la pestaña, con nombre y color', async () => {
  await threeTabs();
  await tabs().nth(0).click({ button: 'right' });
  await clickMenuItem(c.app, 'Agregar la pestaña a un grupo nuevo');
  await expect(c.ui.getByTestId('group-name')).toBeFocused();
  await c.ui.getByTestId('group-name').fill('Trabajo');
  await c.ui.getByTestId('group-color-orange').click();
  await expect(chips()).toHaveText(['Trabajo']);
  await expect(chips().first()).toHaveAttribute('style', /#fa7b17/);
  await expect(tabs().nth(0)).toHaveAttribute('data-group-id', /\d+/);
  await expect(tabs().nth(1)).toHaveAttribute('data-group-id', '');
  await c.ui.getByTestId('group-name').press('Escape');
  await expect(c.ui.getByTestId('group-editor')).toBeHidden();
});

test('agregar una pestaña a un grupo existente (queda junto al grupo) y quitarla', async () => {
  await threeTabs();
  await groupFirstTab('Lecturas');
  await tabs().nth(2).click({ button: 'right' });
  await clickSubmenuItem('Agregar la pestaña al grupo', 'Lecturas');
  await expect.poll(titles).toEqual(['Página 1', 'Página 3', 'Página 2']); // se mueve junto al grupo
  await expect(c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])')).toHaveCount(2);

  await tabs().nth(1).click({ button: 'right' });
  await clickMenuItem(c.app, 'Quitar del grupo');
  await expect(c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])')).toHaveCount(1);
  await expect.poll(titles).toEqual(['Página 1', 'Página 3', 'Página 2']); // queda justo después del grupo
});

test('contraer y expandir; activar una pestaña de un grupo contraído lo expande', async () => {
  await threeTabs();
  await groupFirstTab('Contraíble');
  await tabs().nth(0).click(); // la activa está en el grupo
  await chips().first().click();
  await expect(chips().first()).toHaveAttribute('data-collapsed', 'true');
  await expect(tabs()).toHaveCount(2); // la del grupo se oculta
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page2`); // la activa pasó afuera

  await pressKey(c.app, 'tab', '1', ['control']);
  await expect(chips().first()).toHaveAttribute('data-collapsed', 'false');
  await expect(tabs()).toHaveCount(3);
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);
});

test('lo que se abre desde una pestaña agrupada queda en el grupo', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await groupFirstTab('Investigación');
  await c.tab.click('#blank'); // target=_blank
  await expect(tabs()).toHaveCount(2);
  await expect(c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])')).toHaveCount(2);
});

test('panel del grupo: nueva pestaña en el grupo, desagrupar, mover a una ventana nueva y cerrar', async () => {
  await threeTabs();
  await groupFirstTab('Acciones');
  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-new-tab').click();
  await expect(tabs()).toHaveCount(4);
  await expect(c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])')).toHaveCount(2);

  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-move').click();
  await expectEventually(async () => (await windowCount(c.app)) === 2);
  await expect(tabs()).toHaveCount(2); // quedan las dos sin grupo
  await expect(chips()).toHaveCount(0);

  await groupFirstTab('Otro');
  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-ungroup').click();
  await expect(chips()).toHaveCount(0);
  await expect(tabs()).toHaveCount(2);

  await groupFirstTab('Para cerrar');
  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-close').click();
  await expect(tabs()).toHaveCount(1);
  await expect(chips()).toHaveCount(0);
});

test('arrastrar una pestaña adentro de un grupo y arrastrar el grupo entero', async () => {
  await threeTabs();
  await groupFirstTab('Arrastre');
  await tabs().nth(1).click({ button: 'right' });
  await clickSubmenuItem('Agregar la pestaña al grupo', 'Arrastre');
  await expect.poll(titles).toEqual(['Página 1', 'Página 2', 'Página 3']);

  // Página 3 entre Página 1 y Página 2 (las dos del grupo): se une
  const second = (await tabs().nth(1).boundingBox())!;
  await tabs().nth(2).dragTo(tabs().nth(1), { targetPosition: { x: 4, y: second.height / 2 } });
  await expect.poll(titles).toEqual(['Página 1', 'Página 3', 'Página 2']);
  await expect(c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])')).toHaveCount(3);

  // Una pestaña sin grupo al final, y el grupo entero arrastrado después de ella
  await c.ui.getByTestId('new-tab').click();
  await typeAddress(c.ui, `${server.base}/find`);
  await expect.poll(titles).toEqual(['Página 1', 'Página 3', 'Página 2', 'Buscar']);
  const last = (await tabs().nth(3).boundingBox())!;
  await chips().first().dragTo(tabs().nth(3), { targetPosition: { x: last.width - 4, y: last.height / 2 } });
  await expect.poll(titles).toEqual(['Buscar', 'Página 1', 'Página 3', 'Página 2']);
});

test('zona del grupo: soltar entre el encabezado y su primera pestaña une al grupo; a la izquierda del encabezado, no', async () => {
  await threeTabs();
  await groupFirstTab('Zona');
  const grouped = () => c.ui.locator('[data-testid="tab"][data-group-id]:not([data-group-id=""])');
  const chip = (await chips().first().boundingBox())!;

  // Página 3 sobre la mitad derecha del encabezado: entra al grupo, primera
  await tabs().nth(2).dragTo(chips().first(), { targetPosition: { x: chip.width - 3, y: chip.height / 2 } });
  await expect.poll(titles).toEqual(['Página 3', 'Página 1', 'Página 2']);
  await expect(grouped()).toHaveCount(2);
  await expect(tabs().nth(0)).toHaveAttribute('data-group-id', /\d+/);

  // Página 2 sobre la mitad izquierda del encabezado: queda antes del grupo, sin grupo
  await tabs().nth(2).dragTo(chips().first(), { targetPosition: { x: 3, y: chip.height / 2 } });
  await expect.poll(titles).toEqual(['Página 2', 'Página 3', 'Página 1']);
  await expect(grouped()).toHaveCount(2);
  await expect(tabs().nth(0)).toHaveAttribute('data-group-id', '');

  // Una del grupo soltada sobre una pestaña sin grupo: sale del grupo
  const first = (await tabs().nth(0).boundingBox())!;
  await tabs().nth(2).dragTo(tabs().nth(0), { targetPosition: { x: first.width - 4, y: first.height / 2 } });
  await expect.poll(titles).toEqual(['Página 2', 'Página 1', 'Página 3']);
  await expect(grouped()).toHaveCount(1);
  await expect(tabs().nth(1)).toHaveAttribute('data-group-id', '');
});

test('un grupo nuevo empieza a la izquierda del todo y el botón + queda junto a la última pestaña', async () => {
  await threeTabs();
  const gapBeforePlus = async () => {
    const last = (await tabs().last().boundingBox())!;
    const plus = (await c.ui.getByTestId('new-tab').boundingBox())!;
    return plus.x - (last.x + last.width);
  };
  const gapWithoutGroups = await gapBeforePlus();

  await tabs().nth(2).click({ button: 'right' });
  await clickMenuItem(c.app, 'Agregar la pestaña a un grupo nuevo');
  await expect(c.ui.getByTestId('group-editor')).toBeVisible();
  await expect.poll(titles).toEqual(['Página 3', 'Página 1', 'Página 2']);
  await expect(tabs().nth(0)).toHaveAttribute('data-group-id', /\d+/);
  await c.ui.getByTestId('group-name').press('Escape'); // sin nombre: el encabezado es solo un punto
  await expect(c.ui.getByTestId('group-editor')).toBeHidden();
  await expect.poll(gapBeforePlus).toBeLessThanOrEqual(gapWithoutGroups + 1);

  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-name').fill('Un nombre bastante largo');
  await c.ui.getByTestId('group-name').press('Enter');
  await expect(chips()).toHaveText(['Un nombre bastante largo']);
  await expect.poll(gapBeforePlus).toBeLessThanOrEqual(gapWithoutGroups + 1);
});

test('sin la barra de menú predeterminada de Electron', async () => {
  expect(await c.app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true);
});

test('los grupos (nombre, color y contraído) vuelven al reiniciar', async () => {
  await threeTabs();
  await groupFirstTab('Persistente');
  await chips().first().click({ button: 'right' });
  await c.ui.getByTestId('group-color-green').click();
  await c.ui.getByTestId('group-name').press('Escape');
  await tabs().nth(2).click();
  await chips().first().click(); // contraído
  await expect(tabs()).toHaveCount(2);
  await new Promise((r) => setTimeout(r, 300));

  await c.close();
  c = await launchCallisto([], dir);
  await expect(chips()).toHaveText(['Persistente']);
  await expect(chips().first()).toHaveAttribute('style', /#188038/);
  await expect(chips().first()).toHaveAttribute('data-collapsed', 'true');
  await expect(tabs()).toHaveCount(2);
  await chips().first().click();
  await expect(tabs()).toHaveText(['Página 1', 'Página 2', 'Página 3']);
});
