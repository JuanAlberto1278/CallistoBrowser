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
  /** Al abrir Callisto: volver a las ventanas y pestañas de la última vez, o empezar con una pestaña nueva. */
  startup: 'restore' | 'newtab';
  /** Carpeta de descargas elegida; null = la carpeta Descargas de Windows. */
  downloadDir: string | null;
  /** Barra de favoritos: siempre, nunca o solo en las pestañas nuevas (como en Edge). */
  bookmarksBar: 'always' | 'never' | 'newtab';
  /** Ofrecer guardar las contraseñas que se escriben en los sitios. */
  offerPasswords: boolean;
  /** Dormir las pestañas que no se usan después de estos minutos (0 = nunca). */
  sleepTabsAfter: SleepMinutes;
  /** Tema elegido (id de un predeterminado o de uno propio). */
  theme: string;
  /** Temas creados por el usuario. */
  customThemes: Theme[];
}

export const SLEEP_OPTIONS = [0, 5, 15, 30, 60, 120] as const;
export type SleepMinutes = (typeof SLEEP_OPTIONS)[number];

export const DEFAULT_SETTINGS: Settings = { searchEngine: 'google', startup: 'restore', downloadDir: null, bookmarksBar: 'always', offerPasswords: true, sleepTabsAfter: 15, theme: SYSTEM_THEME_ID, customThemes: [] };

/** Ruta absoluta de Windows (C:\… o \\servidor\…). */
const ABSOLUTE_WIN_PATH = /^([a-zA-Z]:\\|\\\\[^\\]+\\)/;

/** Acepta solo valores conocidos; lo demás vuelve al valor por defecto. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    searchEngine: typeof r.searchEngine === 'string' && r.searchEngine in SEARCH_ENGINES ? (r.searchEngine as SearchEngineId) : DEFAULT_SETTINGS.searchEngine,
    startup: r.startup === 'restore' || r.startup === 'newtab' ? r.startup : DEFAULT_SETTINGS.startup,
    downloadDir: typeof r.downloadDir === 'string' && r.downloadDir.length < 1024 && ABSOLUTE_WIN_PATH.test(r.downloadDir) ? r.downloadDir : null,
    bookmarksBar: r.bookmarksBar === 'always' || r.bookmarksBar === 'never' || r.bookmarksBar === 'newtab' ? r.bookmarksBar : DEFAULT_SETTINGS.bookmarksBar,
    offerPasswords: typeof r.offerPasswords === 'boolean' ? r.offerPasswords : DEFAULT_SETTINGS.offerPasswords,
    sleepTabsAfter: (SLEEP_OPTIONS as readonly unknown[]).includes(r.sleepTabsAfter) ? (r.sleepTabsAfter as SleepMinutes) : DEFAULT_SETTINGS.sleepTabsAfter,
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
