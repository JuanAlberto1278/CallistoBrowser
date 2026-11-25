// Accesos directos de la página de nueva pestaña (1.5): los elige el usuario (agregar, renombrar, editar, quitar).
// Los sitios más visitados se muestran además solo si el usuario lo pide. Lógica pura.
import { normalizePageAddress } from './settings';

export const MAX_SHORTCUTS = 12;
export const MAX_SHORTCUT_TITLE = 100;

export interface Shortcut {
  id: string;
  title: string;
  url: string;
}

/** Nombre para mostrar: el elegido o, si está vacío, el sitio de la dirección. */
export function shortcutTitle(title: string, url: string): string {
  const t = title.trim().slice(0, MAX_SHORTCUT_TITLE);
  if (t) return t;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Lista guardada válida (sin repetir id ni dirección, hasta el máximo). */
export function sanitizeShortcuts(raw: unknown): Shortcut[] {
  if (!Array.isArray(raw)) return [];
  const out: Shortcut[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const url = typeof r.url === 'string' ? normalizePageAddress(r.url) : null;
    const id = typeof r.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(r.id) ? r.id : null;
    if (!url || !id || out.some((s) => s.id === id || s.url === url)) continue;
    out.push({ id, title: shortcutTitle(typeof r.title === 'string' ? r.title : '', url), url });
    if (out.length >= MAX_SHORTCUTS) break;
  }
  return out;
}

export type ShortcutError = 'invalid-url' | 'duplicate' | 'full' | 'not-found';

export const SHORTCUT_ERRORS: Record<ShortcutError, string> = {
  'invalid-url': 'Escribí una dirección, por ejemplo ejemplo.com',
  duplicate: 'Ya hay un acceso directo a esa dirección.',
  full: `Podés tener hasta ${MAX_SHORTCUTS} accesos directos.`,
  'not-found': 'Ese acceso directo ya no existe.',
};

/**
 * Agrega (id null) o cambia un acceso directo. Devuelve la lista nueva o el motivo por el que no se pudo.
 */
export function saveShortcut(list: readonly Shortcut[], id: string | null, title: string, address: string, newId: () => string): Shortcut[] | ShortcutError {
  const url = normalizePageAddress(address);
  if (!url) return 'invalid-url';
  if (list.some((s) => s.url === url && s.id !== id)) return 'duplicate';
  const item = { title: shortcutTitle(title, url), url };
  if (id === null) {
    if (list.length >= MAX_SHORTCUTS) return 'full';
    return [...list, { id: newId(), ...item }];
  }
  if (!list.some((s) => s.id === id)) return 'not-found';
  return list.map((s) => (s.id === id ? { ...s, ...item } : s));
}

/** Sitio (sin www.) de una dirección, para no repetir en "más visitados" lo que ya es un acceso directo. */
export function shortcutHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
