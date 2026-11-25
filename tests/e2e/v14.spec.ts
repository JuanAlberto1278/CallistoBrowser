import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMenus, clickMenuItem, expectEventually, launchCallisto, pressKey, startServer, typeAddress, webPages, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;
let dir: string;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'callisto-v14-')); });
test.afterEach(async () => {
  await c?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tabs = () => c.ui.getByTestId('tab');
const activeTab = () => c.ui.locator('[data-testid="tab"][data-active="true"]');
const livePages = (path: string) => webPages(c.app, (u) => u.startsWith(`${server.base}${path}`)).length;

async function openTabWith(path: string, title: string): Promise<void> {
  const before = await tabs().count();
  await c.ui.getByTestId('new-tab').click();
  await expect(tabs()).toHaveCount(before + 1);
  await typeAddress(c.ui, `${server.base}${path}`);
  await expect(activeTab()).toContainText(title);
}

/** Ventanas del Administrador de tareas abiertas. */
const taskWindows = () => c.app.windows().filter((p) => p.url().startsWith('callisto://tasks'));

async function taskManager(): Promise<Page> {
  await expectEventually(() => taskWindows().length === 1);
  const p = taskWindows()[0]!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

async function settingsPage(): Promise<Page> {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

// ---------------------------------------------------------------- administrador de tareas

test('Shift+Esc abre el Administrador de tareas (una sola ventana) con los procesos y sus pestañas', async () => {
  c = await launchCallisto([], dir);
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(activeTab()).toContainText('Página 1');

  await pressKey(c.app, 'tab', 'Escape', ['shift']);
  const tm = await taskManager();
  const rows = tm.getByTestId('task-row');
  await expect(tm.locator('[data-testid="task-row"][data-kind="browser"]')).toHaveCount(1);
  await expect(tm.locator('[data-testid="task-row"][data-kind="ui"]').first()).toBeVisible();
  const pageRow = rows.filter({ hasText: 'Pestaña: Página 1' });
  await expect(pageRow).toHaveCount(1);
  await expect(pageRow.getByTestId('task-memory')).toHaveText(/^\d[\d.]* MB$/);
  await expect(tm.getByTestId('tasks-total')).toContainText('MB en');
  expect(await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('callisto://tasks'))!.getTitle())).toBe(
    'Administrador de tareas - Callisto',
  );

  // Otra vez Shift+Esc (o desde el menú ⋯): la misma ventana
  await pressKey(c.app, 'ui', 'Escape', ['shift']);
  await captureMenus(c.app);
  await c.ui.getByTestId('app-menu').click();
  await clickMenuItem(c.app, 'Administrador de tareas');
  await new Promise((r) => setTimeout(r, 500));
  expect(taskWindows()).toHaveLength(1);

  // El proceso principal y la interfaz no se pueden finalizar
  await tm.locator('[data-testid="task-row"][data-kind="browser"]').click();
  await expect(tm.getByTestId('task-end')).toBeDisabled();
  await tm.locator('[data-testid="task-row"][data-kind="ui"]').first().click();
  await expect(tm.getByTestId('task-end')).toBeDisabled();

  // Finalizar el proceso de la pestaña: la página dejó de funcionar
  await pageRow.click();
  await expect(tm.getByTestId('task-end')).toBeEnabled();
  await tm.getByTestId('task-end').click();
  await expect(c.ui.getByTestId('notice')).toContainText('La página dejó de funcionar');
  await expect(rows.filter({ hasText: 'Pestaña: Página 1' })).toHaveCount(0);

  // Ordenar por memoria
  await tm.getByTestId('tasks-sort-memory').click();
  const mem = await tm.getByTestId('task-memory').allTextContents();
  const values = mem.map((t) => Number(t.replace(/\D/g, '')));
  expect(values).toEqual([...values].sort((a, b) => b - a));
});

test('el Administrador de tareas se cierra con la última ventana (Callisto sale)', async () => {
  c = await launchCallisto([], dir);
  const settings = await settingsPage();
  // El texto del botón en una sola línea (1.4.1: se partía en dos y se salía del botón)
  const button = settings.getByTestId('open-task-manager');
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(34);
  expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  await button.click();
  await taskManager();
  const exited = new Promise<void>((r) => c.app.process().once('exit', () => r()));
  await c.app.evaluate(({ BaseWindow }) => {
    for (const w of BaseWindow.getAllWindows()) if (!w.getTitle().startsWith('Administrador')) setTimeout(() => w.close(), 0);
  });
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('Callisto no salió')), 15_000))]);
});

// ---------------------------------------------------------------- página que no responde

test('"La página no responde": Esperar o Detener la página', async () => {
  c = await launchCallisto([], dir);
  await typeAddress(c.ui, `${server.base}/hang`);
  await expect(activeTab()).toContainText('Se cuelga');
  const page = webPages(c.app, (u) => u.endsWith('/hang'))[0]!;
  void page.click('#hang').catch(() => {}); // queda colgada de verdad
  // Chromium no declara colgada una página con un depurador conectado (como el de Playwright, que se conecta a todas):
  // se simula su aviso ('unresponsive') y se prueba lo que hace Callisto con él
  const signal = (event: 'unresponsive' | 'responsive') =>
    c.app.evaluate(({ webContents }, event) => {
      webContents.getAllWebContents().find((w) => w.getURL().endsWith('/hang'))!.emit(event);
    }, event);
  await signal('unresponsive');
  await expect(c.ui.getByTestId('notice')).toContainText('La página no responde');
  // Si vuelve a responder, el aviso se va solo
  await signal('responsive');
  await expect(c.ui.getByTestId('notice')).toHaveCount(0);
  // Esperar: cierra el aviso y no toca la página
  await signal('unresponsive');
  await c.ui.getByTestId('notice-wait').click();
  await expect(c.ui.getByTestId('notice')).toHaveCount(0);
  expect(webPages(c.app, (u) => u.endsWith('/hang'))).toHaveLength(1);
  // Detener la página: termina su proceso
  await signal('unresponsive');
  await expect(c.ui.getByTestId('notice-wait')).toHaveText('Esperar');
  await c.ui.getByTestId('notice-stop').click();
  await expect(c.ui.getByTestId('notice')).toContainText('La página dejó de funcionar');
  await expect(c.ui.getByTestId('notice-stop')).toHaveCount(0);
});

// ---------------------------------------------------------------- CPU alta en segundo plano

test('una pestaña de fondo que usa mucha CPU muestra el ícono; un clic la duerme y cuenta la memoria liberada', async () => {
  // Un "minuto" de 1 s: el promedio de CPU se mide en 1 s
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '1000' });
  await typeAddress(c.ui, `${server.base}/busy`);
  await expect(activeTab()).toContainText('Ocupada');
  // Mientras se ve, no se marca
  await new Promise((r) => setTimeout(r, 2500));
  await expect(c.ui.getByTestId('tab-cpu')).toHaveCount(0);

  await openTabWith('/page1', 'Página 1');
  const cpu = tabs().nth(0).getByTestId('tab-cpu');
  await expect(cpu).toBeVisible({ timeout: 15_000 });
  await expect(tabs().nth(1).getByTestId('tab-cpu')).toHaveCount(0);
  await cpu.click();
  await expect(tabs().nth(0)).toHaveAttribute('data-asleep', 'true');
  await expectEventually(() => livePages('/busy') === 0);
  await expect(tabs().nth(1)).toHaveAttribute('data-active', 'true');

  // La memoria de esa pestaña (tenía su propio proceso) cuenta como liberada hoy
  const settings = await settingsPage();
  await expect(settings.getByTestId('memory-saved')).toContainText(/liberaron al menos \d+ MB/);
});

test('una pestaña de fondo que suena no se marca por usar CPU', async () => {
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '1000' });
  await typeAddress(c.ui, `${server.base}/busy`);
  await expect(activeTab()).toContainText('Ocupada');
  // La misma página, además, suena
  await webPages(c.app, (u) => u.endsWith('/busy'))[0]!.evaluate(() => {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 20000; // fuera del oído
    const g = ctx.createGain();
    g.gain.value = 0.004;
    o.connect(g).connect(ctx.destination);
    o.start();
  });
  await expect(activeTab().getByTestId('tab-audio')).toBeVisible();
  await openTabWith('/page1', 'Página 1');
  await new Promise((r) => setTimeout(r, 4000));
  await expect(c.ui.getByTestId('tab-cpu')).toHaveCount(0);
});

// ---------------------------------------------------------------- poca memoria

test('si a Windows le falta memoria, las pestañas se duermen antes (aunque esté en "Nunca"); se puede desactivar', async () => {
  // Un "minuto" de 300 ms y memoria baja simulada
  c = await launchCallisto([], dir, { CALLISTO_TEST_MINUTE_MS: '300', CALLISTO_TEST_LOW_MEMORY: '1' });
  const settings = await settingsPage();
  await settings.getByTestId('settings-sleep').selectOption('0'); // Nunca
  await expect(settings.getByTestId('settings-low-memory')).toBeChecked();
  await openTabWith('/page1', 'Página 1');
  await openTabWith('/page3', 'Página 3');
  await expect(tabs().nth(1)).toHaveAttribute('data-asleep', 'true', { timeout: 15_000 });

  // Desactivado: con "Nunca", ya no se duermen (la pestaña de la configuración también se había dormido: se despierta)
  await tabs().nth(0).click();
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const again = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await again.waitForLoadState('domcontentloaded');
  await again.getByTestId('settings-low-memory').uncheck();
  await openTabWith('/find', 'Buscar');
  await openTabWith('/page2', 'Página 2');
  await new Promise((r) => setTimeout(r, 2500));
  await expect(tabs().nth(3)).toHaveAttribute('data-asleep', 'false');
  expect(livePages('/find')).toBe(1);
});
