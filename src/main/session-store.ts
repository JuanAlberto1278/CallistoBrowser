import type { NavigationEntry } from 'electron';
import type { ClosedEntry, TabSnapshot } from './closed-tabs';
import type { KeyValueStore } from './profile-store';
import { isGroupColor, sanitizeGroupTitle, type TabGroupState } from '../shared/tab-groups';

// Sesión de ventanas y pestañas guardada en la base del perfil, para volver a ella al reiniciar (o tras un cierre
// inesperado: se guarda mientras se navega, no solo al salir).

export interface SavedTab extends TabSnapshot {
  url: string;
  title: string;
  faviconKey: string | null;
  /** Grupo de la pestaña (id dentro de la ventana guardada). */
  groupId?: number | null;
}

export interface SavedWindow {
  bounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
  tabs: SavedTab[];
  active: number;
  groups?: TabGroupState[];
}

export interface SavedSession {
  version: 1;
  windows: SavedWindow[];
  closed: ClosedEntry[];
}

const KEY = 'session';
/** Entradas de historial por pestaña que se guardan (como Chrome: las más cercanas a la actual). */
export const MAX_ENTRIES = 25;

/** Recorta el historial de una pestaña alrededor de la entrada activa. */
export function trimSnapshot(s: TabSnapshot, max = MAX_ENTRIES): TabSnapshot {
  if (s.entries.length <= max) return s;
  const start = Math.max(0, Math.min(s.index - Math.floor(max / 2), s.entries.length - max));
  return { entries: s.entries.slice(start, start + max), index: s.index - start };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function cleanEntries(raw: unknown): NavigationEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: NavigationEntry[] = [];
  for (const e of raw) {
    if (!isObj(e) || !isStr(e.url) || !/^(https?:|file:|about:blank|callisto:)/i.test(e.url)) continue;
    out.push({ url: e.url, title: isStr(e.title) ? e.title : '', ...(isStr(e.pageState) ? { pageState: e.pageState } : {}) });
  }
  return out.length ? out : null;
}

function cleanSnapshot(raw: unknown): TabSnapshot | null {
  if (!isObj(raw)) return null;
  const entries = cleanEntries(raw.entries);
  if (!entries) return null;
  const index = isNum(raw.index) ? Math.max(0, Math.min(Math.trunc(raw.index), entries.length - 1)) : entries.length - 1;
  return { entries, index };
}

function cleanTab(raw: unknown): SavedTab | null {
  const snap = cleanSnapshot(raw);
  if (!snap || !isObj(raw)) return null;
  const current = snap.entries[snap.index]!;
  return {
    ...snap,
    url: current.url,
    title: isStr(raw.title) ? raw.title : current.title,
    faviconKey: isStr(raw.faviconKey) ? raw.faviconKey : null,
    groupId: isNum(raw.groupId) ? raw.groupId : null,
  };
}

function cleanWindow(raw: unknown): SavedWindow | null {
  if (!isObj(raw) || !Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs.map(cleanTab).filter((t): t is SavedTab => !!t);
  if (tabs.length === 0) return null;
  const b = isObj(raw.bounds) ? raw.bounds : {};
  const bounds = { x: isNum(b.x) ? b.x : 0, y: isNum(b.y) ? b.y : 0, width: isNum(b.width) ? b.width : 1280, height: isNum(b.height) ? b.height : 860 };
  const active = isNum(raw.active) ? Math.max(0, Math.min(Math.trunc(raw.active), tabs.length - 1)) : 0;
  const groups: TabGroupState[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!isObj(g) || !isNum(g.id) || groups.some((x) => x.id === g.id)) continue;
    groups.push({ id: g.id, title: sanitizeGroupTitle(g.title), color: isGroupColor(g.color) ? g.color : 'grey', collapsed: g.collapsed === true });
  }
  // Una pestaña solo puede pertenecer a un grupo que exista
  const ids = new Set(groups.map((g) => g.id));
  for (const t of tabs) if (t.groupId != null && !ids.has(t.groupId)) t.groupId = null;
  return { bounds, maximized: raw.maximized === true, tabs, active, groups: groups.filter((g) => tabs.some((t) => t.groupId === g.id)) };
}

function cleanClosed(raw: unknown): ClosedEntry | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'tab') {
    const tab = cleanSnapshot(raw.tab);
    return tab ? { kind: 'tab', windowId: isNum(raw.windowId) ? raw.windowId : -1, index: isNum(raw.index) ? raw.index : 0, tab } : null;
  }
  if (raw.kind === 'window' && Array.isArray(raw.tabs)) {
    const tabs = raw.tabs.map(cleanSnapshot).filter((t): t is TabSnapshot => !!t);
    return tabs.length ? { kind: 'window', tabs, active: isNum(raw.active) ? Math.max(0, Math.min(raw.active, tabs.length - 1)) : 0 } : null;
  }
  return null;
}

/** Valida una sesión leída de disco: descarta lo que no tiene la forma esperada en vez de fallar. */
export function cleanSession(raw: unknown): SavedSession {
  if (!isObj(raw)) return { version: 1, windows: [], closed: [] };
  const windows = Array.isArray(raw.windows) ? raw.windows.map(cleanWindow).filter((w): w is SavedWindow => !!w) : [];
  const closed = Array.isArray(raw.closed) ? raw.closed.map(cleanClosed).filter((c): c is ClosedEntry => !!c) : [];
  return { version: 1, windows, closed };
}

export class SessionStore {
  constructor(private readonly kv: KeyValueStore) {}

  load(): SavedSession {
    return cleanSession(this.kv.get(KEY));
  }

  save(session: SavedSession): void {
    this.kv.set(KEY, session);
  }
}
