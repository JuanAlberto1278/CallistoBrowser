import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, captureMenus, clickMenuItem, expectEventually, lastMenuLabels, launchCallisto, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-favoritos-'));
  c = await launchCallisto([], dir);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const bar = () => c.ui.getByTestId('bookmark');
const editor = () => c.ui.getByTestId('bookmark-editor');
const star = () => c.ui.getByTestId('star');

async function visit(path: string, title: string) {
  await typeAddress(c.ui, `${server.base}${path}`);
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}${path}`);
  await expect(c.ui.locator('[data-testid="tab"][data-active="true"]')).toContainText(title);
}

/** Agrega la página actual con Ctrl+D y cierra el editor. */
async function bookmarkCurrent() {
  await pressKey(c.app, 'ui', 'D', ['control']);
  await expect(editor()).toBeVisible();
  await c.ui.getByTestId('bookmark-save').click();
  await expect(editor()).toBeHidden();
}

async function internal(kind: string): Promise<Page> {
  await expectEventually(() => c.app.windows().some((p) => p.url().startsWith(`callisto://${kind}`)));
  const p = c.app.windows().find((w) => w.url().startsWith(`callisto://${kind}`))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

test('estrella y Ctrl+D: agregar a la barra, renombrar y quitar', async () => {
  await expect(c.ui.getByTestId('bookmarks-empty')).toBeVisible();
  await visit('/page1', 'Página 1');
  await expect(star()).toHaveAttribute('data-starred', 'false');

  await star().click();
  await expect(editor()).toContainText('Favorito agregado');
  await expect(bar()).toHaveCount(1);
  await expect(bar().first()).toContainText('Página 1');
  await expect(c.ui.getByTestId('bookmark-folder')).toHaveValue('1'); // Barra de favoritos
  await c.ui.getByTestId('bookmark-title').fill('Mi página');
  await c.ui.getByTestId('bookmark-title').press('Enter');
  await expect(editor()).toBeHidden();
  await expect(bar().first()).toContainText('Mi página');
  await expect(star()).toHaveAttribute('data-starred', 'true');

  await pressKey(c.app, 'tab', 'D', ['control']); // ya es favorito: abre el editor
  await expect(editor()).toContainText('Editar favorito');
  await c.ui.getByTestId('bookmark-remove').click();
  await expect(bar()).toHaveCount(0);
  await expect(star()).toHaveAttribute('data-starred', 'false');
});

test('barra: abrir en la pestaña, Ctrl+clic en segundo plano y reordenar arrastrando', async () => {
  for (const [path, title] of [['/page1', 'Página 1'], ['/page2', 'Página 2'], ['/page3', 'Página 3']] as const) {
    await visit(path, title);
    await bookmarkCurrent();
  }
  await expect(bar()).toHaveText(['Página 1', 'Página 2', 'Página 3']);

  await bar().nth(0).click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);
  await bar().nth(1).click({ modifiers: ['Control'] });
  await expect(c.ui.getByTestId('tab')).toHaveCount(2);
  expect(await activeTabUrl(c.app)).toBe(`${server.base}/page1`); // la nueva quedó en segundo plano

  const first = (await bar().nth(0).boundingBox())!;
  await bar().nth(2).dragTo(bar().nth(0), { targetPosition: { x: 3, y: first.height / 2 } });
  await expect(bar()).toHaveText(['Página 3', 'Página 1', 'Página 2']);
});

test('carpetas: crear desde la barra, mover adentro arrastrando y abrir desde su menú', async () => {
  await captureMenus(c.app);
  await visit('/page1', 'Página 1');
  await bookmarkCurrent();
  await visit('/page2', 'Página 2');
  await bookmarkCurrent();

  await c.ui.getByTestId('bookmarks-bar').click({ button: 'right', position: { x: 600, y: 10 } });
  await clickMenuItem(c.app, 'Agregar carpeta…');
  await expect(editor()).toContainText('Carpeta nueva');
  await c.ui.getByTestId('bookmark-title').fill('Trabajo');
  await c.ui.getByTestId('bookmark-save').click();
  await expect(bar()).toHaveText(['Página 1', 'Página 2', 'Trabajo']);

  const folder = c.ui.locator('[data-testid="bookmark"][data-kind="folder"]');
  const box = (await folder.boundingBox())!;
  await bar().nth(0).dragTo(folder, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await expect(bar()).toHaveText(['Página 2', 'Trabajo']);

  await folder.click();
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Página 1'));
  await clickMenuItem(c.app, 'Página 1');
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/page1`);
});

test('administrador: agregar, validar, editar, buscar, mover de carpeta y eliminar', async () => {
  // La confirmación para borrar una carpeta con contenido es un diálogo de Windows: se responde "Eliminar"
  await c.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await pressKey(c.app, 'ui', 'O', ['control', 'shift']);
  const m = await internal('bookmarks');
  await expect(m.getByTestId('bm-empty')).toBeVisible();

  await m.getByTestId('bm-add-page').click();
  await m.getByTestId('bm-form-title').fill('Peligroso');
  await m.getByTestId('bm-form-url').fill('javascript:alert(1)');
  await m.getByTestId('bm-form-save').click();
  await expect(m.getByTestId('bm-form-error')).toContainText('no se puede guardar');
  await m.getByTestId('bm-form-title').fill('Página 2');
  await m.getByTestId('bm-form-url').fill(`${server.base}/page2`);
  await m.getByTestId('bm-form-save').click();
  await expect(m.getByTestId('bm-row')).toHaveCount(1);

  await m.getByTestId('bm-add-folder').click();
  await m.getByTestId('bm-form-title').fill('Lecturas');
  await m.getByTestId('bm-form-save').click();
  await expect(m.getByTestId('bm-row')).toHaveCount(2);
  await expect(bar()).toHaveText(['Página 2', 'Lecturas']); // la barra se actualiza sola

  await m.getByTestId('bm-row').first().hover();
  await m.getByTestId('bm-edit').first().click();
  await m.getByTestId('bm-form-title').fill('Página dos');
  await m.getByTestId('bm-form-save').click();
  await expect(m.getByTestId('bm-title').first()).toHaveText('Página dos');

  await m.getByTestId('bm-search').fill('dos');
  await expect(m.getByTestId('bm-row')).toHaveCount(1);
  await m.getByTestId('bm-search').fill('');

  // Arrastrar el favorito a la carpeta "Otros favoritos" del árbol
  await m.getByTestId('bm-row').first().dragTo(m.locator('[data-testid="bm-tree-folder"][data-folder-id="2"]'));
  await expect(m.getByTestId('bm-row')).toHaveCount(1);
  await m.locator('[data-testid="bm-tree-folder"][data-folder-id="2"]').click();
  await expect(m.getByTestId('bm-title')).toHaveText(['Página dos']);

  // Mover también a "Lecturas" y borrar la carpeta con su contenido
  await m.getByTestId('bm-row').first().dragTo(m.locator('[data-testid="bm-tree-folder"]', { hasText: 'Lecturas' }));
  await expect(m.getByTestId('bm-empty')).toBeVisible();
  await m.locator('[data-testid="bm-tree-folder"][data-folder-id="1"]').click();
  await m.getByTestId('bm-row').hover();
  await m.getByTestId('bm-delete').click();
  await expect(m.getByTestId('bm-empty')).toBeVisible();
  await expect(bar()).toHaveCount(0);
});

test('la barra se oculta con Ctrl+Shift+B y puede mostrarse solo en pestañas nuevas', async () => {
  await visit('/page1', 'Página 1');
  await expect(c.ui.getByTestId('bookmarks-bar')).toBeVisible();
  await pressKey(c.app, 'tab', 'B', ['control', 'shift']);
  await expect(c.ui.getByTestId('bookmarks-bar')).toBeHidden();
  await pressKey(c.app, 'tab', 'B', ['control', 'shift']);
  await expect(c.ui.getByTestId('bookmarks-bar')).toBeVisible();

  await typeAddress(c.ui, 'callisto://settings');
  const s = await internal('settings');
  await s.getByTestId('settings-bookmarks-bar').selectOption('newtab');
  await expect(c.ui.getByTestId('bookmarks-bar')).toBeHidden();
  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('bookmarks-bar')).toBeVisible();
});

test('los favoritos se guardan y vuelven al reiniciar; el menú principal los lista', async () => {
  await visit('/page1', 'Página 1');
  await bookmarkCurrent();
  await c.close();
  c = await launchCallisto([], dir);
  await expect(bar()).toHaveText(['Página 1']);

  await captureMenus(c.app);
  await c.ui.getByTestId('app-menu').click();
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Favoritos'));
  const sub = await c.app.evaluate(() => {
    const m = (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.at(-1)!;
    return m.items.find((i) => i.label === 'Favoritos')!.submenu!.items.map((i) => i.label);
  });
  // La sesión restauró la Página 1, que ya es favorito: el menú ofrece editarlo
  expect(sub).toEqual(expect.arrayContaining(['Editar el favorito de esta página', 'Mostrar la barra de favoritos', 'Administrar favoritos', 'Página 1']));
});

test('un título con "&" se ve completo en los menús nativos', async () => {
  await captureMenus(c.app);
  await typeAddress(c.ui, 'callisto://bookmarks');
  const m = await internal('bookmarks');
  await m.getByTestId('bm-add-folder').click();
  await m.getByTestId('bm-form-title').fill('Rock & Roll');
  await m.getByTestId('bm-form-save').click();
  await m.getByTestId('bm-add-page').click();
  await m.getByTestId('bm-form-title').fill('Página 1');
  await m.getByTestId('bm-form-url').fill(`${server.base}/page1`);
  await m.getByTestId('bm-form-save').click();
  await expect(bar()).toHaveCount(2);
  await c.ui.getByTestId('app-menu').click();
  await expectEventually(async () => (await lastMenuLabels(c.app)).includes('Favoritos'));
  const labels = await c.app.evaluate(() => {
    const m = (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.at(-1)!;
    return m.items.find((i) => i.label === 'Favoritos')!.submenu!.items.map((i) => i.label);
  });
  expect(labels).toContain('Rock && Roll'); // en Windows, "&&" se muestra como "&"
});
