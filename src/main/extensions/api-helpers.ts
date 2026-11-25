// Lógica pura de las APIs de extensiones que agrega Callisto en la 1.4.2 (sin Electron: la prueban las pruebas
// unitarias). El registro de las APIs está en browser-apis.ts y el lado de las extensiones en src/preload/extension-apis.ts.
import type { DownloadEntry } from '../../shared/downloads';

// ---------------------------------------------------------------- chrome.commands: atajos de teclado

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;
const NAMED_KEYS: Record<string, string> = {
  comma: 'Comma',
  period: 'Period',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  insert: 'Insert',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  medianexttrack: 'MediaNextTrack',
  mediaprevtrack: 'MediaPrevTrack',
  mediaplaypause: 'MediaPlayPause',
  mediastop: 'MediaStop',
};

/**
 * Atajo del manifiesto ("Ctrl+Shift+Y", "Alt+Comma") en su forma canónica, o null si no es válido en Windows. Como en
 * Chrome: Ctrl o Alt obligatorio (Shift solo no), una sola tecla (A-Z, 0-9, F1-F12 o una con nombre).
 */
export function normalizeShortcut(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 60) return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key: string | null = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'command') mods.add('Ctrl');
    else if (lower === 'alt') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else if (lower === 'macctrl' || lower === 'search') return null;
    else {
      if (key) return null;
      if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase();
      else if (/^f([1-9]|1[0-2])$/i.test(p)) key = p.toUpperCase();
      else if (NAMED_KEYS[lower]) key = NAMED_KEYS[lower]!;
      else return null;
    }
  }
  if (!key) return null;
  const media = key.startsWith('Media');
  if (!media && !mods.has('Ctrl') && !mods.has('Alt')) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/** Tecla presionada (de 'before-input-event') en la forma canónica de los atajos, o null si no puede ser un atajo. */
export function shortcutOfInput(input: { key: string; code?: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }): string | null {
  let key: string | null = null;
  const code = input.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(input.key)) key = input.key;
  else {
    const byKey: Record<string, string> = {
      ',': 'Comma',
      '.': 'Period',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ' ': 'Space',
      Insert: 'Insert',
      Delete: 'Delete',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      MediaTrackNext: 'MediaNextTrack',
      MediaTrackPrevious: 'MediaPrevTrack',
      MediaPlayPause: 'MediaPlayPause',
      MediaStop: 'MediaStop',
    };
    key = byKey[input.key] ?? (code === 'Comma' ? 'Comma' : code === 'Period' ? 'Period' : null);
  }
  if (!key) return null;
  const mods = [input.control || input.meta ? 'Ctrl' : null, input.alt ? 'Alt' : null, input.shift ? 'Shift' : null].filter(Boolean);
  return [...mods, key].join('+');
}

export interface ExtensionCommand {
  name: string;
  description: string;
  /** Atajo asignado ('' = ninguno: no tenía, no es válido o choca con uno de Callisto o de otra extensión). */
  shortcut: string;
}

/**
 * Comandos de un manifiesto con su atajo para Windows (suggested_key.windows o .default). `taken` dice si un atajo ya
 * está usado (por Callisto o por otra extensión): ese comando queda sin atajo, como en Chrome.
 */
export function manifestCommands(manifest: { commands?: unknown }, taken: (shortcut: string) => boolean): ExtensionCommand[] {
  const commands = manifest.commands;
  if (!commands || typeof commands !== 'object') return [];
  const out: ExtensionCommand[] = [];
  for (const [name, details] of Object.entries(commands as Record<string, unknown>)) {
    const d = (details ?? {}) as { description?: unknown; suggested_key?: unknown };
    const keys = (d.suggested_key ?? {}) as { windows?: unknown; default?: unknown };
    const suggested = typeof d.suggested_key === 'string' ? d.suggested_key : (keys.windows ?? keys.default);
    const shortcut = normalizeShortcut(suggested);
    out.push({ name, description: typeof d.description === 'string' ? d.description : '', shortcut: shortcut && !taken(shortcut) ? shortcut : '' });
  }
  return out;
}

// ---------------------------------------------------------------- chrome.omnibox

/** Texto de una sugerencia de una extensión, sin su marcado (<match>, <url>, <dim>) ni entidades XML. */
export function omniboxText(description: unknown): string {
  if (typeof description !== 'string') return '';
  return description
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .slice(0, 500);
}

/** ¿Lo escrito empieza con la palabra clave de una extensión seguida de un espacio? Devuelve el resto. */
export function omniboxInput(text: string, keyword: string): string | null {
  const k = keyword.trim().toLowerCase();
  if (!k || text.length <= k.length || text[k.length] !== ' ') return null;
  return text.slice(0, k.length).toLowerCase() === k ? text.slice(k.length + 1) : null;
}

// ---------------------------------------------------------------- chrome.proxy

export type ElectronProxyConfig = { mode: 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system'; pacScript?: string; proxyRules?: string; proxyBypassRules?: string };

/** Configuración de chrome.proxy → la de session.setProxy. Lanza un error (como Chrome) si no es válida. */
export function toElectronProxy(value: unknown): ElectronProxyConfig {
  const v = (value ?? {}) as { mode?: unknown; pacScript?: { url?: unknown; data?: unknown }; rules?: Record<string, unknown> };
  const server = (s: unknown): string => {
    const p = (s ?? {}) as { scheme?: unknown; host?: unknown; port?: unknown };
    if (typeof p.host !== 'string' || !/^[\w.-]+$|^\[[0-9a-f:]+\]$/i.test(p.host)) throw new Error('Invalid proxy server host.');
    const scheme = typeof p.scheme === 'string' ? p.scheme : 'http';
    if (!['http', 'https', 'quic', 'socks4', 'socks5'].includes(scheme)) throw new Error('Invalid proxy server scheme.');
    const port = typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? `:${p.port}` : '';
    return `${scheme}://${p.host}${port}`;
  };
  switch (v.mode) {
    case 'direct':
    case 'auto_detect':
    case 'system':
      return { mode: v.mode };
    case 'pac_script': {
      const url = v.pacScript?.url;
      const data = v.pacScript?.data;
      if (typeof url === 'string' && /^(https?|file|data):/i.test(url)) return { mode: 'pac_script', pacScript: url };
      if (typeof data === 'string') return { mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(data).toString('base64')}` };
      throw new Error('Invalid PAC script.');
    }
    case 'fixed_servers': {
      const r = v.rules ?? {};
      let rules: string;
      if (r.singleProxy) rules = server(r.singleProxy);
      else {
        const parts: string[] = [];
        for (const [key, scheme] of [['proxyForHttp', 'http'], ['proxyForHttps', 'https'], ['proxyForFtp', 'ftp']] as const) if (r[key]) parts.push(`${scheme}=${server(r[key])}`);
        if (r.fallbackProxy) parts.push(server(r.fallbackProxy));
        if (!parts.length) throw new Error('Invalid proxy rules.');
        rules = parts.join(';');
      }
      const bypass = Array.isArray(r.bypassList) ? r.bypassList.filter((b): b is string => typeof b === 'string' && b.length < 300).join(',') : undefined;
      return { mode: 'fixed_servers', proxyRules: rules, ...(bypass ? { proxyBypassRules: bypass } : {}) };
    }
    default:
      throw new Error('Invalid proxy mode.');
  }
}

// ---------------------------------------------------------------- chrome.downloads

export interface ChromeDownloadItem {
  id: number;
  url: string;
  finalUrl: string;
  referrer: string;
  filename: string;
  incognito: boolean;
  danger: 'safe';
  mime: string;
  startTime: string;
  state: 'in_progress' | 'interrupted' | 'complete';
  paused: boolean;
  canResume: boolean;
  error?: 'USER_CANCELED' | 'NETWORK_FAILED';
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  exists: boolean;
}

/** Una descarga de Callisto como la ve chrome.downloads. */
export function toChromeDownload(e: DownloadEntry): ChromeDownloadItem {
  const state = e.state === 'completed' ? 'complete' : e.state === 'interrupted' || e.state === 'cancelled' ? 'interrupted' : 'in_progress';
  return {
    id: e.id,
    url: e.url,
    finalUrl: e.url,
    referrer: '',
    filename: e.path,
    incognito: false,
    danger: 'safe',
    mime: '',
    startTime: new Date(e.startTime).toISOString(),
    state,
    paused: e.state === 'paused',
    canResume: e.canResume,
    ...(state === 'interrupted' ? { error: e.state === 'cancelled' ? ('USER_CANCELED' as const) : ('NETWORK_FAILED' as const) } : {}),
    bytesReceived: e.receivedBytes,
    totalBytes: e.totalBytes || -1,
    fileSize: e.totalBytes || -1,
    exists: state === 'complete' ? e.exists : true,
  };
}

/** chrome.downloads.search / erase: las descargas que coinciden con la consulta. */
export function matchDownloads(items: ChromeDownloadItem[], q: unknown): ChromeDownloadItem[] {
  const query = (q ?? {}) as Record<string, unknown>;
  const regex = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 500) return null;
    try {
      return new RegExp(v);
    } catch {
      throw new Error('Invalid regular expression.');
    }
  };
  const urlRe = regex(query.urlRegex);
  const fileRe = regex(query.filenameRegex);
  const terms = Array.isArray(query.query) ? query.query.filter((t): t is string => typeof t === 'string') : [];
  let out = items.filter(
    (d) =>
      (query.id === undefined || d.id === query.id) &&
      (query.url === undefined || d.url === query.url) &&
      (query.filename === undefined || d.filename === query.filename) &&
      (query.state === undefined || d.state === query.state) &&
      (query.paused === undefined || d.paused === query.paused) &&
      (query.exists === undefined || d.exists === query.exists) &&
      (!urlRe || urlRe.test(d.url)) &&
      (!fileRe || fileRe.test(d.filename)) &&
      terms.every((t) => (t.startsWith('-') ? !`${d.url} ${d.filename}`.toLowerCase().includes(t.slice(1).toLowerCase()) : `${d.url} ${d.filename}`.toLowerCase().includes(t.toLowerCase()))),
  );
  const order = Array.isArray(query.orderBy) ? query.orderBy[0] : undefined;
  if (order === '-startTime') out = [...out].sort((a, b) => b.startTime.localeCompare(a.startTime) || b.id - a.id);
  else if (order === 'startTime') out = [...out].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id - b.id);
  const limit = typeof query.limit === 'number' && query.limit > 0 ? query.limit : 1000;
  return out.slice(0, limit);
}

/** Lo que cambió en una descarga (para chrome.downloads.onChanged): solo los campos que Chrome informa. */
export function downloadDelta(before: ChromeDownloadItem, after: ChromeDownloadItem): Record<string, unknown> | null {
  const delta: Record<string, unknown> = { id: after.id };
  let changed = false;
  for (const key of ['url', 'finalUrl', 'filename', 'mime', 'state', 'paused', 'canResume', 'error', 'totalBytes', 'fileSize', 'exists'] as const) {
    if (before[key] !== after[key]) {
      delta[key] = { previous: before[key], current: after[key] };
      changed = true;
    }
  }
  return changed ? delta : null;
}

// ---------------------------------------------------------------- chrome.browsingData

export type ElectronDataType = 'cookies' | 'localStorage' | 'indexedDB' | 'serviceWorkers' | 'fileSystems' | 'webSQL' | 'cache';

export interface BrowsingDataPlan {
  history: boolean;
  downloads: boolean;
  /** Datos de sitios (se borran enteros: Electron no puede borrarlos por período). */
  storage: ElectronDataType[];
  cache: boolean;
}

/**
 * Qué borrar para chrome.browsingData.remove. Los datos de sitios (cookies, almacenamiento) solo se pueden borrar
 * enteros: si la extensión pide un período, se rechaza en vez de borrar de más (cerraría sesiones que no pidió).
 * Las contraseñas no se borran desde una extensión (decisión de Callisto).
 */
export function browsingDataPlan(options: unknown, dataToRemove: unknown): BrowsingDataPlan {
  const o = (options ?? {}) as { since?: unknown };
  const d = (dataToRemove ?? {}) as Record<string, unknown>;
  const on = (k: string) => d[k] === true;
  if (on('passwords')) throw new Error('Callisto no permite que una extensión borre las contraseñas guardadas.');
  const storage: ElectronDataType[] = [];
  for (const [k, t] of [
    ['cookies', 'cookies'],
    ['localStorage', 'localStorage'],
    ['indexedDB', 'indexedDB'],
    ['serviceWorkers', 'serviceWorkers'],
    ['fileSystems', 'fileSystems'],
    ['webSQL', 'webSQL'],
  ] as const)
    if (on(k)) storage.push(t);
  const since = typeof o.since === 'number' ? o.since : 0;
  if (storage.length && since > 0) throw new Error('Callisto solo puede borrar cookies y datos de sitios de todo el período (since: 0).');
  return { history: on('history'), downloads: on('downloads'), storage, cache: on('cache') || on('cacheStorage') };
}
