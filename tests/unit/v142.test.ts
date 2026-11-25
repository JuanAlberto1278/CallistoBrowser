import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/main/db';
import { HistoryStore, type HistoryChange } from '../../src/main/history-store';
import { ClosedTabs } from '../../src/main/closed-tabs';
import { cleanSession } from '../../src/main/session-store';
import {
  browsingDataPlan,
  downloadDelta,
  manifestCommands,
  matchDownloads,
  normalizeShortcut,
  omniboxInput,
  omniboxText,
  shortcutOfInput,
  toChromeDownload,
  toElectronProxy,
} from '../../src/main/extensions/api-helpers';
import { CALLISTO_APIS, NOT_ON_WINDOWS_APIS, UNSUPPORTED_APIS, unsupportedPermissions } from '../../src/shared/extensions';
import type { DownloadEntry } from '../../src/shared/downloads';

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

describe('chrome.commands: atajos', () => {
  it('normaliza los del manifiesto como Chrome (Ctrl o Alt obligatorio, una tecla)', () => {
    expect(normalizeShortcut('Ctrl+Shift+Y')).toBe('Ctrl+Shift+Y');
    expect(normalizeShortcut('shift+ctrl+y')).toBe('Ctrl+Shift+Y');
    expect(normalizeShortcut('Alt+Comma')).toBe('Alt+Comma');
    expect(normalizeShortcut('Command+Shift+5')).toBe('Ctrl+Shift+5');
    expect(normalizeShortcut('Ctrl+F5')).toBe('Ctrl+F5');
    expect(normalizeShortcut('MediaPlayPause')).toBe('MediaPlayPause');
    expect(normalizeShortcut('Shift+Y')).toBeNull(); // sin Ctrl ni Alt
    expect(normalizeShortcut('Ctrl+Y+U')).toBeNull(); // dos teclas
    expect(normalizeShortcut('MacCtrl+Y')).toBeNull();
    expect(normalizeShortcut('Ctrl+Tecla')).toBeNull();
    expect(normalizeShortcut(42)).toBeNull();
  });

  it('una tecla presionada en la misma forma', () => {
    const key = (k: string, code: string, mods: Partial<{ control: boolean; alt: boolean; shift: boolean }>) => shortcutOfInput({ key: k, code, control: false, alt: false, shift: false, meta: false, ...mods });
    expect(key('Y', 'KeyY', { control: true, shift: true })).toBe('Ctrl+Shift+Y');
    expect(key(',', 'Comma', { alt: true })).toBe('Alt+Comma');
    expect(key('%', 'Digit5', { control: true, shift: true })).toBe('Ctrl+Shift+5'); // la tecla, no el carácter
    expect(key('ArrowUp', 'ArrowUp', { control: true })).toBe('Ctrl+Up');
    expect(key('Shift', 'ShiftLeft', { shift: true })).toBeNull();
  });

  it('un atajo que ya usa Callisto u otra extensión queda sin asignar', () => {
    const manifest = {
      commands: {
        _execute_action: { suggested_key: { default: 'Ctrl+Shift+E', windows: 'Alt+E' } },
        abrir: { suggested_key: { default: 'Ctrl+T' }, description: 'Abrir' },
        otra: { description: 'Sin atajo' },
      },
    };
    const list = manifestCommands(manifest, (s) => s === 'Ctrl+T');
    expect(list).toEqual([
      { name: '_execute_action', description: '', shortcut: 'Alt+E' }, // el de Windows gana
      { name: 'abrir', description: 'Abrir', shortcut: '' },
      { name: 'otra', description: 'Sin atajo', shortcut: '' },
    ]);
    expect(manifestCommands({}, () => false)).toEqual([]);
  });
});

describe('chrome.omnibox', () => {
  it('la palabra clave seguida de un espacio', () => {
    expect(omniboxInput('aud hola mundo', 'aud')).toBe('hola mundo');
    expect(omniboxInput('AUD hola', 'aud')).toBe('hola');
    expect(omniboxInput('aud ', 'aud')).toBe('');
    expect(omniboxInput('audio', 'aud')).toBeNull();
    expect(omniboxInput('aud', 'aud')).toBeNull();
  });
  it('el texto de una sugerencia sin su marcado XML', () => {
    expect(omniboxText('Buscar <match>hola</match> en <url>x.com</url> <dim>(3)</dim>')).toBe('Buscar hola en x.com (3)');
    expect(omniboxText('a &lt;b&gt; &amp; c')).toBe('a <b> & c');
    expect(omniboxText(undefined)).toBe('');
  });
});

describe('chrome.proxy → Electron', () => {
  it('modos y servidores', () => {
    expect(toElectronProxy({ mode: 'direct' })).toEqual({ mode: 'direct' });
    expect(toElectronProxy({ mode: 'fixed_servers', rules: { singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: 1080 }, bypassList: ['localhost', '*.local'] } })).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost,*.local',
    });
    expect(toElectronProxy({ mode: 'fixed_servers', rules: { proxyForHttp: { host: 'p.com', port: 8080 }, proxyForHttps: { host: 's.com' } } }).proxyRules).toBe('http=http://p.com:8080;https=http://s.com');
    expect(toElectronProxy({ mode: 'pac_script', pacScript: { url: 'https://x.com/proxy.pac' } })).toEqual({ mode: 'pac_script', pacScript: 'https://x.com/proxy.pac' });
    expect(toElectronProxy({ mode: 'pac_script', pacScript: { data: 'function FindProxyForURL(){return "DIRECT"}' } }).pacScript).toMatch(/^data:application\/x-ns-proxy-autoconfig;base64,/);
  });
  it('lo que no es válido se rechaza (como Chrome)', () => {
    expect(() => toElectronProxy({ mode: 'raro' })).toThrow('Invalid proxy mode.');
    expect(() => toElectronProxy({ mode: 'fixed_servers', rules: { singleProxy: { host: 'a b' } } })).toThrow('Invalid proxy server host.');
    expect(() => toElectronProxy({ mode: 'fixed_servers', rules: {} })).toThrow('Invalid proxy rules.');
    expect(() => toElectronProxy({ mode: 'pac_script', pacScript: { url: 'javascript:alert(1)' } })).toThrow('Invalid PAC script.');
  });
});

describe('chrome.downloads sobre las descargas de Callisto', () => {
  const entry = (over: Partial<DownloadEntry>): DownloadEntry => ({
    id: 1,
    url: 'https://a.com/x.zip',
    site: 'a.com',
    filename: 'x.zip',
    path: 'C:\\Descargas\\x.zip',
    state: 'completed',
    receivedBytes: 100,
    totalBytes: 100,
    bytesPerSecond: 0,
    canResume: false,
    error: null,
    startTime: Date.UTC(2026, 10, 24),
    exists: true,
    ...over,
  });

  it('estados como en Chrome', () => {
    expect(toChromeDownload(entry({}))).toMatchObject({ id: 1, state: 'complete', filename: 'C:\\Descargas\\x.zip', exists: true, danger: 'safe' });
    expect(toChromeDownload(entry({ state: 'paused' }))).toMatchObject({ state: 'in_progress', paused: true });
    expect(toChromeDownload(entry({ state: 'cancelled' }))).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED' });
    expect(toChromeDownload(entry({ state: 'interrupted' }))).toMatchObject({ state: 'interrupted', error: 'NETWORK_FAILED' });
    expect(toChromeDownload(entry({ totalBytes: 0 })).totalBytes).toBe(-1);
  });

  it('búsqueda, orden y límite', () => {
    const items = [entry({ id: 1, startTime: 1000 }), entry({ id: 2, url: 'https://b.com/y.pdf', path: 'C:\\y.pdf', startTime: 3000 }), entry({ id: 3, state: 'paused', startTime: 2000 })].map(toChromeDownload);
    expect(matchDownloads(items, { id: 2 }).map((d) => d.id)).toEqual([2]);
    expect(matchDownloads(items, { state: 'complete' }).map((d) => d.id)).toEqual([1, 2]);
    expect(matchDownloads(items, { urlRegex: 'b\\.com' }).map((d) => d.id)).toEqual([2]);
    expect(matchDownloads(items, { query: ['zip', '-paused'] }).map((d) => d.id)).toEqual([1, 3]);
    expect(matchDownloads(items, { orderBy: ['-startTime'], limit: 2 }).map((d) => d.id)).toEqual([2, 3]);
    expect(() => matchDownloads(items, { urlRegex: '(' })).toThrow('Invalid regular expression.');
  });

  it('onChanged: solo lo que cambió (no el progreso)', () => {
    const a = toChromeDownload(entry({ state: 'in_progress', receivedBytes: 10 }));
    expect(downloadDelta(a, toChromeDownload(entry({ state: 'in_progress', receivedBytes: 50 })))).toBeNull();
    expect(downloadDelta(a, toChromeDownload(entry({})))).toEqual({ id: 1, state: { previous: 'in_progress', current: 'complete' } });
  });
});

describe('chrome.browsingData', () => {
  it('qué se borra', () => {
    expect(browsingDataPlan({ since: 0 }, { history: true, cookies: true, localStorage: true, cache: true })).toEqual({ history: true, downloads: false, storage: ['cookies', 'localStorage'], cache: true });
    expect(browsingDataPlan({ since: 123 }, { history: true, cacheStorage: true })).toEqual({ history: true, downloads: false, storage: [], cache: true });
    expect(browsingDataPlan({}, { formData: true, appcache: true })).toEqual({ history: false, downloads: false, storage: [], cache: false });
  });
  it('nunca borra de más ni contraseñas', () => {
    expect(() => browsingDataPlan({ since: 123 }, { cookies: true })).toThrow(/todo el período/);
    expect(() => browsingDataPlan({ since: 0 }, { passwords: true })).toThrow(/contraseñas/);
  });
});

describe('historial para chrome.history', () => {
  it('direcciones por período y texto, visitas y eventos', () => {
    let now = 10_000;
    const h = new HistoryStore(memoryDb(), () => now);
    const changes: HistoryChange[] = [];
    h.onChange((c) => changes.push(c));
    h.addVisit('https://a.com/', { title: 'Inicio A' });
    now = 20_000;
    h.addVisit('https://b.com/', { title: 'Bé', typed: true });
    h.addVisit('https://a.com/', { time: 30_000 });
    expect(h.urls({ startTime: 0 }).map((r) => [r.url, r.visitCount, r.lastVisit])).toEqual([
      ['https://a.com/', 2, 30_000],
      ['https://b.com/', 1, 20_000],
    ]);
    expect(h.urls({ text: 'inicio', startTime: 0 }).map((r) => r.url)).toEqual(['https://a.com/']);
    expect(h.urls({ startTime: 25_000 }).map((r) => r.url)).toEqual(['https://a.com/']);
    expect(h.urls({ text: '%', startTime: 0 })).toEqual([]); // el texto no es sintaxis de LIKE
    expect(h.visitsOf('https://a.com/').map((v) => v.time)).toEqual([10_000, 30_000]);
    expect(h.visitsOf('https://b.com/')[0]!.typed).toBe(true);
    h.deleteRange(15_000, 25_000);
    h.deleteUrl('https://a.com/');
    h.deleteAll();
    expect(changes).toEqual([
      { type: 'visited', url: 'https://a.com/' },
      { type: 'visited', url: 'https://b.com/' },
      { type: 'visited', url: 'https://a.com/' },
      { type: 'removed', allHistory: false, urls: ['https://b.com/'] },
      { type: 'removed', allHistory: false, urls: ['https://a.com/'] },
      { type: 'removed', allHistory: true, urls: [] },
    ]);
  });
});

describe('cerradas recientemente para chrome.sessions', () => {
  it('cada una recuerda cuándo se cerró, también al reiniciar', () => {
    const before = Date.now();
    const c = new ClosedTabs();
    c.push({ kind: 'tab', windowId: 1, index: 0, tab: { entries: [{ url: 'https://a.com/', title: 'A', pageState: '' }], index: 0 } });
    const [e] = c.entries();
    expect(e!.time).toBeGreaterThanOrEqual(before);
    const restored = cleanSession({ version: 1, windows: [], closed: c.entries() });
    expect(restored.closed[0]!.time).toBe(e!.time);
    expect(cleanSession({ version: 1, windows: [], closed: [{ ...e, time: 'x' }] }).closed[0]!.time).toBeUndefined();
  });
});

describe('APIs que faltan', () => {
  it('las de ChromeOS no se avisan ni cuentan como faltantes; las completadas tampoco', () => {
    for (const p of NOT_ON_WINDOWS_APIS) expect(UNSUPPORTED_APIS[p], p).toBeUndefined();
    for (const p of CALLISTO_APIS) expect(UNSUPPORTED_APIS[p], p).toBeUndefined();
    expect(unsupportedPermissions({ permissions: ['history', 'wallpaper', 'printing', 'tts'], optional_permissions: ['debugger'] })).toEqual([
      { permission: 'tts', what: 'texto a voz', optional: false },
      { permission: 'debugger', what: 'depurar páginas', optional: true },
    ]);
  });
});
