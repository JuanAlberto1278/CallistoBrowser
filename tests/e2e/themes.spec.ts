import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectEventually, launchCallisto, typeAddress, type Callisto } from './fixtures';

let c: Callisto;
let dir: string;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-temas-'));
  c = await launchCallisto([], dir);
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const cssVar = (p: Page, name: string) => p.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const nativeSource = () => c.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);

async function settingsPage(): Promise<Page> {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

test('elegir un tema: cambia la interfaz, las páginas internas y el modo de Chromium', async () => {
  const p = await settingsPage();
  await expect(p.locator('[data-theme-id="system"]')).toHaveClass(/selected/);
  await p.locator('[data-theme-id="midnight"] .theme-pick').click();
  await expect(p.locator('[data-theme-id="midnight"]')).toHaveClass(/selected/);
  await expect.poll(() => cssVar(c.ui, '--strip')).toBe('#0f1626');
  await expect.poll(() => cssVar(p, '--accent')).toBe('#7aa2ff');
  await expect.poll(nativeSource).toBe('dark');

  await p.locator('[data-theme-id="sunset"] .theme-pick').click();
  await expect.poll(() => cssVar(c.ui, '--strip')).toBe('#f7d9c4');
  await expect.poll(nativeSource).toBe('light');

  // "Sistema": sin colores propios, sigue a Windows
  await p.locator('[data-theme-id="system"] .theme-pick').click();
  await expect.poll(nativeSource).toBe('system');
  await expect.poll(() => c.ui.evaluate(() => document.documentElement.style.getPropertyValue('--strip'))).toBe('');
});

test('crear un tema propio, usarlo, que vuelva al reiniciar, editarlo y eliminarlo', async () => {
  let p = await settingsPage();
  await p.getByTestId('theme-new').click();
  await p.getByTestId('theme-name').fill('Mi violeta');
  await p.getByTestId('theme-mode').selectOption('dark');
  await p.getByTestId('theme-color-strip').fill('#20103a');
  await p.getByTestId('theme-color-toolbar').fill('#2c1a4d');
  await p.getByTestId('theme-color-text').fill('#f3ecff');
  await p.getByTestId('theme-color-accent').fill('#c084fc');
  await p.getByTestId('theme-color-field').fill('#1a0d30');
  await expect(p.getByTestId('theme-contrast')).toHaveCount(0);
  await p.getByTestId('theme-save').click();
  await expect(p.getByTestId('theme-custom').getByTestId('theme-card')).toHaveCount(1);
  await expect(p.getByTestId('theme-custom')).toContainText('Mi violeta');
  await expect.poll(() => cssVar(c.ui, '--strip')).toBe('#20103a');
  await expect.poll(nativeSource).toBe('dark');

  // Después de reiniciar
  await c.close();
  c = await launchCallisto([], dir);
  await expect.poll(() => cssVar(c.ui, '--strip')).toBe('#20103a');
  p = await settingsPage();
  await expect(p.getByTestId('theme-custom').locator('.selected')).toContainText('Mi violeta');

  // Editar: el aviso de poco contraste aparece si el texto se parece al fondo
  await p.getByTestId('theme-edit').click();
  await p.getByTestId('theme-color-text').fill('#2c1a4e');
  await expect(p.getByTestId('theme-contrast')).toBeVisible();
  await p.getByTestId('theme-color-text').fill('#ffffff');
  await p.getByTestId('theme-color-strip').fill('#301050');
  await p.getByTestId('theme-save').click();
  await expect.poll(() => cssVar(c.ui, '--strip')).toBe('#301050');

  // Eliminar el tema en uso: vuelve a "Sistema"
  await p.getByTestId('theme-delete').click();
  await expect(p.getByTestId('theme-custom')).toHaveCount(0);
  await expect(p.locator('[data-theme-id="system"]')).toHaveClass(/selected/);
  await expect.poll(nativeSource).toBe('system');
});

test('barra de título: las pestañas comparten fila con los botones de Windows, que toman los colores del tema', async () => {
  // La franja arrastra la ventana; las pestañas y los botones, no
  expect(await c.ui.evaluate(() => getComputedStyle(document.querySelector('.tabstrip-row')!).getPropertyValue('-webkit-app-region'))).toBe('drag');
  expect(await c.ui.evaluate(() => getComputedStyle(document.querySelector('[data-testid="tab"]')!).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
  expect(await c.ui.evaluate(() => getComputedStyle(document.querySelector('[data-testid="new-tab"]')!).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
  // Los colores que recibe Windows para sus botones
  await c.app.evaluate(({ BaseWindow }) => {
    const g = globalThis as unknown as { __overlay: unknown[] };
    g.__overlay = [];
    const original = BaseWindow.prototype.setTitleBarOverlay;
    BaseWindow.prototype.setTitleBarOverlay = function (this: Electron.BaseWindow, o: Electron.TitleBarOverlayOptions) {
      g.__overlay.push(o);
      return original.call(this, o);
    };
  });
  const p = await settingsPage();
  await p.locator('[data-theme-id="midnight"] .theme-pick').click();
  await expect
    .poll(() => c.app.evaluate(() => JSON.stringify((globalThis as unknown as { __overlay: unknown[] }).__overlay.at(-1) ?? null)))
    .toBe(JSON.stringify({ color: '#0f1626', symbolColor: '#e6ecff', height: 38 }));
});
