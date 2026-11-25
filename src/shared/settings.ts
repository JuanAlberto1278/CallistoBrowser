// Configuración del perfil (lógica pura, compartida por el proceso principal y la página de configuración).
import { MAX_CUSTOM_THEMES, PRESET_THEMES, SYSTEM_THEME_ID, sanitizeCustomTheme, type Theme } from './themes';

export const SEARCH_ENGINES = {
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  ecosia: { name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
} as const;

export type SearchEngineId = keyof typeof SEARCH_ENGINES;

export interface Settings {
  searchEngine: SearchEngineId;
  /** Al abrir Callisto: volver a las ventanas y pestañas de la última vez, una pestaña nueva o páginas elegidas (1.5). */
  startup: 'restore' | 'newtab' | 'pages';
  /** Las páginas de "Abrir páginas específicas" (1.5). */
  startupPages: string[];
  /** Al cerrar Callisto, borrar (1.5): cada tipo es opcional y empieza apagado. */
  clearOnExit: ClearOnExit;
  /** Carpeta de descargas elegida; null = la carpeta Descargas de Windows. */
  downloadDir: string | null;
  /** Barra de favoritos: siempre, nunca o solo en las pestañas nuevas (como en Edge). */
  bookmarksBar: 'always' | 'never' | 'newtab';
  /** Ofrecer guardar las contraseñas que se escriben en los sitios. */
  offerPasswords: boolean;
  /** Dormir las pestañas que no se usan después de estos minutos (0 = nunca). */
  sleepTabsAfter: SleepMinutes;
  /** Sitios (dominios) cuyas pestañas nunca se duermen solas. */
  neverSleepSites: string[];
  /** Preguntar antes de cerrar una ventana con 2 pestañas o más. */
  confirmCloseTabs: boolean;
  /** Si a Windows le falta memoria, dormir las pestañas sin usar desde hace 1 minuto. */
  sleepWhenLowMemory: boolean;
  /** Tema elegido (id de un predeterminado o de uno propio). */
  theme: string;
  /** Temas creados por el usuario. */
  customThemes: Theme[];
}

export interface ClearOnExit {
  history: boolean;
  /** Cookies y datos de sitios. */
  siteData: boolean;
  /** Imágenes y archivos en caché. */
  cache: boolean;
}

export const SLEEP_OPTIONS = [0, 5, 15, 30, 60, 120] as const;
export type SleepMinutes = (typeof SLEEP_OPTIONS)[number];

export const DEFAULT_SETTINGS: Settings = { searchEngine: 'google', startup: 'restore', startupPages: [], clearOnExit: { history: false, siteData: false, cache: false }, downloadDir: null, bookmarksBar: 'always', offerPasswords: true, sleepTabsAfter: 15, neverSleepSites: [], confirmCloseTabs: true, sleepWhenLowMemory: true, theme: SYSTEM_THEME_ID, customThemes: [] };

/** Ruta absoluta de Windows (C:\… o \\servidor\…). */
const ABSOLUTE_WIN_PATH = /^([a-zA-Z]:\\|\\\\[^\\]+\\)/;

/** Acepta solo valores conocidos; lo demás vuelve al valor por defecto. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    searchEngine: typeof r.searchEngine === 'string' && r.searchEngine in SEARCH_ENGINES ? (r.searchEngine as SearchEngineId) : DEFAULT_SETTINGS.searchEngine,
    startup: r.startup === 'restore' || r.startup === 'newtab' || r.startup === 'pages' ? r.startup : DEFAULT_SETTINGS.startup,
    startupPages: sanitizeStartupPages(r.startupPages),
    clearOnExit: sanitizeClearOnExit(r.clearOnExit),
    downloadDir: typeof r.downloadDir === 'string' && r.downloadDir.length < 1024 && ABSOLUTE_WIN_PATH.test(r.downloadDir) ? r.downloadDir : null,
    bookmarksBar: r.bookmarksBar === 'always' || r.bookmarksBar === 'never' || r.bookmarksBar === 'newtab' ? r.bookmarksBar : DEFAULT_SETTINGS.bookmarksBar,
    offerPasswords: typeof r.offerPasswords === 'boolean' ? r.offerPasswords : DEFAULT_SETTINGS.offerPasswords,
    sleepTabsAfter: (SLEEP_OPTIONS as readonly unknown[]).includes(r.sleepTabsAfter) ? (r.sleepTabsAfter as SleepMinutes) : DEFAULT_SETTINGS.sleepTabsAfter,
    neverSleepSites: sanitizeSites(r.neverSleepSites),
    confirmCloseTabs: typeof r.confirmCloseTabs === 'boolean' ? r.confirmCloseTabs : DEFAULT_SETTINGS.confirmCloseTabs,
    sleepWhenLowMemory: typeof r.sleepWhenLowMemory === 'boolean' ? r.sleepWhenLowMemory : DEFAULT_SETTINGS.sleepWhenLowMemory,
    ...sanitizeThemes(r.theme, r.customThemes),
  };
}

/** Temas propios válidos (sin repetir, hasta el máximo) y un tema elegido que exista. */
function sanitizeThemes(theme: unknown, custom: unknown): { theme: string; customThemes: Theme[] } {
  const list: Theme[] = [];
  if (Array.isArray(custom)) {
    for (const raw of custom) {
      const t = sanitizeCustomTheme(raw);
      if (t && !list.some((x) => x.id === t.id) && list.length < MAX_CUSTOM_THEMES) list.push(t);
    }
  }
  const exists = typeof theme === 'string' && (PRESET_THEMES.some((t) => t.id === theme) || list.some((t) => t.id === theme));
  return { theme: exists ? (theme as string) : SYSTEM_THEME_ID, customThemes: list };
}

export const MAX_STARTUP_PAGES = 20;

/**
 * Una página (para abrir al iniciar o un acceso directo), tal como la escribió el usuario ("ejemplo.com", "https://…"), como dirección
 * completa; null si no es una dirección web.
 */
export function normalizePageAddress(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(\/|$)/.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!(host.includes('.') || host === 'localhost' || host.startsWith('['))) return null;
  return url.href;
}

function sanitizeStartupPages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const page = typeof v === 'string' ? normalizePageAddress(v) : null;
    if (page && !out.includes(page) && out.length < MAX_STARTUP_PAGES) out.push(page);
  }
  return out;
}

function sanitizeClearOnExit(raw: unknown): ClearOnExit {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { history: r.history === true, siteData: r.siteData === true, cache: r.cache === true };
}

/** ¿Hay algo para borrar al cerrar? */
export function hasClearOnExit(s: Pick<Settings, 'clearOnExit'>): boolean {
  return s.clearOnExit.history || s.clearOnExit.siteData || s.clearOnExit.cache;
}

export const MAX_NEVER_SLEEP_SITES = 100;

/**
 * Dominio escrito por el usuario ("music.youtube.com", "https://mail.google.com/…", "*.ejemplo.com") como dominio
 * limpio, o null si no lo es.
 */
export function normalizeSite(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch {
    return null;
  }
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/[/:?#].*$/, '').replace(/\.$/, '');
  return /^([a-z0-9-]+\.)*[a-z0-9-]+$/.test(s) && s.length <= 253 ? s : null;
}

function sanitizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const site = typeof v === 'string' ? normalizeSite(v) : null;
    if (site && !out.includes(site) && out.length < MAX_NEVER_SLEEP_SITES) out.push(site);
  }
  return out;
}

/** ¿La dirección es de uno de esos sitios (o de un subdominio)? */
export function matchesSite(url: string, sites: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}
