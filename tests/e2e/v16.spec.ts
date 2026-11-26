import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activeTabUrl, expectEventually, launchCallisto, typeAddress, type Callisto } from './fixtures';

// 1.6 (bloque 6 de la 2.0): importar desde Chrome y Edge (favoritos e historial) y contraseñas desde/hacia CSV.
// Chrome y Edge son de prueba: una carpeta con su misma estructura (CALLISTO_TEST_IMPORT_ROOT, solo sin empaquetar).

let c: Callisto;
let dir: string;
let root: string;
let files: string;

const DAY = 24 * 60 * 60 * 1000;
/** ms desde 1970 → fecha de Chrome (microsegundos desde 1601). */
const chromeTime = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n;

/** Un perfil de Chrome o Edge de prueba. */
function fakeBrowser(userData: string[], profiles: Record<string, string>, bookmarks: unknown, history?: Array<{ url: string; title: string; ago: number; typed?: boolean }>) {
  const base = join(root, ...userData);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'Local State'), JSON.stringify({ profile: { info_cache: Object.fromEntries(Object.entries(profiles).map(([d, name]) => [d, { name }])) } }));
  const profileDir = join(base, Object.keys(profiles)[0]!);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'Bookmarks'), JSON.stringify(bookmarks));
  if (history) {
    const db = new DatabaseSync(join(profileDir, 'History'));
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)');
    db.exec('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER)');
    history.forEach((h, i) => {
      db.prepare('INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 1, 0, ?, 0)').run(i + 1, h.url, h.title, chromeTime(Date.now() - h.ago));
      db.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)').run(i + 1, chromeTime(Date.now() - h.ago), h.typed ? 0x30000001 : 0x30000000);
    });
    db.close();
  }
}

const CHROME_BOOKMARKS = {
  roots: {
    bookmark_bar: { type: 'folder', name: 'Barra', children: [{ type: 'url', name: 'Favorito de Chrome', url: 'https://ejemplo.com/chrome' }, { type: 'url', name: 'Bookmarklet', url: 'javascript:alert(1)' }] },
    other: { type: 'folder', name: 'Otros', children: [{ type: 'folder', name: 'Recetas', children: [{ type: 'url', name: 'Receta importada', url: 'https://ejemplo.com/receta' }] }] },
    synced: { type: 'folder', name: 'Celular', children: [] },
  },
};

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-v16-'));
  root = mkdtempSync(join(tmpdir(), 'callisto-v16-root-'));
  files = mkdtempSync(join(tmpdir(), 'callisto-v16-files-'));
  fakeBrowser(['Google', 'Chrome', 'User Data'], { Default: 'Persona 1' }, CHROME_BOOKMARKS, [
    { url: 'https://ejemplo.com/visitado', title: 'Sitio visitado en Chrome', ago: 2 * DAY, typed: true },
    { url: 'https://ejemplo.com/viejo', title: 'Visita de hace meses', ago: 200 * DAY },
  ]);
  fakeBrowser(['Microsoft', 'Edge', 'User Data'], { 'Profile 1': 'Trabajo' }, { roots: { bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Favorito de Edge', url: 'https://ejemplo.com/edge' }] }, other: { type: 'folder', children: [] } } });
});
test.afterEach(async () => {
  await c?.close();
  for (const d of [dir, root, files]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const start = async (env: Record<string, string> = {}) => {
  c = await launchCallisto([], dir, { CALLISTO_TEST_IMPORT_ROOT: root, ...env });
};

async function openInternal(page: 'settings' | 'bookmarks' | 'history'): Promise<Page> {
  await typeAddress(c.ui, `callisto://${page}`);
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith(`callisto://${page}`)));
  const p = c.app.windows().find((w) => w.url().startsWith(`callisto://${page}`))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

/** El cuadro "Abrir" o "Guardar" de Windows devuelve este archivo. */
const answerDialog = (kind: 'open' | 'save', path: string) =>
  c.app.evaluate(({ dialog }, a) => {
    if (a.kind === 'open') dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [a.path] })) as typeof dialog.showOpenDialog;
    else dialog.showSaveDialog = (async () => ({ canceled: false, filePath: a.path })) as typeof dialog.showSaveDialog;
  }, { kind, path });

test('primer inicio: un aviso ofrece importar (una sola vez) y lleva a Configuración', async () => {
  await start();
  await expect(c.ui.getByTestId('notice')).toContainText('Encontramos Chrome y Edge en esta computadora');
  await c.ui.getByTestId('notice-open-import').click();
  await expectEventually(async () => (await activeTabUrl(c.app)) === 'callisto://settings/#s-import');
  await c.close();
  c = await launchCallisto([], dir, { CALLISTO_TEST_IMPORT_ROOT: root });
  await expect(c.ui.getByTestId('tab').first()).toBeVisible();
  await expect(c.ui.getByTestId('notice')).toBeHidden();
});

test('importar de Chrome: favoritos en su carpeta e historial de los últimos 90 días (sin duplicar)', async () => {
  await start();
  const s = await openInternal('settings');
  await expect(s.getByTestId('import-source')).toHaveValue('chrome:Default');
  await expect(s.getByTestId('import-source').locator('option')).toHaveText(['Chrome — Persona 1', 'Edge — Trabajo']);
  await s.getByTestId('import-run').click();
  await expect(s.getByTestId('import-result')).toContainText('2 favoritos en la carpeta «Importados de Chrome»');
  await expect(s.getByTestId('import-result')).toContainText('1 favorito no se pudo guardar');
  await expect(s.getByTestId('import-result')).toContainText('1 visita al historial');
  // Otra vez: los favoritos se agregan de nuevo (otra carpeta, como en Chrome), el historial no se duplica
  await s.getByTestId('import-bookmarks').uncheck();
  await s.getByTestId('import-run').click();
  await expect(s.getByTestId('import-result')).toHaveText('Listo: nada nuevo en el historial.');
  // Edge: solo favoritos (no tiene historial)
  await s.getByTestId('import-source').selectOption('edge:Profile 1');
  await expect(s.getByTestId('import-history')).toBeDisabled();
  await s.getByTestId('import-bookmarks').check();
  await s.getByTestId('import-run').click();
  await expect(s.getByTestId('import-result')).toContainText('1 favorito en la carpeta «Importados de Edge»');

  const b = await openInternal('bookmarks');
  for (const title of ['Favorito de Chrome', 'Receta importada', 'Favorito de Edge']) {
    await b.getByTestId('bm-search').fill(title);
    await expect(b.getByTestId('bm-title')).toHaveText([title]);
  }
  await b.getByTestId('bm-search').fill('Bookmarklet');
  await expect(b.getByTestId('bm-title')).toHaveCount(0);

  const h = await openInternal('history');
  await expect(h.getByTestId('history-title').filter({ hasText: 'Sitio visitado en Chrome' })).toHaveCount(1);
  await expect(h.getByText('Visita de hace meses')).toHaveCount(0);
});

test('contraseñas: importar un CSV de Chrome, decidir los choques y exportar con Windows Hello', async () => {
  await start({ CALLISTO_TEST_AUTH: 'allow' });
  const s = await openInternal('settings');
  const csv1 = join(files, 'chrome.csv');
  writeFileSync(
    csv1,
    '﻿name,url,username,password,note\r\n' +
      'ejemplo.com,https://ejemplo.com/login,ana,"clave, con coma",\r\n' +
      'otro.com,https://otro.com/,beto,"con ""comillas""",nota\r\n' +
      'android,android://abc@com.app/,carla,x,\r\n' +
      'vacía,https://vacia.com/,dani,,\r\n',
  );
  await answerDialog('open', csv1);
  await s.getByTestId('import-passwords').click();
  await expect(s.getByTestId('passwords-csv-result')).toHaveText('Importadas: 2 contraseñas nuevas, 2 filas salteadas (sin sitio web o sin contraseña).');

  // El mismo usuario con otra contraseña: Callisto pregunta
  const csv2 = join(files, 'edge.csv');
  writeFileSync(csv2, 'name,url,username,password\nejemplo.com,https://ejemplo.com/,ana,nueva\notro.com,https://otro.com/,beto,"con ""comillas"""\nnuevo.com,https://nuevo.com/,eva,123\n');
  await answerDialog('open', csv2);
  await s.getByTestId('import-passwords').click();
  await expect(s.getByTestId('import-conflicts')).toContainText('ejemplo.com — ana');
  await s.getByTestId('import-keep').click();
  await expect(s.getByTestId('passwords-csv-result')).toHaveText('Importadas: 1 contraseña nueva, 1 ya estaba. Se conservaron las tuyas.');
  await s.getByTestId('import-passwords').click();
  await expect(s.getByTestId('import-conflicts')).toBeVisible();
  await s.getByTestId('import-replace').click();
  await expect(s.getByTestId('passwords-csv-result')).toContainText('Se reemplazaron 1 contraseña con las del archivo.');

  // Exportar: aviso, Windows Hello y el archivo con el formato de Chrome
  const out = join(files, 'exportadas.csv');
  await answerDialog('save', out);
  await s.getByTestId('export-passwords').click();
  await expect(s.getByTestId('export-confirm')).toContainText('no está cifrado');
  await s.getByTestId('export-run').click();
  await expect(s.getByTestId('passwords-csv-result')).toHaveText('Se exportaron 3 contraseñas.');
  expect(await c.app.evaluate(() => (globalThis as unknown as { __callistoAuthRequests?: number }).__callistoAuthRequests)).toBe(1);
  const text = readFileSync(out, 'utf8');
  expect(text.split('\r\n')[0]).toBe('name,url,username,password,note');
  expect(text).toContain('ejemplo.com,https://ejemplo.com/,ana,nueva,');
  expect(text).toContain('otro.com,https://otro.com/,beto,"con ""comillas""",');
  expect(text).toContain('nuevo.com,https://nuevo.com/,eva,123,');
});

test('exportar contraseñas: sin verificar la identidad no se exporta nada', async () => {
  await start({ CALLISTO_TEST_AUTH: 'deny' });
  const s = await openInternal('settings');
  const csv = join(files, 'una.csv');
  writeFileSync(csv, 'name,url,username,password\nejemplo.com,https://ejemplo.com/,ana,secreta\n');
  await answerDialog('open', csv);
  await s.getByTestId('import-passwords').click();
  await expect(s.getByTestId('passwords-csv-result')).toContainText('1 contraseña nueva');
  const out = join(files, 'no.csv');
  await answerDialog('save', out);
  await s.getByTestId('export-passwords').click();
  await s.getByTestId('export-run').click();
  await expect(s.getByTestId('passwords-csv-result')).toHaveText('No se verificó tu identidad.');
  expect(() => readFileSync(out)).toThrow();
});
