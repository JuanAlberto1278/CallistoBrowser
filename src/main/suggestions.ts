import type { ResolvedInput } from '../shared/omnibox';
import type { Suggestion } from '../shared/ipc';
import type { UrlRow } from './history-store';

const MAX_HISTORY = 5;
const MAX_TABS = 3;
const MAX_BOOKMARKS = 3;

/** Pestaña abierta o favorito que puede sugerirse. */
export interface OpenTabCandidate {
  id: number;
  title: string;
  url: string;
  icon: string | null;
}
export interface BookmarkCandidate {
  title: string;
  url: string;
  icon: string | null;
}

/** ¿Todas las palabras escritas aparecen en el título o en la dirección? */
export function matchesQuery(query: string, title: string, url: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${title}\n${stripScheme(url)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Misma página (sin importar www, la barra final ni el ancla). */
export function samePage(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}${x.search}`;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}

export const tabSuggestion = (t: OpenTabCandidate, detail = 'Cambiar a esta pestaña'): Suggestion => ({
  kind: 'tab',
  tabId: t.id,
  text: t.title || stripScheme(t.url),
  detail: `${detail} · ${stripScheme(t.url)}`,
  url: t.url,
  icon: t.icon,
});

/**
 * Lista de sugerencias de la barra de direcciones (lógica pura). La primera es siempre lo que hará Enter:
 * el sitio autocompletado, la dirección escrita o la búsqueda. Después, páginas del historial, y la búsqueda si no
 * era la primera. Sin sugerencias remotas: lo que se escribe no sale de Callisto hasta que se presiona Enter.
 */
export function buildSuggestions(opts: {
  text: string;
  resolved: ResolvedInput | null;
  inline: { url: string; display: string } | null;
  history: UrlRow[];
  engineName: string;
  icon: (iconUrl: string | null) => string | null;
  /** Pestañas abiertas del perfil (sin la actual). */
  tabs?: OpenTabCandidate[];
  /** Favoritos que coinciden con lo escrito. */
  bookmarks?: BookmarkCandidate[];
}): Suggestion[] {
  const { text, resolved, inline, history, engineName, icon } = opts;
  const tabs = opts.tabs ?? [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  /** `primary`: lo que hace Enter (ir a la dirección, buscar); se ofrece aunque esa dirección ya esté abierta. */
  const push = (s: Suggestion, primary = false) => {
    const key = s.kind === 'tab' ? `tab:${s.tabId}` : s.url;
    if (seen.has(key) || (!primary && s.kind !== 'tab' && seen.has(`open:${s.url}`))) return;
    seen.add(key);
    // Una dirección que ya está como pestaña abierta no se repite como historial o favorito
    if (s.kind === 'tab') seen.add(`open:${s.url}`);
    out.push(s);
  };
  const searchItem = (query: string, url: string): Suggestion => ({ kind: 'search', text: query, detail: `Buscar en ${engineName}`, url, icon: null });

  // Lo escrito ya está abierto en otra pestaña: primero, ir a esa pestaña (Enter la activa)
  const target = inline?.url ?? (resolved?.kind === 'url' || resolved?.kind === 'internal' ? resolved.url : null);
  const open = target ? tabs.find((t) => samePage(t.url, target)) : undefined;
  if (open) push(tabSuggestion(open, 'Ya está abierta: cambiar a esta pestaña'));

  if (inline) {
    const row = history.find((h) => sameSite(h.url, inline.url));
    push({ kind: 'history', text: row?.title || inline.display, detail: inline.display, url: inline.url, icon: icon(row?.iconUrl ?? null), fill: inline.display }, true);
  } else if (resolved?.kind === 'url' || resolved?.kind === 'internal') {
    push({ kind: 'url', text: resolved.url, detail: 'Ir a la dirección', url: resolved.url, icon: null, fill: text }, true);
  } else if (resolved?.kind === 'search') {
    push(searchItem(resolved.query, resolved.url), true);
  }

  // Pestañas abiertas y favoritos que coinciden, antes que el historial
  // (desde 2 letras: con una sola coincidiría casi todo)
  const query = text.trim();
  if (query.length >= 2) {
    for (const t of tabs.filter((t) => t !== open && matchesQuery(query, t.title, t.url)).slice(0, MAX_TABS)) push(tabSuggestion(t));
    for (const b of (opts.bookmarks ?? []).slice(0, MAX_BOOKMARKS)) push({ kind: 'bookmark', text: b.title || stripScheme(b.url), detail: `Favorito · ${stripScheme(b.url)}`, url: b.url, icon: b.icon, fill: b.url });
  }

  const limit = out.length + MAX_HISTORY;
  for (const h of history) {
    if (out.length >= limit) break;
    push({ kind: 'history', text: h.title || stripScheme(h.url), detail: stripScheme(h.url), url: h.url, icon: icon(h.iconUrl), fill: h.url });
  }

  if (resolved?.kind === 'search' && out[0]?.kind !== 'search') push(searchItem(resolved.query, resolved.url), true);
  return out;
}

export function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin && new URL(a).pathname === '/';
  } catch {
    return false;
  }
}
