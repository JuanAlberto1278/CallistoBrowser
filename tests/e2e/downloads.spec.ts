import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeTabUrl, expectEventually, fileBytes, launchCallisto, pressKey, startServer, typeAddress, type Callisto, type TestServer } from './fixtures';

let server: TestServer;
let c: Callisto;

test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });
test.beforeEach(async () => {
  server.resetTokens();
  c = await launchCallisto();
});
test.afterEach(async () => { await c.close(); });

const downloadsDir = () => join(c.userData, 'Downloads');
const quarantine = () => join(c.userData, 'Quarantine');
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const prompt = () => c.ui.getByTestId('download-prompt');
const promptName = () => c.ui.getByTestId('download-prompt-name');

async function openLab(): Promise<Page> {
  await typeAddress(c.ui, `${server.base}/dl/lab`);
  await expect(c.tab).toHaveTitle('Laboratorio de descargas');
  return c.tab;
}

/** Espera el archivo guardado (sin temporales de Chromium) y devuelve su contenido. */
async function savedFile(name: string): Promise<Buffer> {
  const path = join(downloadsDir(), name);
  const item = c.ui.locator(`[data-testid="download-item"][data-filename="${name}"]`);
  try {
    await expectEventually(() => existsSync(path) && !files(downloadsDir()).some((f) => /\.(crdownload|tmp)$/i.test(f)), 20_000);
    await expectEventually(async () => (await item.getAttribute('data-state')) === 'completed', 20_000);
  } catch {
    const state = await item.getAttribute('data-state', { timeout: 1000 }).catch(() => 'no está en el panel');
    const status = await item.getByTestId('download-status').textContent({ timeout: 1000 }).catch(() => '');
    throw new Error(`${name}: no se guardó (estado: ${state}; ${status}; en Descargas: ${files(downloadsDir()).join(', ')})`);
  }
  return readFileSync(path);
}

// Matriz de mecanismos (V0.1 §1.1): botón, nombre esperado y contenido esperado
const MECHANISMS: Array<{ id: string; name: string; content: () => Buffer; clickAgain?: boolean }> = [
  { id: 'm-attach', name: 'adjunto.bin', content: () => fileBytes(4096) },
  { id: 'm-octet', name: 'octeto.bin', content: () => fileBytes(2500) },
  { id: 'm-a-download', name: 'texto.txt', content: () => Buffer.from('texto plano para descargar') },
  { id: 'm-js', name: 'por-js.bin', content: () => fileBytes(3000) },
  { id: 'm-window-open', name: 'ventana.bin', content: () => fileBytes(2000) },
  { id: 'm-redirect', name: 'redirigido.bin', content: () => fileBytes(1234) },
  { id: 'm-post', name: 'resultado-post.bin', content: () => fileBytes(1800), clickAgain: true },
  { id: 'm-iframe', name: 'iframe.bin', content: () => fileBytes(1500) },
  { id: 'm-blob', name: 'blob.txt', content: () => Buffer.from('contenido blob vigente') },
  { id: 'm-blob-revoked', name: 'exportado.csv', content: () => Buffer.from('contenido blob revocado') },
  { id: 'm-data', name: 'datos.bin', content: () => Buffer.from('datos en una URL data') },
  { id: 'm-pdf', name: 'documento.pdf', content: () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') },
  { id: 'm-one-time', name: 'un-solo-uso.bin', content: () => fileBytes(1600), clickAgain: true },
  { id: 'm-large', name: 'grande.bin', content: () => fileBytes(20 * 1024 * 1024) },
];

test('matriz: cada mecanismo pregunta antes de guardar y, al cancelar, no queda nada', async () => {
  const lab = await openLab();
  for (const m of MECHANISMS) {
    await lab.click(`#${m.id}`);
    await expect(promptName(), m.id).toHaveText(m.name);
    expect(files(downloadsDir()), `${m.id}: nada en Descargas antes de decidir`).toEqual([]);
    await c.ui.getByTestId('download-deny').click();
    await expect(prompt()).toBeHidden();
    if (await lab.isClosed()) throw new Error(`${m.id}: se cerró la página`);
  }
  await new Promise((r) => setTimeout(r, 800));
  expect(files(downloadsDir())).toEqual([]);
  expect(files(quarantine()), 'la cuarentena privada queda vacía').toEqual([]);
});

test('matriz: al autorizar, cada mecanismo se guarda completo y sin alterar', async () => {
  test.setTimeout(180_000);
  const lab = await openLab();
  for (const m of MECHANISMS) {
    await lab.click(`#${m.id}`);
    await expect(promptName(), m.id).toHaveText(m.name);
    await c.ui.getByTestId('download-save').click();
    if (m.clickAgain) {
      // El sitio no deja repetir el pedido (formulario POST, enlace de un solo uso): se pide volver a hacer clic
      const item = c.ui.locator(`[data-testid="download-item"][data-filename="${m.name}"]`);
      await expect(item, m.id).toHaveAttribute('data-state', 'waiting_click', { timeout: 20_000 });
      expect(files(downloadsDir()).includes(m.name)).toBe(false);
      await lab.click(`#${m.id}`);
      await expect(prompt()).toBeHidden(); // el pase de un solo uso no vuelve a preguntar
    }
    const saved = await savedFile(m.name);
    expect(saved.equals(m.content()), `${m.id}: contenido`).toBe(true);
  }
  // Ningún archivo de más (ni temporales) en Descargas, y la cuarentena vacía
  expect(files(downloadsDir()).sort()).toEqual(MECHANISMS.map((m) => m.name).sort());
  expect(files(quarantine())).toEqual([]);
});

test('varias descargas a la vez: se pregunta por cada una, en orden', async () => {
  const lab = await openLab();
  await lab.click('#m-multiple');
  await expect(promptName()).toHaveText('uno.bin');
  await expect(c.ui.getByTestId('download-waiting')).toHaveText('Hay 2 descargas más esperando.');
  await c.ui.getByTestId('download-save').click();
  await expect(promptName()).toHaveText('dos.bin');
  await c.ui.getByTestId('download-deny').click();
  await expect(promptName()).toHaveText('tres.bin');
  await c.ui.getByTestId('download-save').click();
  await savedFile('uno.bin');
  await savedFile('tres.bin');
  expect(files(downloadsDir()).sort()).toEqual(['tres.bin', 'uno.bin']);
});

test('pausar, reanudar y cancelar una descarga', async () => {
  const lab = await openLab();
  await lab.click('#m-slow');
  await c.ui.getByTestId('download-save').click();
  const item = c.ui.locator('[data-testid="download-item"][data-filename="lento.bin"]');
  await expect(item).toHaveAttribute('data-state', 'in_progress', { timeout: 10_000 });
  await item.getByTestId('download-pause').click();
  await expect(item).toHaveAttribute('data-state', 'paused');
  await expect(item.getByTestId('download-status')).toContainText('En pausa');
  await item.getByTestId('download-resume').click();
  await expect(item).toHaveAttribute('data-state', 'in_progress');
  await item.getByTestId('download-cancel').click();
  await expect(item).toHaveAttribute('data-state', 'cancelled');
  await new Promise((r) => setTimeout(r, 500));
  expect(files(downloadsDir())).toEqual([]); // el archivo parcial se borra
});

test('si el nombre ya existe, se guarda con otro nombre sin pisar el anterior', async () => {
  const lab = await openLab();
  for (let i = 0; i < 2; i++) {
    await lab.click('#m-attach');
    await c.ui.getByTestId('download-save').click();
    await expect(prompt()).toBeHidden();
  }
  await savedFile('adjunto.bin');
  await savedFile('adjunto (1).bin');
});

test('los tipos de archivo que ejecutan programas muestran una advertencia', async () => {
  const lab = await openLab();
  await lab.click('#m-exe');
  await expect(promptName()).toHaveText('instalador.exe');
  await expect(c.ui.getByTestId('download-prompt-warning')).toContainText('puede dañar tu equipo');
  await c.ui.getByTestId('download-deny').click();
  await lab.click('#m-attach');
  await expect(promptName()).toHaveText('adjunto.bin');
  await expect(c.ui.getByTestId('download-prompt-warning')).toBeHidden();
});

test('lo descargado queda marcado como "de Internet" para Windows (Zone.Identifier)', async () => {
  const lab = await openLab();
  await lab.click('#m-attach');
  await c.ui.getByTestId('download-save').click();
  await savedFile('adjunto.bin');
  const zone = readFileSync(join(downloadsDir(), 'adjunto.bin:Zone.Identifier'), 'utf8');
  expect(zone).toContain('ZoneId=3');
  expect(zone).toContain(`HostUrl=${server.base}/dl/attach`);
});

test('un enlace que abre una pestaña solo para descargar no deja la pestaña vacía', async () => {
  const lab = await openLab();
  await lab.click('#m-blank');
  await expect(promptName()).toHaveText('pestana.bin');
  await expect(c.ui.getByTestId('tab')).toHaveCount(1);
  await c.ui.getByTestId('download-save').click();
  await savedFile('pestana.bin');
});

test('Guardar como… y Guardar imagen como… usan el lugar elegido en el diálogo de Windows', async () => {
  const other = mkdtempSync(join(tmpdir(), 'callisto-guardar-como-'));
  try {
    // El diálogo de Windows no se puede manejar desde la prueba: se responde como si el usuario eligiera un archivo
    await c.app.evaluate(({ dialog }, dir) => {
      let n = 0;
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: `${dir}\\elegido-${++n}.bin` })) as typeof dialog.showSaveDialog;
    }, other);
    const lab = await openLab();
    await lab.click('#m-attach');
    await c.ui.getByTestId('download-save-as').click();
    await expectEventually(() => existsSync(join(other, 'elegido-1.bin')) && statSync(join(other, 'elegido-1.bin')).size === 4096, 15_000);

    await c.app.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { __menus: Electron.Menu[] };
      g.__menus = [];
      Menu.prototype.popup = function (this: Electron.Menu) { g.__menus.push(this); };
    });
    await lab.click('#img', { button: 'right' });
    await expectEventually(() => c.app.evaluate(() => (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.length > 0));
    await c.app.evaluate(() => {
      const m = (globalThis as unknown as { __menus: Electron.Menu[] }).__menus.pop()!;
      (m.items.find((i) => i.label === 'Guardar imagen como…')!.click as unknown as () => void)();
    });
    await expectEventually(() => existsSync(join(other, 'elegido-2.bin')) && statSync(join(other, 'elegido-2.bin')).size > 0, 15_000);
    expect(files(downloadsDir())).toEqual([]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test('la carpeta de descargas se cambia desde la configuración', async () => {
  const other = mkdtempSync(join(tmpdir(), 'callisto-carpeta-'));
  try {
    await c.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, other);
    await typeAddress(c.ui, 'callisto://settings');
    await expectEventually(() => c.app.windows().some((p) => p.url().startsWith('callisto://settings')));
    const s = c.app.windows().find((p) => p.url().startsWith('callisto://settings'))!;
    await s.getByTestId('settings-download-dir-change').click();
    await expect(s.getByTestId('settings-download-dir')).toHaveText(other);

    const lab = await (async () => {
      await typeAddress(c.ui, `${server.base}/dl/lab`);
      await expectEventually(() => c.app.windows().some((p) => p.url() === `${server.base}/dl/lab`));
      return c.app.windows().find((p) => p.url() === `${server.base}/dl/lab`)!;
    })();
    await lab.click('#m-attach');
    await expect(c.ui.getByTestId('download-prompt')).toContainText(other.split('\\').pop()!);
    await c.ui.getByTestId('download-save').click();
    await expectEventually(() => existsSync(join(other, 'adjunto.bin')), 15_000);
  } finally {
    rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('página de descargas: lista, busca y quita de la lista sin borrar el archivo', async () => {
  const lab = await openLab();
  for (const id of ['m-attach', 'm-pdf']) {
    await lab.click(`#${id}`);
    await c.ui.getByTestId('download-save').click();
  }
  await savedFile('adjunto.bin');
  await savedFile('documento.pdf');

  await pressKey(c.app, 'tab', 'J', ['control']);
  await expectEventually(() => c.app.windows().some((p) => p.url().startsWith('callisto://downloads')));
  const d = c.app.windows().find((p) => p.url().startsWith('callisto://downloads'))!;
  await expect(d.getByTestId('download-item')).toHaveCount(2);
  await d.getByTestId('downloads-search').fill('documento');
  await expect(d.getByTestId('download-item')).toHaveCount(1);
  await d.getByTestId('download-remove').click();
  await expect(d.getByTestId('downloads-empty')).toBeVisible();
  expect(existsSync(join(downloadsDir(), 'documento.pdf'))).toBe(true);
});

test('cerrar la ventana sin responder no guarda nada', async () => {
  const lab = await openLab();
  await lab.click('#m-attach');
  await expect(prompt()).toBeVisible();
  const proc = c.app.process();
  const exited = new Promise((r) => proc.once('exit', r));
  await c.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close());
  await exited;
  expect(files(downloadsDir())).toEqual([]);
});

// ---------------------------------------------------------------- página de nueva pestaña

test('nueva pestaña: saludo, búsqueda y sitios más visitados', async () => {
  await expect(c.ui.getByTestId('new-tab-page')).toBeVisible();
  await expect(c.ui.getByTestId('ntp-greeting')).toHaveText(/^Buen(os días|as tardes|as noches)$/);
  await expect(c.ui.getByTestId('ntp-empty')).toBeVisible();

  // Desde la búsqueda de la página: la pestaña navega (es la misma pestaña, no se reemplaza)
  await c.ui.getByTestId('ntp-search').fill(`${server.base}/page1`);
  await c.ui.getByTestId('ntp-search').press('Enter');
  await expect(c.tab).toHaveTitle('Página 1');
  await expect(c.ui.getByTestId('new-tab-page')).toBeHidden();
  await typeAddress(c.ui, `${server.base}/page2`);
  await expect(c.tab).toHaveTitle('Página 2');

  await c.ui.getByTestId('new-tab').click();
  await expect(c.ui.getByTestId('new-tab-page')).toBeVisible();
  const tile = c.ui.getByTestId('ntp-tile');
  await expect(tile).toHaveCount(1); // un mosaico por sitio
  await tile.getByRole('button').first().click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === `${server.base}/`);
  await expect(c.ui.getByTestId('new-tab-page')).toBeHidden();

  await c.ui.getByTestId('new-tab').click();
  await c.ui.getByTestId('ntp-tile').hover();
  await c.ui.getByTestId('ntp-hide').click();
  await expect(c.ui.getByTestId('ntp-tile')).toHaveCount(0);
  await c.ui.getByRole('button', { name: 'Deshacer' }).click();
  await expect(c.ui.getByTestId('ntp-tile')).toHaveCount(1);
});

test('nueva pestaña: las pestañas que abre una página no muestran la portada', async () => {
  await typeAddress(c.ui, `${server.base}/page1`);
  await expect(c.tab).toHaveTitle('Página 1');
  await c.tab.evaluate(() => { window.open('about:blank'); });
  await expect(c.ui.getByTestId('tab')).toHaveCount(2);
  await expect(c.ui.getByTestId('new-tab-page')).toBeHidden();
});
