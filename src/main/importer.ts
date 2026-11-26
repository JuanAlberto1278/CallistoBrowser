// Importar desde Chrome y Edge (1.6): favoritos e historial, leídos de su perfil en esta computadora (solo lectura).
// Las contraseñas no se leen de ahí (Chrome las cifra para que solo él las descifre): se importan del CSV que exporta.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import type { Profile } from './profile';
import { invisibleForTests } from './test-mode';
import { BookmarkError } from './bookmark-store';
import { OTHER_FOLDER_ID } from '../shared/bookmarks';
import { BROWSER_NAMES, bookmarksFromChromium, chromeTimeToMs, isImportedFolder, msToChromeTime, isTypedTransition, type BrowserId, type ImportedFolder, type ImportedLink, type ImportResult, type ImportSource } from '../shared/import';

/**
 * Carpeta de datos de los programas (%LOCALAPPDATA%). Solo sin empaquetar, las pruebas usan otra
 * (CALLISTO_TEST_IMPORT_ROOT) con perfiles de prueba; sin ella, en modo de pruebas no se busca nada (así las pruebas no
 * ven el Chrome real de la computadora).
 */
function dataRoot(): string | null {
  const test = !app.isPackaged ? process.env.CALLISTO_TEST_IMPORT_ROOT : undefined;
  if (test) return test;
  if (invisibleForTests) return null;
  return process.env.LOCALAPPDATA ?? null;
}

const USER_DATA: Record<BrowserId, string[]> = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data'],
};

const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

interface FoundSource extends ImportSource {
  dir: string;
}

/** Perfiles de Chrome y Edge con favoritos o historial. */
function found(): FoundSource[] {
  const root = dataRoot();
  if (!root) return [];
  const out: FoundSource[] = [];
  for (const browser of Object.keys(USER_DATA) as BrowserId[]) {
    const userData = join(root, ...USER_DATA[browser]);
    if (!existsSync(userData)) continue;
    // Los perfiles y sus nombres están en "Local State"; si no se puede leer, el perfil "Default"
    let profiles: Array<[string, string]> = [];
    try {
      const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: string }> } };
      profiles = Object.entries(state.profile?.info_cache ?? {}).map(([dir, info]) => [dir, typeof info?.name === 'string' && info.name ? info.name : dir]);
    } catch {
      profiles = [];
    }
    if (!profiles.length) profiles = [['Default', 'Default']];
    for (const [dirName, name] of profiles) {
      if (!/^[\w .-]{1,100}$/.test(dirName) || dirName.includes('..')) continue;
      const dir = join(userData, dirName);
      const hasBookmarks = fileSize(join(dir, 'Bookmarks')) > 0;
      const hasHistory = fileSize(join(dir, 'History')) > 0;
      if (hasBookmarks || hasHistory) out.push({ id: `${browser}:${dirName}`, browser, profileName: name.slice(0, 100), hasBookmarks, hasHistory, dir });
    }
  }
  return out;
}

export function importSources(): ImportSource[] {
  return found().map(({ dir: _dir, ...s }) => s);
}

/** Agrega la carpeta importada en "Otros favoritos". Devuelve cuántos favoritos entraron y cuántos no. */
function addBookmarks(profile: Profile, folder: ImportedFolder): { added: number; skipped: number } {
  const store = profile.bookmarks;
  let added = 0;
  let skipped = 0;
  const addChildren = (parentId: number, children: Array<ImportedFolder | ImportedLink>) => {
    for (const c of children) {
      if (isImportedFolder(c)) addChildren(store.addFolder(parentId, c.title), c.children);
      else {
        try {
          store.addUrl(parentId, c.title, c.url);
          added++;
        } catch (e) {
          if (!(e instanceof BookmarkError)) throw e;
          skipped++; // direcciones que no se pueden guardar como favorito (por ejemplo, "javascript:")
        }
      }
    }
  };
  addChildren(store.addFolder(OTHER_FOLDER_ID, folder.title), folder.children);
  return { added, skipped };
}

/**
 * El historial de Chrome o Edge: se copia el archivo (el navegador puede tenerlo abierto) y se lee la copia. Visitas de
 * los últimos 90 días, con su título y si se escribió la dirección.
 */
function readHistory(dir: string): Array<{ url: string; title: string; time: number; typed: boolean }> {
  const tmp = mkdtempSync(join(tmpdir(), 'callisto-import-'));
  try {
    const copy = join(tmp, 'History');
    copyFileSync(join(dir, 'History'), copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT u.url AS url, u.title AS title, v.visit_time AS time, v.transition AS transition FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time >= ? ORDER BY v.visit_time LIMIT 200000');
      stmt.setReadBigInts(true); // las fechas de Chrome no entran en un número de JavaScript
      const rows = stmt.all(msToChromeTime(Date.now() - 90 * 24 * 60 * 60 * 1000)) as Array<{ url: string; title: string | null; time: number | bigint; transition: number | bigint }>;
      return rows.map((r) => ({ url: String(r.url), title: r.title ? String(r.title) : '', time: chromeTimeToMs(r.time), typed: isTypedTransition(r.transition) }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Importa del perfil elegido (que se vuelve a buscar: el pedido nunca trae una ruta). */
export function importFrom(profile: Profile, sourceId: string, what: { bookmarks: boolean; history: boolean }): ImportResult {
  const source = found().find((s) => s.id === sourceId);
  const name = source ? BROWSER_NAMES[source.browser] : '';
  if (!source) return { error: 'No se encontró ese perfil. Puede que el navegador se haya desinstalado.' };
  const result: ImportResult = {};
  if (what.bookmarks && source.hasBookmarks) {
    try {
      const tree = bookmarksFromChromium(JSON.parse(readFileSync(join(source.dir, 'Bookmarks'), 'utf8')), source.browser);
      if (!tree) return { error: `No se pudieron leer los favoritos de ${name}.` };
      result.bookmarks = { ...addBookmarks(profile, tree), folder: tree.title };
    } catch {
      return { ...result, error: `No se pudieron leer los favoritos de ${name}.` };
    }
  }
  if (what.history && source.hasHistory) {
    try {
      result.history = { added: profile.history.importVisits(readHistory(source.dir)) };
    } catch {
      return { ...result, error: `No se pudo leer el historial de ${name}. Cerrá ${name} y probá de nuevo.` };
    }
  }
  return result;
}
