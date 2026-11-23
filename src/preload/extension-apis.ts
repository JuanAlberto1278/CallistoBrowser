// Preload de las páginas y service workers de las EXTENSIONES (chrome-extension://). En las páginas web no hace nada.
//
// 1. `browser` = `chrome` (como en Chrome). Medido en la V0.1: Chromium 156 trae un `browser` propio e incompleto, y las
//    extensiones que lo usan (o usan webextension-polyfill) fallaban al arrancar (uBlock Origin Lite, AdGuard, 1Password).
// 2. APIs que agrega Callisto sobre sus propios sistemas: chrome.bookmarks (favoritos), chrome.tabGroups y
//    chrome.tabs.group/ungroup (grupos de pestañas). Usan el mismo canal que electron-chrome-extensions ("crx-msg"), así
//    que el proceso principal valida la extensión y sus permisos igual que para el resto de las APIs.
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
  const permissions = (chrome.runtime?.getManifest?.().permissions ?? []).filter((p): p is string => typeof p === 'string');

  /** Función de la API: promesa, o callback si se pasa uno (como en Chrome). */
  const call =
    (name: string) =>
    (...args: unknown[]): Promise<unknown> | undefined => {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (r?: unknown) => void) : null;
      const p = b.invoke(id, name, ...args);
      if (!cb) return p;
      p.then(
        (r) => cb(r),
        (e) => {
          console.error(`${name}:`, e);
          cb(undefined);
        },
      );
      return undefined;
    };
  const event = (name: string) => {
    const fns = new Set<(...a: unknown[]) => void>();
    let attached = false;
    const dispatch = (...a: unknown[]) =>
      fns.forEach((f) => {
        try {
          f(...a);
        } catch (e) {
          console.error(e);
        }
      });
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
}

if (inExtension) {
  try {
    contextBridge.executeInMainWorld({ func: mainWorld, args: [bridge] });
  } catch (e) {
    console.error('callisto: APIs de extensiones', e);
  }
}
