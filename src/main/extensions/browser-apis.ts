// APIs de extensiones que Callisto agrega o completa en la 1.4.2, sobre sus propios sistemas (como bookmarks y tabGroups
// en la V0.10, ver callisto-apis.ts). Se registran en el router de electron-chrome-extensions: el router exige que la
// extensión esté cargada en el perfil y, si corresponde, que tenga el permiso. El lado de las extensiones está en
// src/preload/extension-apis.ts; la lógica pura, en api-helpers.ts. Ver docs/15-v1.4.2.md.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, screen, webContents as allWebContents, type MenuItem, type WebContents } from 'electron';
import type { ExtensionManager } from './manager';
import {
  browsingDataPlan,
  shortcutOfInput,
  downloadDelta,
  manifestCommands,
  matchDownloads,
  omniboxInput,
  omniboxText,
  toChromeDownload,
  toElectronProxy,
  type ChromeDownloadItem,
  type ExtensionCommand,
} from './api-helpers';
import type { ClosedEntry, ClosedTabs } from '../closed-tabs';
import { Tab } from '../tab';
import { showWindow } from '../test-mode';
import type { BrowserWindowController } from '../window';
import { SEARCH_ENGINES } from '../../shared/settings';
import { searchUrl } from '../../shared/omnibox';
import type { Suggestion } from '../../shared/ipc';

export interface BrowserApiDeps {
  /** Ventanas del perfil. */
  windows(): BrowserWindowController[];
  /** La ventana enfocada (si es del perfil) o la última del perfil. */
  current(): BrowserWindowController | undefined;
  closedTabs: ClosedTabs;
  newWindow(url: string): void;
  /** ¿El atajo ya lo usa Callisto? (la extensión no puede quitárselo). */
  isBrowserShortcut(shortcut: string): boolean;
}

/** Lo que el resto de Callisto usa de estas APIs (atajos, barra de direcciones, menú del botón). */
export interface BrowserApis {
  /** Una tecla: si es el atajo de una extensión, lo ejecuta y devuelve true. */
  runCommand(input: Electron.Input, activeTab: WebContents | null): boolean;
  /** Si lo escrito empieza con la palabra clave de una extensión: sus sugerencias (si no, null). */
  omniboxSuggest(text: string): Promise<Suggestion[] | null>;
  /** Enter en la barra con la palabra clave de una extensión: se lo pasa a la extensión y devuelve true. */
  omniboxEnter(text: string): boolean;
  /** Ítems de la extensión para el menú de su botón (contexts: "action"). */
  actionMenuItems(extensionId: string): MenuItem[];
  /** Atajos asignados (para la página de extensiones). */
  commandsOf(extensionId: string): ExtensionCommand[];
}

type ApiEvent = { extension?: Electron.Extension; sender?: WebContents };
type Handler = (event: ApiEvent, ...args: unknown[]) => unknown;

const OMNIBOX_WAIT_MS = 400;

export function registerBrowserApis(manager: ExtensionManager, deps: BrowserApiDeps): BrowserApis {
  const profile = manager.profile;
  const router = manager.router;
  const handle = (name: string, fn: Handler, permission?: string) => router.handle(name, fn, permission ? { permission } : undefined);
  // Internos de electron-chrome-extensions 4.10.0 (versión fijada; las pruebas end-to-end lo verifican)
  const lib = manager.chrome as unknown as {
    api: {
      tabs: { createTabDetails(wc: WebContents): chrome.tabs.Tab };
      windows: { getWindowDetails(win: Electron.BaseWindow): chrome.windows.Window };
      browserAction: { openPopup(event: { extension: Electron.Extension }, options?: { windowId?: number }): void };
    };
    ctx: { store: { buildMenuItems(extensionId: string, menuType: string): MenuItem[] } };
  };
  const extensionOf = (id: string) => profile.session.extensions.getExtension(id) ?? undefined;
  const manifestOf = (ext: Electron.Extension | undefined) => (ext?.manifest ?? {}) as { permissions?: unknown[]; host_permissions?: unknown[]; omnibox?: { keyword?: unknown }; commands?: unknown };
  const hasPermission = (ext: Electron.Extension | undefined, p: string) => {
    const m = manifestOf(ext);
    return [...(Array.isArray(m.permissions) ? m.permissions : []), ...(Array.isArray(m.host_permissions) ? m.host_permissions : [])].includes(p);
  };

  // ------------------------------------------------------------ pestañas

  const findTab = (id: unknown) => {
    const wc = typeof id === 'number' ? allWebContents.fromId(id) : undefined;
    const tab = wc ? Tab.fromWebContents(wc) : undefined;
    const win = tab ? deps.windows().find((w) => w.tabs.includes(tab)) : undefined;
    if (!tab || !win) throw new Error(`No tab with id: ${String(id)}.`);
    return { tab, win };
  };
  const windowById = (id: unknown) => {
    if (id === undefined || id === null || id === -2) return deps.current();
    return deps.windows().find((w) => w.win.id === id);
  };
  const tabDetails = (tab: Tab) => lib.api.tabs.createTabDetails(tab.webContents);

  // chrome.tabs.captureVisibleTab([windowId], [options]): la pestaña activa como imagen (con <all_urls> o activeTab)
  handle('tabs.captureVisibleTab', async ({ extension }, a, b) => {
    if (!hasPermission(extension, '<all_urls>') && !hasPermission(extension, 'activeTab')) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    const windowId = typeof a === 'number' ? a : undefined;
    const options = ((typeof a === 'object' && a ? a : b) ?? {}) as { format?: unknown; quality?: unknown };
    const win = windowById(windowId);
    if (!win) throw new Error(`No window with id: ${String(windowId)}.`);
    const tab = win.active;
    if (tab.kind !== 'web' || tab.isPending) throw new Error('Cannot access contents of the page.');
    const image = await tab.webContents.capturePage();
    if (options.format === 'png') return image.toDataURL();
    const quality = typeof options.quality === 'number' ? Math.max(0, Math.min(100, Math.round(options.quality))) : 92;
    return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
  });
  handle('tabs.move', (_e, ids, props) => {
    const p = (props ?? {}) as { index?: unknown; windowId?: unknown };
    if (typeof p.index !== 'number' || !Number.isInteger(p.index)) throw new Error('Invalid index.');
    const list = (Array.isArray(ids) ? ids : [ids]).map(findTab);
    const out: chrome.tabs.Tab[] = [];
    let index = p.index;
    for (const { tab, win } of list) {
      if (p.windowId !== undefined && p.windowId !== win.win.id) throw new Error('Callisto no puede mover pestañas a otra ventana desde una extensión.');
      win.moveTab(tab, index < 0 ? win.tabs.length - 1 : Math.min(index, win.tabs.length - 1));
      if (index >= 0) index++;
      out.push(tabDetails(tab));
    }
    return Array.isArray(ids) ? out : out[0];
  });
  handle('tabs.duplicate', (_e, id) => {
    const { tab, win } = findTab(id);
    return tabDetails(win.duplicate(tab));
  });
  // Dormir una pestaña (Chrome la "descarta"): la misma pestaña de Callisto, sin proceso
  handle('tabs.discard', (_e, id) => {
    let target: { tab: Tab; win: BrowserWindowController } | undefined;
    if (id === undefined) {
      const candidates = deps.windows().flatMap((win) => win.tabs.filter((t) => t !== win.active && !t.isPending && t.canSleep).map((tab) => ({ tab, win })));
      target = candidates.sort((x, y) => x.tab.lastActive - y.tab.lastActive)[0];
      if (!target) return undefined;
    } else target = findTab(id);
    const before = tabDetails(target.tab);
    if (!target.win.sleepTab(target.tab)) throw new Error(`Cannot discard tab with id: ${String(id ?? before.id)}.`);
    return { ...before, discarded: true, active: false };
  });
  handle('tabs.highlight', (_e, info) => {
    const i = (info ?? {}) as { windowId?: unknown; tabs?: unknown };
    const win = windowById(i.windowId);
    if (!win) throw new Error(`No window with id: ${String(i.windowId)}.`);
    const indexes = (Array.isArray(i.tabs) ? i.tabs : [i.tabs]).filter((n): n is number => typeof n === 'number');
    const tab = win.tabs[indexes[0] ?? -1];
    if (!tab) throw new Error('No tab at index.');
    win.activate(tab);
    return lib.api.windows.getWindowDetails(win.win);
  });
  handle('tabs.detectLanguage', async (_e, id) => {
    const tab = id === undefined || id === null ? deps.current()?.active : findTab(id).tab;
    if (!tab || tab.isPending || tab.kind !== 'web') return 'und';
    const lang = await tab.webContents.executeJavaScript('document.documentElement.lang', false).catch(() => '');
    const primary = typeof lang === 'string' ? lang.trim().split(/[-_]/)[0]!.toLowerCase() : '';
    return /^[a-z]{2,3}$/.test(primary) ? primary : 'und';
  });

  // ------------------------------------------------------------ chrome.contextMenus.update (la librería no la tiene)

  handle('contextMenus.update', ({ extension }, menuId, changes) => {
    const menus = (lib.api as unknown as { contextMenus: { menus: Map<string, Map<string | number, Record<string, unknown>>> } }).contextMenus.menus;
    const props = menus.get(extension!.id)?.get(menuId as string | number);
    if (!props) throw new Error(`Cannot find menu item with id ${String(menuId)}`);
    const c = (changes ?? {}) as Record<string, unknown>;
    for (const key of ['title', 'type', 'checked', 'contexts', 'visible', 'enabled', 'parentId', 'documentUrlPatterns', 'targetUrlPatterns']) if (key in c) props[key] = c[key];
  });

  // ------------------------------------------------------------ chrome.topSites: los sitios de la página nueva

  handle('topSites.get', () => {
    const hidden = new Set(profile.kv.get<string[]>('ntp.hidden') ?? []);
    return profile.history.topSites(20, hidden).map((s) => ({ url: s.url, title: s.title }));
  }, 'topSites');

  // ------------------------------------------------------------ chrome.history

  const historyItem = (r: { id: number; url: string; title: string; lastVisit: number; visitCount: number; typedCount: number }) => ({
    id: String(r.id),
    url: r.url,
    title: r.title,
    lastVisitTime: r.lastVisit,
    visitCount: r.visitCount,
    typedCount: r.typedCount,
  });
  const urlArg = (d: unknown) => {
    const url = (d as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string' || url.length > 8192) throw new Error('Invalid url.');
    return url;
  };
  handle('history.search', (_e, q) => {
    const query = (q ?? {}) as { text?: unknown; startTime?: unknown; endTime?: unknown; maxResults?: unknown };
    const text = typeof query.text === 'string' ? query.text.slice(0, 1000) : '';
    // Como Chrome: sin startTime, las últimas 24 horas
    const startTime = typeof query.startTime === 'number' ? query.startTime : Date.now() - 24 * 60 * 60 * 1000;
    const endTime = typeof query.endTime === 'number' ? query.endTime : undefined;
    const limit = typeof query.maxResults === 'number' && query.maxResults > 0 ? query.maxResults : 100;
    return profile.history.urls({ text, startTime, endTime, limit }).map(historyItem);
  }, 'history');
  handle('history.getVisits', (_e, d) => {
    const url = urlArg(d);
    return profile.history.visitsOf(url).map((v) => ({ id: String(v.urlId), visitId: String(v.id), visitTime: v.time, referringVisitId: '0', transition: v.typed ? 'typed' : 'link', isLocal: true }));
  }, 'history');
  handle('history.addUrl', (_e, d) => {
    const url = urlArg(d);
    const o = d as { title?: unknown; visitTime?: unknown; transition?: unknown };
    profile.history.addVisit(url, { title: typeof o.title === 'string' ? o.title : undefined, time: typeof o.visitTime === 'number' ? o.visitTime : undefined, typed: o.transition === 'typed' });
  }, 'history');
  handle('history.deleteUrl', (_e, d) => profile.history.deleteUrl(urlArg(d)), 'history');
  handle('history.deleteRange', (_e, r) => {
    const range = (r ?? {}) as { startTime?: unknown; endTime?: unknown };
    if (typeof range.startTime !== 'number' || typeof range.endTime !== 'number') throw new Error('Invalid range.');
    profile.history.deleteRange(range.startTime, range.endTime);
  }, 'history');
  handle('history.deleteAll', () => profile.history.deleteAll(), 'history');
  profile.history.onChange((c) => {
    if (c.type === 'visited') {
      const row = profile.history.urlRow(c.url);
      if (row) router.broadcastEvent('history.onVisited', historyItem(row));
    } else router.broadcastEvent('history.onVisitRemoved', c.allHistory ? { allHistory: true } : { allHistory: false, urls: c.urls });
  });

  // ------------------------------------------------------------ chrome.sessions: cerradas recientemente

  const sessionIds = new WeakMap<ClosedEntry, string>();
  let sessionSeq = 0;
  const sessionId = (e: ClosedEntry) => {
    let id = sessionIds.get(e);
    if (!id) sessionIds.set(e, (id = `c${++sessionSeq}`));
    return id;
  };
  const snapshotTab = (s: { entries: Array<{ url: string; title: string }>; index: number }, sid: string | undefined, index: number) => {
    const e = s.entries[s.index] ?? s.entries.at(-1);
    return { ...(sid ? { sessionId: sid } : {}), url: e?.url ?? '', title: e?.title ?? '', index, windowId: -1, active: false, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, groupId: -1 };
  };
  const toSession = (e: ClosedEntry) => {
    const lastModified = Math.floor((e.time ?? 0) / 1000);
    if (e.kind === 'tab') return { lastModified, tab: snapshotTab(e.tab, sessionId(e), e.index) };
    return { lastModified, window: { sessionId: sessionId(e), tabs: e.tabs.map((t, i) => snapshotTab(t, undefined, i)), focused: false, incognito: false, alwaysOnTop: false, type: 'normal', state: 'normal' } };
  };
  handle('sessions.getRecentlyClosed', (_e, filter) => {
    const max = (filter as { maxResults?: unknown } | undefined)?.maxResults;
    const limit = typeof max === 'number' && max > 0 ? Math.min(max, 25) : 25;
    return deps.closedTabs.entries().reverse().slice(0, limit).map(toSession);
  }, 'sessions');
  handle('sessions.getDevices', () => [], 'sessions');
  handle('sessions.restore', (_e, sid) => {
    const entries = deps.closedTabs.entries().reverse();
    const i = sid === undefined || sid === null ? 0 : entries.findIndex((e) => sessionIds.get(e) === sid);
    const entry = entries[i];
    if (!entry || i < 0) throw new Error(`Invalid session id: "${String(sid)}".`);
    const win = deps.current();
    if (!win) throw new Error('No window to restore into.');
    const session = toSession(entry);
    win.reopenClosed(i);
    return session;
  }, 'sessions');
  const previousOnChange = deps.closedTabs.onChange;
  deps.closedTabs.onChange = () => {
    previousOnChange?.();
    router.broadcastEvent('sessions.onChanged');
  };

  // ------------------------------------------------------------ chrome.search: con el buscador elegido en Callisto

  handle('search.query', (_e, q) => {
    const query = (q ?? {}) as { text?: unknown; disposition?: unknown; tabId?: unknown };
    if (typeof query.text !== 'string' || !query.text.trim()) throw new Error('Invalid search text.');
    const url = searchUrl(query.text.slice(0, 2000), SEARCH_ENGINES[profile.settings.searchEngine].template);
    if (query.tabId !== undefined) {
      const { tab, win } = findTab(query.tabId);
      win.navigateTab(tab, url, false);
    } else if (query.disposition === 'NEW_WINDOW') deps.newWindow(url);
    else {
      const win = deps.current();
      if (!win) throw new Error('No window.');
      if (query.disposition === 'NEW_TAB') win.newTab({ url });
      else win.navigateTab(win.active, url, false);
    }
  }, 'search');

  // ------------------------------------------------------------ chrome.browsingData

  const removeData = async (options: unknown, dataToRemove: unknown) => {
    const plan = browsingDataPlan(options, dataToRemove);
    const o = (options ?? {}) as { since?: unknown; originTypes?: { extension?: unknown } };
    const since = typeof o.since === 'number' ? o.since : 0;
    if (plan.history) {
      if (since > 0) profile.history.deleteRange(since, Date.now() + 1);
      else profile.history.deleteAll();
    }
    if (plan.downloads) for (const d of profile.downloads.entries({ limit: 10_000 })) if (d.startTime >= since) profile.downloads.remove(d.id);
    // Los datos de las extensiones no se tocan salvo que se pida (originTypes.extension), como en Chrome
    const excludeOrigins = o.originTypes?.extension === true ? [] : (manager.registry.all() ?? []).map((r) => `chrome-extension://${r.id}`);
    const exclude = excludeOrigins.length ? { excludeOrigins } : {};
    if (plan.storage.length) await profile.session.clearData({ dataTypes: plan.storage, ...exclude });
    if (plan.cache) await profile.session.clearData({ dataTypes: ['cache'], ...exclude });
  };
  handle('browsingData.remove', (_e, options, data) => removeData(options, data), 'browsingData');
  for (const [name, key] of [
    ['removeCache', 'cache'],
    ['removeCacheStorage', 'cacheStorage'],
    ['removeCookies', 'cookies'],
    ['removeDownloads', 'downloads'],
    ['removeFileSystems', 'fileSystems'],
    ['removeFormData', 'formData'],
    ['removeHistory', 'history'],
    ['removeIndexedDB', 'indexedDB'],
    ['removeLocalStorage', 'localStorage'],
    ['removePasswords', 'passwords'],
    ['removeServiceWorkers', 'serviceWorkers'],
    ['removeWebSQL', 'webSQL'],
    ['removeAppcache', 'appcache'],
  ] as const)
    handle(`browsingData.${name}`, (_e, options) => removeData(options, { [key]: true }), 'browsingData');
  handle('browsingData.settings', () => ({
    options: { since: 0, originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false } },
    dataToRemove: {},
    dataRemovalPermitted: { appcache: true, cache: true, cacheStorage: true, cookies: true, downloads: true, fileSystems: true, formData: true, history: true, indexedDB: true, localStorage: true, passwords: false, serviceWorkers: true, webSQL: true },
  }), 'browsingData');

  // ------------------------------------------------------------ chrome.system.display

  const displays = () => {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      name: d.label,
      mirroringSourceId: '',
      mirroringDestinationIds: [],
      isPrimary: d.id === primary.id,
      isInternal: d.internal,
      isEnabled: true,
      isUnified: false,
      dpiX: Math.round(96 * d.scaleFactor),
      dpiY: Math.round(96 * d.scaleFactor),
      rotation: d.rotation,
      bounds: d.bounds,
      overscan: { left: 0, top: 0, right: 0, bottom: 0 },
      workArea: d.workArea,
      modes: [],
      hasTouchSupport: d.touchSupport === 'available',
      hasAccelerometerSupport: false,
      availableDisplayZoomFactors: [],
      displayZoomFactor: 1,
    }));
  };
  handle('system.display.getInfo', () => displays(), 'system.display');
  handle('system.display.getDisplayLayout', () => [], 'system.display');
  const displayChanged = () => router.broadcastEvent('system.display.onDisplayChanged');
  screen.on('display-added', displayChanged);
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);

  // ------------------------------------------------------------ chrome.identity

  handle('identity.launchWebAuthFlow', ({ extension }, d) => launchWebAuthFlow(extension!, d), 'identity');
  // Sin cuenta de Google de Chrome: lo mismo que Chrome cuando no hay sesión iniciada
  handle('identity.getAuthToken', () => Promise.reject(new Error('The user is not signed in.')), 'identity');
  handle('identity.getProfileUserInfo', () => ({ email: '', id: '' }), 'identity');
  handle('identity.getAccounts', () => [], 'identity');
  handle('identity.removeCachedAuthToken', () => undefined, 'identity');
  handle('identity.clearAllCachedAuthTokens', () => undefined, 'identity');

  /**
   * Inicio de sesión de una extensión con un proveedor (OAuth): una ventana con la sesión del perfil (las cookies del
   * proveedor son las del usuario, como en Chrome) que termina al llegar a https://<id>.chromiumapp.org/.
   */
  function launchWebAuthFlow(extension: Electron.Extension, details: unknown): Promise<string> {
    const d = (details ?? {}) as { url?: unknown; interactive?: unknown; timeoutMsForNonInteractive?: unknown };
    if (typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url) || d.url.length > 8192) return Promise.reject(new Error('Invalid url.'));
    const target = `https://${extension.id}.chromiumapp.org/`;
    const interactive = d.interactive === true;
    const parent = deps.current()?.win;
    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520,
        height: 680,
        show: false,
        autoHideMenuBar: true,
        title: 'Iniciar sesión',
        webPreferences: { session: profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
      });
      win.setMenu(null);
      if (parent && !parent.isDestroyed()) win.setParentWindow(parent as BrowserWindow);
      let done = false;
      const finish = (err: Error | null, url?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        if (err) reject(err);
        else resolve(url!);
      };
      const check = (e: { preventDefault(): void }, url: string) => {
        if (!url.startsWith(target)) return;
        e.preventDefault();
        finish(null, url);
      };
      const wc = win.webContents;
      wc.on('will-redirect', (e) => check(e, e.url));
      wc.on('will-navigate', (e) => check(e, e.url));
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      // El título dice siempre en qué sitio se está iniciando sesión
      const title = () => {
        try {
          if (!win.isDestroyed()) win.setTitle(`Iniciar sesión — ${new URL(wc.getURL()).host}`);
        } catch {
          /* sin dirección todavía */
        }
      };
      wc.on('did-navigate', title);
      wc.on('page-title-updated', (e) => {
        e.preventDefault();
        title();
      });
      win.on('closed', () => finish(new Error('The user did not approve access.')));
      const timer = setTimeout(
        () => finish(new Error(interactive ? 'The user did not approve access.' : 'User interaction required.')),
        interactive ? 10 * 60_000 : typeof d.timeoutMsForNonInteractive === 'number' ? Math.min(d.timeoutMsForNonInteractive, 60_000) : 5000,
      );
      if (interactive) win.once('ready-to-show', () => showWindow(win));
      void wc.loadURL(d.url as string).catch(() => {
        if (!interactive) finish(new Error('User interaction required.'));
      });
    });
  }

  // ------------------------------------------------------------ chrome.pageCapture

  handle('pageCapture.saveAsMHTML', async (_e, d) => {
    const { tab } = findTab((d as { tabId?: unknown } | undefined)?.tabId);
    if (tab.kind !== 'web' || tab.isPending) throw new Error('Cannot access contents of the page.');
    const file = join(app.getPath('temp'), `callisto-${randomBytes(8).toString('hex')}.mhtml`);
    try {
      await tab.webContents.savePage(file, 'MHTML');
      return new Uint8Array(readFileSync(file));
    } finally {
      rmSync(file, { force: true });
    }
  }, 'pageCapture');

  // ------------------------------------------------------------ chrome.proxy (la última extensión que lo cambia manda)

  const PROXY_KEY = 'extensions.proxy';
  type ProxyState = { extensionId: string; value: unknown };
  const proxyState = () => profile.kv.get<ProxyState>(PROXY_KEY) ?? null;
  const proxyLevel = (extId: string) => {
    const s = proxyState();
    return !s ? 'controllable_by_this_extension' : s.extensionId === extId ? 'controlled_by_this_extension' : 'controlled_by_other_extensions';
  };
  /**
   * Aplica el proxy guardado, solo si cambió: setProxy corta las conexiones en curso (medido: con un setProxy al arrancar
   * y en cada cambio de extensiones, las cargas en curso fallaban de vez en cuando). Sin extensión que lo controle,
   * Electron ya usa el del sistema y no se toca nada.
   */
  let appliedProxy = JSON.stringify({ mode: 'system' });
  const applyProxy = async () => {
    let s = proxyState();
    if (s && !extensionOf(s.extensionId)) {
      profile.kv.delete(PROXY_KEY);
      s = null;
    }
    const config = s ? toElectronProxy(s.value) : { mode: 'system' as const };
    const key = JSON.stringify(config);
    if (key === appliedProxy) return;
    appliedProxy = key;
    await profile.session.setProxy(config);
  };
  handle('proxy.settings.get', ({ extension }) => {
    const s = proxyState();
    return { value: s ? s.value : { mode: 'system' }, levelOfControl: proxyLevel(extension!.id) };
  }, 'proxy');
  handle('proxy.settings.set', async ({ extension }, details) => {
    const value = (details as { value?: unknown } | undefined)?.value;
    toElectronProxy(value); // valida antes de guardar
    profile.kv.set(PROXY_KEY, { extensionId: extension!.id, value });
    await applyProxy();
    router.broadcastEvent('proxy.settings.onChange', { value, levelOfControl: 'controlled_by_other_extensions' });
  }, 'proxy');
  handle('proxy.settings.clear', async ({ extension }) => {
    if (proxyState()?.extensionId !== extension!.id) return;
    profile.kv.delete(PROXY_KEY);
    await applyProxy();
    router.broadcastEvent('proxy.settings.onChange', { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' });
  }, 'proxy');
  // Al arrancar y cuando se quita o desactiva la extensión que lo controlaba
  void manager.ready.then(applyProxy).catch(() => {});
  // Si se quita o desactiva la extensión que lo controlaba (solo entonces hay algo que cambiar)
  manager.on('changed', () => {
    const st = proxyState();
    if (st && !extensionOf(st.extensionId)) void applyProxy().catch(() => {});
  });

  // ------------------------------------------------------------ chrome.downloads (sobre las descargas de Callisto)

  const downloads = profile.downloads;
  const chromeDownloads = () => downloads.entries({ limit: 10_000 }).map(toChromeDownload);
  const downloadById = (id: unknown) => {
    const d = chromeDownloads().find((x) => x.id === id);
    if (!d) throw new Error(`Invalid download id ${String(id)}`);
    return d;
  };
  handle('downloads.download', ({ extension, sender }, options) => {
    const o = (options ?? {}) as { url?: unknown; filename?: unknown; method?: unknown };
    if (typeof o.url !== 'string' || !/^(https?|data|blob|ftp):/i.test(o.url) || o.url.length > 2_000_000) throw new Error('Invalid URL.');
    if (o.method === 'POST') throw new Error('Callisto todavía no descarga con POST desde una extensión.');
    const filename = typeof o.filename === 'string' && !o.filename.includes('..') && o.filename.length < 300 ? o.filename : null;
    const source = sender && typeof (sender as WebContents).downloadURL === 'function' ? (sender as WebContents) : null;
    return downloads.requestFromExtension(source, o.url, extension!.name, filename);
  }, 'downloads');
  handle('downloads.search', (_e, q) => matchDownloads(chromeDownloads(), q), 'downloads');
  handle('downloads.pause', (_e, id) => downloads.pause(downloadById(id).id), 'downloads');
  handle('downloads.resume', (_e, id) => downloads.resume(downloadById(id).id), 'downloads');
  handle('downloads.cancel', (_e, id) => downloads.cancel(downloadById(id).id), 'downloads');
  handle('downloads.open', ({ extension }, id) => {
    if (!hasPermission(extension, 'downloads.open')) throw new Error('The "downloads.open" permission is required.');
    return downloads.open(downloadById(id).id);
  }, 'downloads');
  handle('downloads.show', (_e, id) => downloads.showInFolder(downloadById(id).id), 'downloads');
  handle('downloads.showDefaultFolder', () => downloads.openFolder(), 'downloads');
  handle('downloads.erase', (_e, q) => {
    const ids = matchDownloads(chromeDownloads(), q).map((d) => d.id);
    for (const id of ids) downloads.remove(id);
    return ids;
  }, 'downloads');
  handle('downloads.removeFile', (_e, id) => {
    const d = downloadById(id);
    if (d.state !== 'complete') throw new Error('Download must be complete.');
    rmSync(d.filename, { force: true });
    downloads.touch();
  }, 'downloads');
  handle('downloads.acceptDanger', () => undefined, 'downloads');
  handle('downloads.getFileIcon', async (_e, id, opts) => {
    const d = downloadById(id);
    const size = (opts as { size?: unknown } | undefined)?.size;
    const icon = await app.getFileIcon(d.filename, { size: size === 32 ? 'large' : size === 16 ? 'small' : 'normal' });
    return icon.toDataURL();
  }, 'downloads');
  handle('downloads.setUiOptions', () => Promise.reject(new Error('Callisto no deja que una extensión oculte sus descargas.')), 'downloads');
  handle('downloads.setShelfEnabled', () => undefined, 'downloads');
  let knownDownloads = new Map(chromeDownloads().map((d) => [d.id, d]));
  downloads.on('changed', () => {
    const now = new Map(chromeDownloads().map((d) => [d.id, d] as [number, ChromeDownloadItem]));
    for (const [id, d] of now) {
      const before = knownDownloads.get(id);
      if (!before) router.broadcastEvent('downloads.onCreated', d);
      else {
        const delta = downloadDelta(before, d);
        if (delta) router.broadcastEvent('downloads.onChanged', delta);
      }
    }
    for (const id of knownDownloads.keys()) if (!now.has(id)) router.broadcastEvent('downloads.onErased', id);
    knownDownloads = now;
  });

  // ------------------------------------------------------------ chrome.commands: atajos de teclado

  const commands = new Map<string, ExtensionCommand[]>();
  const assignCommands = () => {
    commands.clear();
    const used = new Set<string>();
    for (const ext of profile.session.extensions.getAllExtensions()) {
      const list = manifestCommands(manifestOf(ext), (s) => used.has(s) || deps.isBrowserShortcut(s));
      for (const c of list) if (c.shortcut) used.add(c.shortcut);
      commands.set(ext.id, list);
    }
  };
  profile.session.extensions.on('extension-loaded', assignCommands);
  profile.session.extensions.on('extension-unloaded', assignCommands);
  void manager.ready.then(assignCommands);
  handle('commands.getAll', ({ extension }) => commands.get(extension!.id) ?? []);

  // ------------------------------------------------------------ chrome.omnibox: la palabra clave en la barra

  let omniboxSeq = 0;
  const omniboxWaits = new Map<number, (list: unknown) => void>();
  const defaultSuggestion = new Map<string, string>();
  let activeKeyword: string | null = null;
  handle('omnibox.sendSuggestions', (_e, requestId, list) => {
    omniboxWaits.get(requestId as number)?.(list);
  });
  handle('omnibox.setDefaultSuggestion', ({ extension }, s) => {
    const description = omniboxText((s as { description?: unknown } | undefined)?.description);
    if (description) defaultSuggestion.set(extension!.id, description);
    else defaultSuggestion.delete(extension!.id);
  });
  const keywordMatch = (text: string) => {
    for (const ext of profile.session.extensions.getAllExtensions()) {
      const keyword = manifestOf(ext).omnibox?.keyword;
      if (typeof keyword !== 'string') continue;
      const rest = omniboxInput(text, keyword);
      if (rest !== null) return { ext, keyword: keyword.trim(), rest };
    }
    return null;
  };

  // ------------------------------------------------------------ runtime.onInstalled / onStartup

  const pendingLifecycle = new Map<string, { event: 'runtime.onInstalled' | 'runtime.onStartup'; args: unknown[] }[]>();
  const queue = (id: string, event: 'runtime.onInstalled' | 'runtime.onStartup', ...args: unknown[]) => {
    const list = pendingLifecycle.get(id) ?? [];
    list.push({ event, args });
    pendingLifecycle.set(id, list);
  };
  manager.on('installed', (id, previousVersion) => queue(id, 'runtime.onInstalled', previousVersion ? { reason: 'update', previousVersion } : { reason: 'install' }));
  manager.on('started', (ids) => {
    for (const id of ids) queue(id, 'runtime.onStartup');
  });
  /**
   * El service worker de la extensión registra sus oyentes mientras arranca, y Electron no le entrega mensajes hasta que
   * termina de arrancar (medido: 1 de cada 6 veces se perdía runtime.onInstalled): se espera a que esté corriendo.
   */
  const whenWorkerRunning = (id: string) =>
    new Promise<void>((resolve) => {
      const scope = `chrome-extension://${id}/`;
      const workers = profile.session.serviceWorkers;
      const done = () => {
        workers.off('running-status-changed', onStatus);
        clearTimeout(timer);
        resolve();
      };
      const onStatus = (d: { versionId: number; runningStatus: string }) => {
        if (d.runningStatus === 'running' && workers.getWorkerFromVersionID(d.versionId)?.scope === scope) setTimeout(done, 0);
      };
      workers.on('running-status-changed', onStatus);
      // Por si ya estaba corriendo (o nunca avisa): no se espera para siempre
      const timer = setTimeout(done, 1500);
    });
  // Cuando la extensión registra el oyente (su service worker arrancó), recibe el evento una sola vez
  const routerInternals = router as unknown as { addListener(listener: unknown, extensionId: string, eventName: string): void; sendEvent(id: string, name: string, ...args: unknown[]): void };
  const addListener = routerInternals.addListener.bind(routerInternals);
  routerInternals.addListener = (listener, extensionId, eventName) => {
    addListener(listener, extensionId, eventName);
    const list = pendingLifecycle.get(extensionId);
    const i = list?.findIndex((p) => p.event === eventName) ?? -1;
    if (list && i >= 0) {
      const [p] = list.splice(i, 1);
      if (!list.length) pendingLifecycle.delete(extensionId);
      const deliver = () => routerInternals.sendEvent(extensionId, p!.event, ...p!.args);
      if ((listener as { type?: string }).type === 'service-worker') void whenWorkerRunning(extensionId).then(deliver);
      else setTimeout(deliver, 0);
    }
  };

  // Las APIs para el resto de Callisto
  return {
    runCommand(input, activeTab) {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
      const shortcut = shortcutOfInput(input);
      if (!shortcut) return false;
      for (const [id, list] of commands) {
        const command = list.find((c) => c.shortcut === shortcut);
        if (!command) continue;
        const extension = extensionOf(id);
        if (!extension) return false;
        if (command.name === '_execute_action' || command.name === '_execute_browser_action') {
          lib.api.browserAction.openPopup({ extension });
        } else {
          const tab = activeTab && !activeTab.isDestroyed() && Tab.fromWebContents(activeTab)?.kind === 'web' ? lib.api.tabs.createTabDetails(activeTab) : undefined;
          routerInternals.sendEvent(id, 'commands.onCommand', command.name, tab);
        }
        return true;
      }
      return false;
    },

    async omniboxSuggest(text) {
      const m = keywordMatch(text);
      if (!m) {
        if (activeKeyword) {
          const ext = profile.session.extensions.getAllExtensions().find((e) => manifestOf(e).omnibox?.keyword === activeKeyword);
          activeKeyword = null;
          if (ext) routerInternals.sendEvent(ext.id, 'omnibox.onInputCancelled');
        }
        return null;
      }
      if (activeKeyword !== m.keyword) {
        activeKeyword = m.keyword;
        routerInternals.sendEvent(m.ext.id, 'omnibox.onInputStarted');
      }
      const requestId = ++omniboxSeq;
      const list = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve([]), OMNIBOX_WAIT_MS);
        omniboxWaits.set(requestId, (l) => {
          clearTimeout(timer);
          resolve(l);
        });
        routerInternals.sendEvent(m.ext.id, 'omnibox.onInputChanged', m.rest, requestId);
      });
      omniboxWaits.delete(requestId);
      const name = m.ext.name;
      const first: Suggestion = { kind: 'extension', text: m.rest || (defaultSuggestion.get(m.ext.id) ?? name), detail: defaultSuggestion.get(m.ext.id) ?? name, url: text, icon: null, fill: text };
      const more = (Array.isArray(list) ? list : [])
        .slice(0, 6)
        .map((s) => s as { content?: unknown; description?: unknown })
        .filter((s) => typeof s.content === 'string' && s.content.length < 2000)
        .map((s): Suggestion => ({ kind: 'extension', text: omniboxText(s.description) || String(s.content), detail: name, url: `${m.keyword} ${String(s.content)}`, icon: null, fill: `${m.keyword} ${String(s.content)}` }));
      return [first, ...more];
    },

    omniboxEnter(text) {
      const m = keywordMatch(text);
      if (!m) return false;
      activeKeyword = null;
      routerInternals.sendEvent(m.ext.id, 'omnibox.onInputEntered', m.rest, 'currentTab');
      return true;
    },

    actionMenuItems(extensionId) {
      try {
        return [...lib.ctx.store.buildMenuItems(extensionId, 'action'), ...lib.ctx.store.buildMenuItems(extensionId, 'browser_action')];
      } catch {
        return [];
      }
    },

    commandsOf(extensionId) {
      return commands.get(extensionId) ?? [];
    },
  };
}
