// Páginas internas de Callisto (callisto://history, callisto://settings).

export const INTERNAL_PAGES = ['history', 'settings'] as const;
export type InternalPage = (typeof INTERNAL_PAGES)[number];

export const INTERNAL_PAGE_TITLES: Record<InternalPage, string> = {
  history: 'Historial',
  settings: 'Configuración',
};

export function internalUrl(page: InternalPage): string {
  return `callisto://${page}/`;
}

/** Página interna de una URL, o null si no es una página interna conocida. */
export function internalPageOf(url: string): InternalPage | null {
  const m = /^callisto:\/\/([a-z]+)(?:[/?#]|$)/i.exec(url);
  const page = m?.[1]?.toLowerCase();
  return page && (INTERNAL_PAGES as readonly string[]).includes(page) ? (page as InternalPage) : null;
}
