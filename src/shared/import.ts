// Llegar a Callisto (1.6, bloque 6 de la 2.0): importar desde Chrome y Edge, y contraseñas desde/hacia un archivo CSV.
// Lógica pura (proceso principal, configuración y pruebas). Ver docs/19-v1.6.md.
import { isLoginOrigin, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from './passwords';

export type BrowserId = 'chrome' | 'edge';
export const BROWSER_NAMES: Record<BrowserId, string> = { chrome: 'Chrome', edge: 'Edge' };

/** Un perfil de Chrome o Edge encontrado en esta computadora. */
export interface ImportSource {
  /** "chrome:Default", "edge:Profile 1"… (el proceso principal lo vuelve a buscar: nunca es una ruta). */
  id: string;
  browser: BrowserId;
  /** Nombre del perfil en ese navegador ("Persona 1", "Trabajo"…). */
  profileName: string;
  hasBookmarks: boolean;
  hasHistory: boolean;
}

export interface ImportResult {
  /** Favoritos agregados (y los que no se pudieron guardar, como los bookmarklets "javascript:"). */
  bookmarks?: { added: number; skipped: number; folder: string };
  /** Visitas agregadas al historial (de los últimos 90 días, como guarda Callisto). */
  history?: { added: number };
  error?: string;
}

// ---------------------------------------------------------------- fechas de Chrome

/** Diferencia entre el 1 de enero de 1601 (fechas de Chrome y Windows) y el de 1970, en ms. */
const WINDOWS_EPOCH_MS = 11_644_473_600_000;

/** Fecha de Chrome (microsegundos desde 1601) a ms desde 1970; 0 si no hay. */
export function chromeTimeToMs(t: unknown): number {
  // Los microsegundos de hoy superan el entero seguro de JavaScript: se dividen como BigInt
  if (typeof t === 'bigint') return t > 0n ? Number(t / 1000n) - WINDOWS_EPOCH_MS : 0;
  const n = typeof t === 'string' && /^\d+$/.test(t) ? Number(BigInt(t) / 1000n) : Number(t) / 1000;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) - WINDOWS_EPOCH_MS;
}

/** ms desde 1970 a fecha de Chrome (microsegundos desde 1601). */
export const msToChromeTime = (ms: number): bigint => (BigInt(Math.floor(ms)) + BigInt(WINDOWS_EPOCH_MS)) * 1000n;

/** Tipo de navegación de Chrome: la parte baja de `transition`; 1 = escrita en la barra (PAGE_TRANSITION_TYPED). */
export const isTypedTransition = (transition: unknown): boolean => (Number(transition) & 0xff) === 1;

// ---------------------------------------------------------------- favoritos de Chrome y Edge

export interface ImportedLink {
  title: string;
  url: string;
}
export interface ImportedFolder {
  title: string;
  children: Array<ImportedFolder | ImportedLink>;
}
export const isImportedFolder = (n: ImportedFolder | ImportedLink): n is ImportedFolder => 'children' in n;

const MAX_DEPTH = 40;
const MAX_ITEMS = 50_000;

/**
 * El archivo "Bookmarks" de Chrome o Edge (JSON) como una carpeta para agregar: "Importados de Chrome", con la barra de
 * favoritos en su propia carpeta, después los "otros favoritos" y, si hay, los del celular. null si no es ese formato.
 */
export function bookmarksFromChromium(json: unknown, browser: BrowserId): ImportedFolder | null {
  const roots = (json && typeof json === 'object' ? (json as Record<string, unknown>).roots : null) as Record<string, unknown> | null;
  if (!roots || typeof roots !== 'object') return null;
  let count = 0;
  const convert = (node: unknown, depth: number): ImportedFolder | ImportedLink | null => {
    if (!node || typeof node !== 'object' || count >= MAX_ITEMS) return null;
    const n = node as Record<string, unknown>;
    const title = typeof n.name === 'string' ? n.name.slice(0, 1024) : '';
    if (n.type === 'url' && typeof n.url === 'string') {
      count++;
      return { title, url: n.url };
    }
    if (n.type === 'folder' && depth < MAX_DEPTH) {
      count++;
      return { title: title || 'Carpeta', children: childrenOf(n, depth + 1) };
    }
    return null;
  };
  const childrenOf = (n: Record<string, unknown>, depth: number) =>
    (Array.isArray(n.children) ? n.children : []).map((c) => convert(c, depth)).filter((c): c is ImportedFolder | ImportedLink => !!c);
  const rootChildren = (key: string) => (roots[key] && typeof roots[key] === 'object' ? childrenOf(roots[key] as Record<string, unknown>, 1) : []);

  const bar = rootChildren('bookmark_bar');
  const other = rootChildren('other');
  const synced = rootChildren('synced');
  const children: Array<ImportedFolder | ImportedLink> = [];
  if (bar.length) children.push({ title: 'Barra de favoritos', children: bar });
  children.push(...other);
  if (synced.length) children.push({ title: 'Favoritos del celular', children: synced });
  return { title: `Importados de ${BROWSER_NAMES[browser]}`, children };
}

// ---------------------------------------------------------------- contraseñas en CSV

/** CSV (RFC 4180): comillas dobles, comillas escapadas ("") y saltos de línea dentro de un campo. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

export interface CsvLogin {
  origin: string;
  username: string;
  password: string;
}

export type CsvLoginsResult = { logins: CsvLogin[]; skipped: number } | { error: string };

/** Máximo de contraseñas por archivo (un archivo más grande seguramente no es una exportación de contraseñas). */
export const MAX_CSV_LOGINS = 10_000;
export const MAX_CSV_BYTES = 10 * 1024 * 1024;

/**
 * Las contraseñas de un CSV exportado por Chrome, Edge o Firefox (columnas url, username, password; el orden y las
 * demás columnas no importan). Se saltean las filas sin sitio web o sin contraseña; si un sitio y usuario se repite,
 * vale la última.
 */
export function loginsFromCsv(text: string): CsvLoginsResult {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'El archivo está vacío.' };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [iUrl, iUser, iPass] = [col('url'), col('username'), col('password')];
  if (iUrl < 0 || iUser < 0 || iPass < 0) return { error: 'No parece un archivo de contraseñas: le faltan las columnas url, username y password.' };
  const byKey = new Map<string, CsvLogin>();
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const url = (r[iUrl] ?? '').trim();
    const username = (r[iUser] ?? '').trim();
    const password = r[iPass] ?? '';
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
    if (!isLoginOrigin(origin) || !password || password.length > MAX_PASSWORD_LENGTH || username.length > MAX_USERNAME_LENGTH) {
      skipped++;
      continue;
    }
    const key = `${origin}\n${username}`;
    if (byKey.has(key)) skipped++;
    byKey.set(key, { origin, username, password });
    if (byKey.size > MAX_CSV_LOGINS) return { error: `El archivo tiene más de ${MAX_CSV_LOGINS} contraseñas.` };
  }
  return { logins: [...byKey.values()], skipped };
}

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV con el formato de Chrome (name, url, username, password, note), que Chrome, Edge y Firefox pueden importar. */
export function loginsToCsv(logins: readonly CsvLogin[]): string {
  const lines = ['name,url,username,password,note'];
  for (const l of logins) {
    let name = l.origin;
    try {
      name = new URL(l.origin).hostname.replace(/^www\./, '');
    } catch {
      /* el sitio tal cual */
    }
    lines.push([name, `${l.origin}/`, l.username, l.password, ''].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
