// Configuración del perfil (lógica pura, compartida por el proceso principal y la página de configuración).

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
}

export const DEFAULT_SETTINGS: Settings = { searchEngine: 'google', startup: 'restore' };

/** Acepta solo valores conocidos; lo demás vuelve al valor por defecto. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    searchEngine: typeof r.searchEngine === 'string' && r.searchEngine in SEARCH_ENGINES ? (r.searchEngine as SearchEngineId) : DEFAULT_SETTINGS.searchEngine,
    startup: r.startup === 'restore' || r.startup === 'newtab' ? r.startup : DEFAULT_SETTINGS.startup,
  };
}
