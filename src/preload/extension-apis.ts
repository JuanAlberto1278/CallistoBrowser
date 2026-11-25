// Preload de las páginas y service workers de las EXTENSIONES (chrome-extension://). En las páginas web no hace nada.
//
// 1. `browser` = `chrome` (como en Chrome). Medido en la V0.1: Chromium 156 trae un `browser` propio e incompleto, y las
//    extensiones que lo usan (o usan webextension-polyfill) fallaban al arrancar (uBlock Origin Lite, AdGuard, 1Password).
// 2. APIs que agrega Callisto sobre sus propios sistemas: chrome.bookmarks (favoritos), chrome.tabGroups y
//    chrome.tabs.group/ungroup (grupos de pestañas). Usan el mismo canal que electron-chrome-extensions ("crx-msg"), así
//    que el proceso principal valida la extensión y sus permisos igual que para el resto de las APIs.
// 3. (1.4.2) Las que faltaban o existían sin funcionar: history, sessions, search, browsingData, identity, pageCapture,
//    proxy, system.display, downloads, topSites, omnibox, más funciones de tabs (captureVisibleTab, move, duplicate,
//    discard, highlight, detectLanguage) y runtime.onInstalled / onStartup. Ver src/main/extensions/browser-apis.ts.
import { contextBridge, ipcRenderer } from 'electron';

const inExtension = process.type === 'service-worker' || (typeof location !== 'undefined' && location.protocol === 'chrome-extension:');

const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

const bridge = {
  invoke: (extensionId: string, name: string, ...args: unknown[]) => ipcRenderer.invoke('crx-msg', extensionId, name, ...args),
  addListener: (extensionId: string, name: string, cb: (...args: unknown[]) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
      ipcRenderer.send('crx-add-listener', extensionId, name);
      const all = set;
      ipcRenderer.on(`crx-${name}`, (_e, ...args: unknown[]) => all.forEach((f) => f(...args)));
    }
    set.add(cb);
  },
  removeListener: (name: string, cb: (...args: unknown[]) => void) => {
    listeners.get(name)?.delete(cb);
  },
};

type Bridge = typeof bridge;

function mainWorld(b: Bridge): void {
  const g = globalThis as unknown as { chrome?: Record<string, unknown> & { runtime?: { id?: string; getManifest?: () => { permissions?: unknown[] }; lastError?: unknown } }; browser?: unknown };
  const chrome = g.chrome;
  if (!chrome) return;
  try {
    if (g.browser !== chrome) Object.defineProperty(globalThis, 'browser', { value: chrome, configurable: true, writable: true, enumerable: false });
  } catch (e) {
    console.error('callisto: alias browser = chrome', e);
  }
  const id = chrome.runtime?.id;
  if (!id) return;
  const manifest = (chrome.runtime?.getManifest?.() ?? {}) as { permissions?: unknown[]; omnibox?: { keyword?: unknown } };
  const permissions = (manifest.permissions ?? []).filter((p): p is string => typeof p === 'string');
  const has = (p: string) => permissions.includes(p);
  /** Reemplaza (o agrega) una propiedad: algunas existen en Chromium sin funcionar (downloads, proxy, topSites…). */
  const def = (obj: object | undefined, key: string, value: unknown) => {
    if (!obj) return;
    try {
      Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: true });
      if ((obj as Record<string, unknown>)[key] === value) return;
    } catch {
      /* Chromium no deja reemplazar algunos espacios de nombres: se reemplaza cada función */
    }
    const current = (obj as Record<string, unknown>)[key];
    if (current && typeof current === 'object' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        try {
          Object.defineProperty(current, k, { value: v, configurable: true, writable: true, enumerable: true });
        } catch (e) {
          console.error(`callisto: chrome.${key}.${k}`, e);
        }
      }
    }
  };

  /** Función de la API: promesa, o callback si se pasa uno (como en Chrome). */
  const call =
    (name: string, map?: (r: unknown) => unknown) =>
    (...args: unknown[]): Promise<unknown> | undefined => {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (r?: unknown) => void) : null;
      // El error como lo da Chrome: sin el "Error invoking remote method 'crx-msg': Error: " de Electron
      const clean = (e: unknown) => new Error(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
      const raw = b.invoke(id, name, ...args).catch((e: unknown) => Promise.reject(clean(e)));
      const p = map ? raw.then(map) : raw;
      if (!cb) return p;
      p.then(
        (r) => cb(r),
        (e: Error) => {
          // Con callback, Chrome deja el error en chrome.runtime.lastError mientras corre el callback
          const rt = chrome.runtime as Record<string, unknown> | undefined;
          try {
            if (rt) Object.defineProperty(rt, 'lastError', { value: { message: e.message }, configurable: true });
            cb(undefined);
          } finally {
            if (rt) delete rt.lastError;
          }
        },
      );
      return undefined;
    };
  /** Evento de la API. `adapt` cambia los argumentos que llegan (p. ej. agrega la función suggest del omnibox). */
  const event = (name: string, adapt?: (args: unknown[]) => unknown[]) => {
    const fns = new Set<(...a: unknown[]) => void>();
    let attached = false;
    const dispatch = (...raw: unknown[]) => {
      const a = adapt ? adapt(raw) : raw;
      fns.forEach((f) => {
        try {
          f(...a);
        } catch (e) {
          console.error(e);
        }
      });
    };
    return {
      addListener(fn: (...a: unknown[]) => void) {
        fns.add(fn);
        if (!attached) {
          attached = true;
          b.addListener(id, name, dispatch);
        }
      },
      removeListener(fn: (...a: unknown[]) => void) {
        fns.delete(fn);
      },
      hasListener: (fn: (...a: unknown[]) => void) => fns.has(fn),
      hasListeners: () => fns.size > 0,
    };
  };

  if (permissions.includes('bookmarks') && !chrome.bookmarks) {
    chrome.bookmarks = {
      MAX_WRITE_OPERATIONS_PER_HOUR: 1_000_000,
      MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000,
      create: call('bookmarks.create'),
      get: call('bookmarks.get'),
      getChildren: call('bookmarks.getChildren'),
      getRecent: call('bookmarks.getRecent'),
      getSubTree: call('bookmarks.getSubTree'),
      getTree: call('bookmarks.getTree'),
      move: call('bookmarks.move'),
      remove: call('bookmarks.remove'),
      removeTree: call('bookmarks.removeTree'),
      search: call('bookmarks.search'),
      update: call('bookmarks.update'),
      onCreated: event('bookmarks.onCreated'),
      onRemoved: event('bookmarks.onRemoved'),
      onChanged: event('bookmarks.onChanged'),
      onMoved: event('bookmarks.onMoved'),
      onChildrenReordered: event('bookmarks.onChildrenReordered'),
      onImportBegan: event('bookmarks.onImportBegan'),
      onImportEnded: event('bookmarks.onImportEnded'),
    };
  }
  const colors = { GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green', PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange' };
  if (permissions.includes('tabGroups') && !chrome.tabGroups) {
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: -1,
      Color: colors,
      get: call('tabGroups.get'),
      query: call('tabGroups.query'),
      update: call('tabGroups.update'),
      move: call('tabGroups.move'),
      onCreated: event('tabGroups.onCreated'),
      onRemoved: event('tabGroups.onRemoved'),
      onUpdated: event('tabGroups.onUpdated'),
      onMoved: event('tabGroups.onMoved'),
    };
  }
  const tabs = chrome.tabs as Record<string, unknown> | undefined;
  if (tabs && !tabs.group) {
    tabs.group = call('tabs.group');
    tabs.ungroup = call('tabs.ungroup');
    if (tabs.TAB_ID_NONE === undefined) tabs.TAB_ID_NONE = -1;
  }

  // ---- 1.4.2
  // El preload de electron-chrome-extensions corre después de este, redefine algunos espacios de nombres con funciones
  // que no hacen nada y responden como si hubieran funcionado (downloads, topSites, contextMenus.update) y termina con
  // Object.freeze(chrome). Lo que esté en `late` se vuelve a poner justo antes de ese freeze.
  const late: Array<() => void> = [];
  const nativeFreeze = Object.freeze;
  Object.freeze = function <T>(o: T): Readonly<T> {
    if ((o as unknown) === chrome) {
      Object.freeze = nativeFreeze;
      for (const f of late) {
        try {
          f();
        } catch (e) {
          console.error('callisto: APIs de extensiones', e);
        }
      }
    }
    return nativeFreeze(o);
  } as typeof Object.freeze;
  late.push(() => {
    const menus = chrome.contextMenus as Record<string, unknown> | undefined;
    if (menus) def(menus, 'update', call('contextMenus.update'));
  });
  if (tabs) {
    for (const fn of ['captureVisibleTab', 'move', 'duplicate', 'discard', 'highlight', 'detectLanguage']) if (typeof tabs[fn] !== 'function') tabs[fn] = call(`tabs.${fn}`);
  }
  // Instalación, actualización y arranque: los avisa Callisto (Chromium no lo hace en Callisto)
  const runtime = chrome.runtime as Record<string, unknown> | undefined;
  def(runtime, 'onInstalled', event('runtime.onInstalled'));
  def(runtime, 'onStartup', event('runtime.onStartup'));

  if (has('history')) {
    def(chrome, 'history', {
      search: call('history.search'),
      getVisits: call('history.getVisits'),
      addUrl: call('history.addUrl'),
      deleteUrl: call('history.deleteUrl'),
      deleteRange: call('history.deleteRange'),
      deleteAll: call('history.deleteAll'),
      onVisited: event('history.onVisited'),
      onVisitRemoved: event('history.onVisitRemoved'),
    });
  }
  if (has('sessions')) {
    def(chrome, 'sessions', {
      MAX_SESSION_RESULTS: 25,
      getRecentlyClosed: call('sessions.getRecentlyClosed'),
      getDevices: call('sessions.getDevices'),
      restore: call('sessions.restore'),
      onChanged: event('sessions.onChanged'),
    });
  }
  if (has('search')) def(chrome, 'search', { query: call('search.query') });
  if (has('browsingData')) {
    const bd: Record<string, unknown> = { remove: call('browsingData.remove'), settings: call('browsingData.settings') };
    for (const n of ['removeAppcache', 'removeCache', 'removeCacheStorage', 'removeCookies', 'removeDownloads', 'removeFileSystems', 'removeFormData', 'removeHistory', 'removeIndexedDB', 'removeLocalStorage', 'removePasswords', 'removeServiceWorkers', 'removeWebSQL'])
      bd[n] = call(`browsingData.${n}`);
    def(chrome, 'browsingData', bd);
  }
  if (has('system.display')) {
    const system = chrome.system as Record<string, unknown> | undefined;
    def(system, 'display', { getInfo: call('system.display.getInfo'), getDisplayLayout: call('system.display.getDisplayLayout'), onDisplayChanged: event('system.display.onDisplayChanged') });
  }
  if (has('identity')) {
    def(chrome, 'identity', {
      getRedirectURL: (path?: unknown) => `https://${id}.chromiumapp.org/${typeof path === 'string' ? path.replace(/^\/+/, '') : ''}`,
      launchWebAuthFlow: call('identity.launchWebAuthFlow'),
      getAuthToken: call('identity.getAuthToken'),
      getProfileUserInfo: call('identity.getProfileUserInfo'),
      getAccounts: call('identity.getAccounts'),
      removeCachedAuthToken: call('identity.removeCachedAuthToken'),
      clearAllCachedAuthTokens: call('identity.clearAllCachedAuthTokens'),
      onSignInChanged: event('identity.onSignInChanged'),
    });
  }
  if (has('pageCapture')) {
    def(chrome, 'pageCapture', { saveAsMHTML: call('pageCapture.saveAsMHTML', (bytes) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'multipart/related' })) });
  }
  if (has('proxy')) {
    def(chrome, 'proxy', {
      settings: { get: call('proxy.settings.get'), set: call('proxy.settings.set'), clear: call('proxy.settings.clear'), onChange: event('proxy.settings.onChange') },
      onProxyError: event('proxy.onProxyError'),
    });
  }
  if (has('downloads')) {
    const dl: Record<string, unknown> = {
      onCreated: event('downloads.onCreated'),
      onChanged: event('downloads.onChanged'),
      onErased: event('downloads.onErased'),
      onDeterminingFilename: event('downloads.onDeterminingFilename'),
    };
    for (const n of ['download', 'search', 'pause', 'resume', 'cancel', 'open', 'show', 'showDefaultFolder', 'erase', 'removeFile', 'acceptDanger', 'getFileIcon', 'setUiOptions', 'setShelfEnabled']) dl[n] = call(`downloads.${n}`);
    def(chrome, 'downloads', dl);
    late.push(() => def(chrome, 'downloads', dl));
  }
  if (has('topSites')) {
    const topSites = { get: call('topSites.get') };
    def(chrome, 'topSites', topSites);
    late.push(() => def(chrome, 'topSites', topSites));
  }
  if (manifest.omnibox && typeof manifest.omnibox.keyword === 'string') {
    // onInputChanged recibe (texto, suggest): suggest devuelve las sugerencias a la barra de Callisto
    def(chrome, 'omnibox', {
      onInputStarted: event('omnibox.onInputStarted'),
      onInputChanged: event('omnibox.onInputChanged', ([text, requestId]) => [text, (list: unknown) => void b.invoke(id, 'omnibox.sendSuggestions', requestId, list)]),
      onInputEntered: event('omnibox.onInputEntered'),
      onInputCancelled: event('omnibox.onInputCancelled'),
      onDeleteSuggestion: event('omnibox.onDeleteSuggestion'),
      setDefaultSuggestion: call('omnibox.setDefaultSuggestion'),
    });
  }
}

if (inExtension) {
  try {
    contextBridge.executeInMainWorld({ func: mainWorld, args: [bridge] });
  } catch (e) {
    console.error('callisto: APIs de extensiones', e);
  }
}
