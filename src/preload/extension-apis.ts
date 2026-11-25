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
  /** ¿El usuario permitió los scripts de usuario de esta extensión? (síncrono, como lo necesita la API; null: no se sabe) */
  userScriptsAllowed: (extensionId: string): boolean | null => {
    try {
      const v: unknown = ipcRenderer.sendSync('callisto-us:allowed', extensionId);
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  },
  /** Puerto con un programa instalado (1.4.3), con el protocolo de mensajes de electron-chrome-extensions. */
  nativeConnect: (extensionId: string, application: string, onMessage: (m: unknown) => void, onDisconnect: (reason: string | null) => void) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const channel = `crx-native-msg-${id}`;
    const receive = (_e: unknown, message: unknown) => onMessage(message);
    const ended = (_e: unknown, reason?: unknown) => {
      ipcRenderer.off(channel, receive);
      onDisconnect(typeof reason === 'string' ? reason : null);
    };
    ipcRenderer.on(channel, receive);
    ipcRenderer.once(`${channel}-disconnect`, ended);
    void ipcRenderer.invoke('crx-msg', extensionId, 'runtime.connectNative', id, application).catch((e: unknown) => ended(null, String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')));
    return {
      post: (message: unknown) => ipcRenderer.send(channel, message),
      close: () => {
        ipcRenderer.off(channel, receive);
        ipcRenderer.removeAllListeners(`${channel}-disconnect`);
        void ipcRenderer.invoke('crx-msg', extensionId, 'runtime.disconnectNative', id).catch(() => {});
      },
    };
  },
};

type Bridge = typeof bridge;

function mainWorld(b: Bridge): void {
  const g = globalThis as unknown as { chrome?: Record<string, unknown> & { runtime?: { id?: string; getManifest?: () => { permissions?: unknown[] }; lastError?: unknown } }; browser?: unknown };
  const chrome = g.chrome;
  if (!chrome) return;
  // Scripts de usuario permitidos (1.4.4): ver el freeze más abajo
  const userScriptsAllowed = (chrome.runtime?.getManifest?.().permissions ?? []).includes('userScripts') && !!chrome.runtime?.id ? b.userScriptsAllowed(chrome.runtime.id) : false;
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
  // También cada vez que la librería define una API en `chrome` (no depende de que llegue al freeze: medido en 1.4.3, en
  // los service workers el arreglo no se aplicaba solo con el freeze).
  const late: Array<() => void> = [];
  const nativeFreeze = Object.freeze;
  const nativeDefine = Object.defineProperty;
  let applying = false;
  const applyLate = () => {
    if (applying) return;
    applying = true;
    try {
      for (const f of late) {
        try {
          f();
        } catch (e) {
          console.error('callisto: APIs de extensiones', e);
        }
      }
    } finally {
      applying = false;
    }
  };
  Object.defineProperty = function <T>(o: T, key: PropertyKey, attributes: PropertyDescriptor & ThisType<unknown>): T {
    const result = nativeDefine(o, key, attributes);
    if ((o as unknown) === chrome) applyLate();
    return result;
  } as typeof Object.defineProperty;
  Object.freeze = function <T>(o: T): Readonly<T> {
    if ((o as unknown) === chrome) {
      Object.freeze = nativeFreeze;
      Object.defineProperty = nativeDefine;
      applyLate();
      // Con chrome.userScripts no se congela: Chromium vuelve a revisar sus APIs después y, sobre un objeto congelado
      // con una que para Chromium no existe, falla y cierra el proceso (medido en la 1.4.4)
      if (userScriptsAllowed === true) return o as Readonly<T>;
    }
    return nativeFreeze(o);
  } as typeof Object.freeze;
  if (has('nativeMessaging')) {
    // Los de la librería convierten los errores en `undefined` y avisan onDisconnect también a quien cerró el puerto:
    // estos se comportan como Chrome (el motivo en runtime.lastError, solo cuando cierra el otro lado)
    const connectNative = (application: unknown) => {
      const listenersOf = () => {
        const fns = new Set<(...a: unknown[]) => void>();
        return {
          fns,
          addListener: (fn: (...a: unknown[]) => void) => void fns.add(fn),
          removeListener: (fn: (...a: unknown[]) => void) => void fns.delete(fn),
          hasListener: (fn: (...a: unknown[]) => void) => fns.has(fn),
          hasListeners: () => fns.size > 0,
        };
      };
      const onMessage = listenersOf();
      const onDisconnect = listenersOf();
      let open = true;
      const port = {
        name: String(application),
        onMessage,
        onDisconnect,
        postMessage(message: unknown) {
          if (!open) throw new Error('Attempting to use a disconnected port object');
          handle.post(message);
        },
        disconnect() {
          if (!open) return;
          open = false;
          handle.close();
        },
      };
      const handle = b.nativeConnect(
        id,
        String(application),
        (message) => onMessage.fns.forEach((f) => f(message, port)),
        (reason) => {
          if (!open) return;
          open = false;
          const rt = chrome.runtime as Record<string, unknown>;
          try {
            if (reason) Object.defineProperty(rt, 'lastError', { value: { message: reason }, configurable: true });
            onDisconnect.fns.forEach((f) => f(port));
          } finally {
            delete rt.lastError;
          }
        },
      );
      return port;
    };
    late.push(() => {
      const rt = chrome.runtime as Record<string, unknown> | undefined;
      def(rt, 'sendNativeMessage', call('runtime.sendNativeMessage'));
      def(rt, 'connectNative', connectNative);
    });
  }
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
  // ---- 1.4.3
  if (has('sidePanel')) {
    def(chrome, 'sidePanel', {
      getOptions: call('sidePanel.getOptions'),
      setOptions: call('sidePanel.setOptions'),
      getPanelBehavior: call('sidePanel.getPanelBehavior'),
      setPanelBehavior: call('sidePanel.setPanelBehavior'),
      open: call('sidePanel.open'),
      close: call('sidePanel.close'),
      onOpened: event('sidePanel.onOpened'),
      onClosed: event('sidePanel.onClosed'),
    });
  }
  if (has('declarativeContent')) {
    // Las condiciones y acciones se crean con `new`: llevan su tipo en instanceType (como en Chrome)
    const kind = (instanceType: string) =>
      function (this: Record<string, unknown>, options?: Record<string, unknown>) {
        Object.assign(this, options ?? {});
        this.instanceType = instanceType;
      } as unknown as new (options?: Record<string, unknown>) => Record<string, unknown>;
    def(chrome, 'declarativeContent', {
      PageStateMatcher: kind('declarativeContent.PageStateMatcher'),
      ShowAction: kind('declarativeContent.ShowAction'),
      ShowPageAction: kind('declarativeContent.ShowPageAction'),
      SetIcon: kind('declarativeContent.SetIcon'),
      RequestContentScript: kind('declarativeContent.RequestContentScript'),
      onPageChanged: {
        addRules: call('declarativeContent.addRules'),
        removeRules: call('declarativeContent.removeRules'),
        getRules: call('declarativeContent.getRules'),
      },
    });
  }
  // ---- 1.4.4: scripts de usuario
  if (has('userScripts')) {
    // Como en Chrome 138+: sin "Permitir scripts de usuario" la API no está (las extensiones lo detectan y explican cómo
    // activarlo). Al cambiar el permiso, Callisto vuelve a cargar la extensión.
    if (userScriptsAllowed === true) {
      const us: Record<string, unknown> = { ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' } };
      for (const n of ['register', 'update', 'unregister', 'getScripts', 'configureWorld', 'getWorldConfigurations', 'resetWorldConfiguration', 'execute']) us[n] = call(`userScripts.${n}`);
      def(chrome, 'userScripts', us);
      // tabs.sendMessage: a los scripts de la extensión en esa pestaña (runtime.onMessage en su mundo, como en Chrome);
      // si no hay ninguno, el de Chromium (content scripts)
      late.push(() => {
        const t = chrome.tabs as Record<string, unknown> | undefined;
        const native = t?.sendMessage as ((...a: unknown[]) => unknown) | undefined;
        if (!t || !native || (native as { __callisto?: boolean }).__callisto) return;
        const send = (...args: unknown[]) => {
          const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (r?: unknown) => void) : null;
          const [tabId, message, options] = args;
          const p = b.invoke(id, 'tabs.sendMessageToUserScripts', tabId, message, options).then((r) => {
            const res = r as { delivered: boolean; response?: unknown };
            return res.delivered ? res.response : (native.call(t, tabId, message, ...(options !== undefined ? [options] : [])) as Promise<unknown>);
          });
          if (!cb) return p;
          p.then(cb, () => cb(undefined));
          return undefined;
        };
        (send as { __callisto?: boolean }).__callisto = true;
        def(t, 'sendMessage', send);
      });
    }
    // Mensajes de los scripts: (mensaje, remitente, sendResponse), como runtime.onMessage
    const messageListeners = new Set<(...a: unknown[]) => unknown>();
    let messageAttached = false;
    const onUserScriptMessage = {
      addListener(fn: (...a: unknown[]) => unknown) {
        messageListeners.add(fn);
        if (messageAttached) return;
        messageAttached = true;
        b.addListener(id, 'runtime.onUserScriptMessage', (message: unknown, sender: unknown, requestId: unknown) => {
          let responded = false;
          const sendResponse = (response?: unknown) => {
            if (responded) return;
            responded = true;
            void b.invoke(id, 'runtime.userScriptResponse', requestId, response);
          };
          let keepOpen = false;
          messageListeners.forEach((f) => {
            try {
              const r = f(message, sender, sendResponse);
              if (r === true) keepOpen = true;
              else if (r && typeof (r as Promise<unknown>).then === 'function') {
                keepOpen = true;
                (r as Promise<unknown>).then(sendResponse, () => sendResponse(undefined));
              }
            } catch (e) {
              console.error(e);
            }
          });
          if (!keepOpen && !responded) void b.invoke(id, 'runtime.userScriptResponse', requestId, undefined, true);
        });
      },
      removeListener: (fn: (...a: unknown[]) => unknown) => void messageListeners.delete(fn),
      hasListener: (fn: (...a: unknown[]) => unknown) => messageListeners.has(fn),
      hasListeners: () => messageListeners.size > 0,
    };
    // Puertos de los scripts (connect): un Port por conexión
    const portsById = new Map<string, { message(m: unknown): void; disconnect(): void }>();
    let portEventsAttached = false;
    const connectListeners = new Set<(port: unknown) => void>();
    const onUserScriptConnect = {
      addListener(fn: (port: unknown) => void) {
        connectListeners.add(fn);
        if (!portEventsAttached) {
          portEventsAttached = true;
          b.addListener(id, 'runtime.userScriptPortEvent', (portId: unknown, kind: unknown, data: unknown) => {
            const p = portsById.get(String(portId));
            if (!p) return;
            if (kind === 'message') p.message(data);
            else {
              portsById.delete(String(portId));
              p.disconnect();
            }
          });
          b.addListener(id, 'runtime.onUserScriptConnect', (portId: unknown, name: unknown, sender: unknown) => {
            const onMessage = new Set<(m: unknown, port: unknown) => void>();
            const onDisconnect = new Set<(port: unknown) => void>();
            let open = true;
            const port = {
              name: String(name ?? ''),
              sender,
              postMessage(m: unknown) {
                if (!open) throw new Error('Attempting to use a disconnected port object');
                void b.invoke(id, 'runtime.userScriptPortPost', portId, m);
              },
              disconnect() {
                if (!open) return;
                open = false;
                portsById.delete(String(portId));
                void b.invoke(id, 'runtime.userScriptPortClose', portId);
              },
              onMessage: { addListener: (f: (m: unknown, p: unknown) => void) => void onMessage.add(f), removeListener: (f: (m: unknown, p: unknown) => void) => void onMessage.delete(f), hasListener: (f: (m: unknown, p: unknown) => void) => onMessage.has(f) },
              onDisconnect: { addListener: (f: (p: unknown) => void) => void onDisconnect.add(f), removeListener: (f: (p: unknown) => void) => void onDisconnect.delete(f), hasListener: (f: (p: unknown) => void) => onDisconnect.has(f) },
            };
            portsById.set(String(portId), {
              message: (m) => onMessage.forEach((f) => f(m, port)),
              disconnect: () => {
                if (!open) return;
                open = false;
                onDisconnect.forEach((f) => f(port));
              },
            });
            connectListeners.forEach((f) => f(port));
          });
        }
      },
      removeListener: (fn: (port: unknown) => void) => void connectListeners.delete(fn),
      hasListener: (fn: (port: unknown) => void) => connectListeners.has(fn),
      hasListeners: () => connectListeners.size > 0,
    };
    def(runtime, 'onUserScriptMessage', onUserScriptMessage);
    def(runtime, 'onUserScriptConnect', onUserScriptConnect);
  }
  // action.enable / disable / isEnabled: la librería las deja sin efecto; Callisto las implementa (botón desactivado)
  late.push(() => {
    const action = chrome.action as Record<string, unknown> | undefined;
    if (!action) return;
    def(action, 'enable', call('browserAction.enable'));
    def(action, 'disable', call('browserAction.disable'));
    def(action, 'isEnabled', call('browserAction.isEnabled'));
  });
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
    // Sin aislamiento de contexto (los documentos offscreen que crea electron-chrome-extensions) no hay contextBridge:
    // el preload ya corre en el mundo de la página de la extensión (como hace la librería en ese caso)
    if (process.contextIsolated) contextBridge.executeInMainWorld({ func: mainWorld, args: [bridge] });
    else mainWorld(bridge);
  } catch (e) {
    console.error('callisto: APIs de extensiones', e);
  }
}
