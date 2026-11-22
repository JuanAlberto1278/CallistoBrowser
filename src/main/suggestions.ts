import type { ResolvedInput } from '../shared/omnibox';
import type { Suggestion } from '../shared/ipc';
import type { UrlRow } from './history-store';

const MAX_HISTORY = 5;

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
}): Suggestion[] {
  const { text, resolved, inline, history, engineName, icon } = opts;
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion) => {
    if (seen.has(s.url)) return;
    seen.add(s.url);
    out.push(s);
  };
  const searchItem = (query: string, url: string): Suggestion => ({ kind: 'search', text: query, detail: `Buscar en ${engineName}`, url, icon: null });

  if (inline) {
    const row = history.find((h) => sameSite(h.url, inline.url));
    push({ kind: 'history', text: row?.title || inline.display, detail: inline.display, url: inline.url, icon: icon(row?.iconUrl ?? null), fill: inline.display });
  } else if (resolved?.kind === 'url' || resolved?.kind === 'internal') {
    push({ kind: 'url', text: resolved.url, detail: 'Ir a la dirección', url: resolved.url, icon: null, fill: text });
  } else if (resolved?.kind === 'search') {
    push(searchItem(resolved.query, resolved.url));
  }

  for (const h of history) {
    if (out.length >= MAX_HISTORY + 1) break;
    push({ kind: 'history', text: h.title || stripScheme(h.url), detail: stripScheme(h.url), url: h.url, icon: icon(h.iconUrl), fill: h.url });
  }

  if (resolved?.kind === 'search' && out[0]?.kind !== 'search') push(searchItem(resolved.query, resolved.url));
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
