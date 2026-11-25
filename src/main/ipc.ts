import { app, clipboard, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { verifyUser } from './os-auth';
import { defaultBrowserStatus, openDefaultAppsSettings } from './default-browser';
import { updater } from './updater';
import { VaultError } from './password-vault';
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, hostOf as loginHost, isLoginOrigin } from '../shared/passwords';
import { BrowserWindowController } from './window';
import { Tab } from './tab';
import { buildSuggestions, matchesQuery, tabSuggestion, type OpenTabCandidate } from './suggestions';
import { PERMISSION_LABELS } from './permissions';
import { SITE_PERMISSIONS, type SitePermission } from './profile-store';
import { dialog } from 'electron';
import { IPC, MAX_ADDRESS_INPUT, MAX_FIND_INPUT, type DownloadAction, type OpenWhere, type Suggestion, type SuggestResult, type TopSite } from '../shared/ipc';
import { BookmarkError } from './bookmark-store';
import type { ProfileManager } from './profiles';
import { PROFILE_COLORS, PROFILE_COLOR_IDS, isProfileColor, isProfileId } from '../shared/profiles';
import type { ProfilesSnapshot } from '../shared/internal-api';
import { INTERNAL_IPC, type ClearPeriod, type ExtensionsSnapshot, type HistoryEntry, type MemoryUsage, type PasswordResult, type PasswordsSnapshot, type SettingsSnapshot } from '../shared/internal-api';
import { internalPageOf, type InternalPage } from '../shared/internal-pages';
import { resolveInput } from '../shared/omnibox';
import { SEARCH_ENGINES, type SearchEngineId } from '../shared/settings';
import { zoomPercent } from '../shared/zoom';
import { answerPasswordOffer } from './passwords';
import { WEBSTORE_ORIGIN, isExtensionId } from '../shared/extensions';
import { themeVars } from '../shared/themes';

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

const HOUR = 60 * 60 * 1000;
const CLEAR_PERIODS: Record<Exclude<ClearPeriod, 'all'>, number> = { hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 28 * 24 * HOUR };

/**
 * Toda petición IPC de la interfaz debe venir del webContents de la interfaz de una ventana conocida y de un frame
 * cuyo origen sea el de la interfaz. Cualquier otro remitente (una página web, un frame inyectado) se ignora.
 * Los ids de pestaña solo se aceptan si la pestaña pertenece a la ventana que envía el mensaje.
 */
/**
 * Pestañas abiertas del perfil de la ventana (de todas sus ventanas), las de esta ventana primero. Sin la pestaña activa
 * de esta ventana: no tiene sentido "cambiar" a la que se está viendo.
 */
function openTabsOf(c: BrowserWindowController): Array<OpenTabCandidate & { windowLabel: string }> {
  const windows = [c, ...[...BrowserWindowController.all].filter((w) => w !== c && w.ctx.profile === c.ctx.profile && !w.closing)];
  const several = windows.length > 1;
  return windows.flatMap((w, wi) =>
    w.tabs
      .filter((t) => !(w === c && t === c.active) && t.url && t.url !== 'about:blank')
      .map((t) => {
        const s = t.state;
        const icon = s.faviconKey ? (w.faviconData(s.faviconKey) ?? null) : null;
        return { id: t.id, title: s.title, url: s.url, icon, windowLabel: several ? (wi === 0 ? 'Esta ventana' : `Otra ventana`) : 'Cambiar a esta pestaña' };
      }),
  );
}

export function registerIpc(isTrustedUiUrl: (url: string) => boolean): void {
  const from = (e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindowController | undefined => {
    const c = BrowserWindowController.fromUi(e.sender);
    if (!c) return undefined;
    const frameUrl = e.senderFrame?.url ?? '';
    if (!isTrustedUiUrl(frameUrl) || e.senderFrame !== e.sender.mainFrame) return undefined;
    return c;
  };
  const tabOf = (c: BrowserWindowController, id: unknown) => (isId(id) ? c.tabs.find((t) => t.id === id) : undefined);

  ipcMain.on(IPC.uiReady, (e) => from(e)?.onUiReady());
  ipcMain.on(IPC.navigate, (e, input: unknown) => {
    const c = from(e);
    if (!c || typeof input !== 'string') return;
    c.navigateTab(c.active, input.slice(0, MAX_ADDRESS_INPUT));
  });
  ipcMain.on(IPC.goBack, (e) => from(e)?.active.goBack());
  ipcMain.on(IPC.goForward, (e) => from(e)?.active.goForward());
  ipcMain.on(IPC.reload, (e, ignoreCache: unknown) => from(e)?.active.reload(ignoreCache === true));
  ipcMain.on(IPC.stop, (e) => from(e)?.active.stop());
  ipcMain.on(IPC.dismissNotice, (e, id: unknown) => {
    if (typeof id === 'number') from(e)?.active.dismissNotice(id);
  });

  ipcMain.on(IPC.newTab, (e) => from(e)?.newTab());
  ipcMain.on(IPC.closeTab, (e, id: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab) c.closeTab(tab);
  });
  ipcMain.on(IPC.activateTab, (e, id: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab) c.activate(tab);
  });
  ipcMain.on(IPC.moveTab, (e, id: unknown, index: unknown, groupId: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (!tab || typeof index !== 'number' || !Number.isSafeInteger(index)) return;
    c.moveTab(tab, index, groupId === undefined ? undefined : isId(groupId) ? groupId : null);
  });
  ipcMain.on(IPC.groupEditor, (e, id: unknown) => from(e)?.setGroupEditor(isId(id) ? id : null));
  ipcMain.on(IPC.updateGroup, (e, id: unknown, patch: unknown) => {
    const c = from(e);
    if (c && isId(id) && isObj(patch)) c.updateGroup(id, { title: patch.title, color: patch.color, collapsed: patch.collapsed });
  });
  ipcMain.on(IPC.groupAction, (e, id: unknown, action: unknown) => {
    const c = from(e);
    if (c && isId(id) && (action === 'new-tab' || action === 'ungroup' || action === 'close' || action === 'move-to-window')) c.groupAction(id, action);
  });
  ipcMain.on(IPC.moveGroup, (e, id: unknown, index: unknown) => {
    const c = from(e);
    if (c && isId(id) && typeof index === 'number' && Number.isSafeInteger(index)) c.moveGroup(id, index);
  });
  ipcMain.handle(IPC.suggestTabs, (e, text: unknown): Suggestion[] => {
    const c = from(e);
    if (!c || typeof text !== 'string' || text.length > 1000) return [];
    return openTabsOf(c)
      .filter((t) => matchesQuery(text, t.title, t.url))
      .slice(0, 30)
      .map((t) => tabSuggestion(t, t.windowLabel));
  });
  ipcMain.on(IPC.switchToTab, (e, id: unknown) => {
    const c = from(e);
    if (!c || !isId(id)) return;
    for (const w of BrowserWindowController.all) {
      const tab = w.ctx.profile === c.ctx.profile && !w.closing ? w.tabs.find((t) => t.id === id) : undefined;
      if (tab) {
        w.activate(tab);
        w.focus();
        return;
      }
    }
  });
  ipcMain.on(IPC.toggleMute, (e, id: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab) tab.toggleMute();
  });
  ipcMain.on(IPC.titleBarColors, (e, color: unknown, symbolColor: unknown) => {
    const hex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (hex(color) && hex(symbolColor)) from(e)?.applyTitleBar({ color, symbolColor });
  });
  ipcMain.on(IPC.answerExtensionInstall, (e, id: unknown, allow: unknown) => {
    if (isId(id)) from(e)?.answerExtensionInstall(id, allow === true);
  });
  ipcMain.on(IPC.extensionMenu, (e, extensionId: unknown) => {
    if (isExtensionId(extensionId)) from(e)?.showExtensionMenu(extensionId);
  });
  ipcMain.on(IPC.answerPasswordOffer, (e, id: unknown, answer: unknown, username: unknown) => {
    const c = from(e);
    if (!c || !isId(id) || (answer !== 'save' && answer !== 'never' && answer !== 'dismiss')) return;
    const tab = c.tabs.find((t) => t.passwordOffer?.offer.id === id);
    if (tab) void answerPasswordOffer(tab, id, answer, typeof username === 'string' ? username : undefined);
  });
  ipcMain.on(IPC.tabMenu, (e, id: unknown) => {
    const c = from(e);
    if (!c) return;
    if (id === null) return c.showTabMenu(null);
    const tab = tabOf(c, id);
    if (tab) c.showTabMenu(tab);
  });
  ipcMain.on(IPC.appMenu, (e) => from(e)?.showAppMenu());

  ipcMain.on(IPC.find, (e, query: unknown, forward: unknown, newSession: unknown) => {
    const c = from(e);
    if (!c || typeof query !== 'string') return;
    c.active.find(query.slice(0, MAX_FIND_INPUT), forward !== false, newSession === true);
  });
  ipcMain.on(IPC.closeFind, (e) => from(e)?.closeFind());
  ipcMain.on(IPC.resetZoom, (e) => from(e)?.active.zoom('reset'));

  ipcMain.on(IPC.overlayHeight, (e, px: unknown) => {
    if (typeof px === 'number' && Number.isFinite(px)) from(e)?.setOverlayHeight(px);
  });
  ipcMain.on(IPC.respondPermission, (e, id: unknown, allow: unknown, remember: unknown) => {
    const c = from(e);
    if (c && isId(id)) c.active.respondPermission(id, allow === true, remember === true);
  });

  // ---------------------------------------------------------------- descargas

  ipcMain.on(IPC.answerDownload, (e, id: unknown, answer: unknown) => {
    const c = from(e);
    if (c && isId(id) && (answer === 'save' || answer === 'save-as' || answer === 'cancel')) void c.answerDownload(id, answer);
  });
  ipcMain.on(IPC.downloadAction, (e, id: unknown, action: unknown) => {
    const c = from(e);
    if (c && isId(id) && isDownloadAction(action)) runDownloadAction(c.ctx.profile.downloads, id, action);
  });
  ipcMain.on(IPC.downloadsPanel, (e, open: unknown) => from(e)?.setDownloadsPanel(open === true));
  ipcMain.on(IPC.openDownloadsPage, (e) => {
    const c = from(e);
    if (!c) return;
    c.setDownloadsPanel(false);
    c.openInternalPage('downloads');
  });

  // ---------------------------------------------------------------- favoritos

  ipcMain.on(IPC.profileMenu, (e) => from(e)?.showProfileMenu());
  ipcMain.on(IPC.toggleStar, (e) => from(e)?.toggleStar());
  ipcMain.on(IPC.bookmarkEditorSave, (e, v: unknown) => {
    const c = from(e);
    if (!c || !isObj(v) || typeof v.title !== 'string' || typeof v.url !== 'string' || !isId(v.parentId)) return;
    c.bookmarkEditorSave({ title: v.title.slice(0, 500), url: v.url.slice(0, 8192), parentId: v.parentId });
  });
  ipcMain.on(IPC.bookmarkEditorRemove, (e) => from(e)?.bookmarkEditorRemove());
  ipcMain.on(IPC.bookmarkEditorClose, (e) => from(e)?.closeBookmarkEditor());
  ipcMain.on(IPC.openBookmark, (e, id: unknown, where: unknown) => {
    const c = from(e);
    if (c && isId(id) && isOpenWhere(where)) c.openBookmark(id, where);
  });
  ipcMain.on(IPC.bookmarkMenu, (e, id: unknown) => {
    const c = from(e);
    if (c && (id === null || isId(id))) c.showBookmarkMenu(id);
  });
  ipcMain.on(IPC.bookmarkFolderMenu, (e, id: unknown) => {
    const c = from(e);
    if (c && isId(id)) c.showBookmarkFolder(id);
  });
  ipcMain.on(IPC.bookmarkOverflowMenu, (e, fromIndex: unknown) => {
    const c = from(e);
    if (c && typeof fromIndex === 'number' && Number.isSafeInteger(fromIndex)) c.showBookmarkOverflow(fromIndex);
  });
  ipcMain.on(IPC.moveBookmark, (e, id: unknown, parentId: unknown, index: unknown) => {
    const c = from(e);
    if (c && isId(id) && isId(parentId) && typeof index === 'number' && Number.isSafeInteger(index)) c.moveBookmark(id, parentId, index);
  });

  // ---------------------------------------------------------------- página de nueva pestaña

  ipcMain.handle(IPC.topSites, (e): TopSite[] => {
    const c = from(e);
    if (!c) return [];
    const profile = c.ctx.profile;
    const hidden = new Set(profile.kv.get<string[]>('ntp.hidden') ?? []);
    return profile.history.topSites(8, hidden).map((s) => ({ url: s.url, host: s.host, title: s.title, icon: s.iconUrl ? (profile.favicons.cached(s.iconUrl) ?? null) : null }));
  });
  ipcMain.on(IPC.hideTopSite, (e, host: unknown, hide: unknown) => {
    const c = from(e);
    if (!c || typeof host !== 'string' || host.length > 253) return;
    const kv = c.ctx.profile.kv;
    const hidden = (kv.get<string[]>('ntp.hidden') ?? []).filter((h) => h !== host);
    kv.set('ntp.hidden', hide === false ? hidden : [...hidden, host].slice(-200));
  });
  ipcMain.on(IPC.restoreTopSites, (e) => from(e)?.ctx.profile.kv.delete('ntp.hidden'));

  ipcMain.handle(IPC.suggest, (e, text: unknown): SuggestResult => {
    const c = from(e);
    if (!c || typeof text !== 'string' || !text.trim() || text.length > 1000) return { items: [], inline: null };
    const profile = c.ctx.profile;
    const inline = profile.history.inlineCandidate(text);
    const iconOf = (url: string) => {
      const iconUrl = profile.history.iconUrlFor(url);
      return iconUrl ? (profile.favicons.cached(iconUrl) ?? null) : null;
    };
    const items = buildSuggestions({
      tabs: openTabsOf(c),
      bookmarks: profile.bookmarks
        .search(text.slice(0, 200), 10)
        .filter((b) => b.kind === 'url' && b.url)
        .map((b) => ({ title: b.title, url: b.url!, icon: iconOf(b.url!) })),
      text,
      resolved: resolveInput(text, profile.searchTemplate),
      inline,
      history: profile.history.suggest(text),
      engineName: profile.searchEngineName,
      icon: (iconUrl) => (iconUrl ? (profile.favicons.cached(iconUrl) ?? null) : null),
    });
    return { items, inline: inline ? { completion: inline.completion, url: inline.url } : null };
  });

  registerInternalIpc();
}

// ---------------------------------------------------------------- páginas internas

/**
 * Solo una pestaña interna, desde su frame principal y mostrando la página indicada, puede usar cada parte de la API.
 * (La pestaña interna tiene su propia sesión: una página web no puede cargarse ahí.)
 */
function fromInternal(e: IpcMainEvent | IpcMainInvokeEvent, page: InternalPage) {
  const tab = Tab.fromWebContents(e.sender);
  if (!tab || tab.kind !== 'internal' || e.senderFrame !== e.sender.mainFrame) return undefined;
  if (internalPageOf(e.senderFrame?.url ?? '') !== page) return undefined;
  const win = BrowserWindowController.ofTab(tab);
  return win ? { tab, win, profile: win.ctx.profile } : undefined;
}

function denied(): never {
  throw new Error('No permitido');
}

function settingsSnapshot(profile: BrowserWindowController['ctx']['profile']): SettingsSnapshot {
  return {
    settings: profile.settings,
    engines: (Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => ({ id, name: SEARCH_ENGINES[id].name })),
    permissions: profile.permissions.list().map((p) => ({ origin: p.origin, permission: p.permission, label: PERMISSION_LABELS[p.permission], setting: p.setting })),
    zoom: profile.zoom.all().map((z) => ({ host: z.host, percent: zoomPercent(z.factor) })),
    downloadDir: profile.downloadDir,
    downloadDirIsDefault: profile.settings.downloadDir === null,
    about: { version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
  };
}

const OPEN_WHERE: readonly OpenWhere[] = ['current', 'new-tab', 'background-tab', 'new-window'];
const isOpenWhere = (v: unknown): v is OpenWhere => OPEN_WHERE.includes(v as OpenWhere);

/** Ejecuta un cambio de favoritos y devuelve el error para mostrarlo (sin romper el proceso). */
function bookmarkOp<T>(profile: BrowserWindowController['ctx']['profile'], op: () => T): { value?: T; error?: string } {
  try {
    const value = op();
    profile.emit('bookmarks-changed');
    return { value };
  } catch (e) {
    return { error: e instanceof BookmarkError ? e.message : 'No se pudo hacer el cambio.' };
  }
}

const DOWNLOAD_ACTIONS: readonly DownloadAction[] = ['pause', 'resume', 'cancel', 'open', 'show', 'retry', 'remove'];
const isDownloadAction = (v: unknown): v is DownloadAction => DOWNLOAD_ACTIONS.includes(v as DownloadAction);

function runDownloadAction(dm: BrowserWindowController['ctx']['profile']['downloads'], id: number, action: DownloadAction): void {
  switch (action) {
    case 'pause': return dm.pause(id);
    case 'resume': return dm.resume(id);
    case 'cancel': return dm.cancel(id);
    case 'open': return void dm.open(id);
    case 'show': return dm.showInFolder(id);
    case 'retry': return dm.retry(id);
    case 'remove': return dm.remove(id);
  }
}

function registerInternalIpc(): void {
  ipcMain.handle(INTERNAL_IPC.historyQuery, (e, opts: unknown): HistoryEntry[] => {
    const ctx = fromInternal(e, 'history') ?? denied();
    const o = isObj(opts) ? opts : {};
    const query = typeof o.query === 'string' ? o.query.slice(0, 500) : undefined;
    const b = isObj(o.before) ? o.before : null;
    const before = b && typeof b.time === 'number' && typeof b.id === 'number' ? { time: b.time, id: b.id } : undefined;
    const limit = typeof o.limit === 'number' ? o.limit : 100;
    return ctx.profile.history.search({ query, before, limit }).map((v) => ({
      id: v.id,
      url: v.url,
      title: v.title,
      host: v.host,
      time: v.time,
      icon: v.iconUrl ? (ctx.profile.favicons.cached(v.iconUrl) ?? null) : null,
    }));
  });

  ipcMain.handle(INTERNAL_IPC.historyDeleteVisit, (e, id: unknown) => {
    const ctx = fromInternal(e, 'history') ?? denied();
    if (isId(id)) ctx.profile.history.deleteVisit(id);
  });

  ipcMain.handle(INTERNAL_IPC.historyClear, (e, period: unknown) => {
    const ctx = fromInternal(e, 'history') ?? denied();
    if (period === 'all') ctx.profile.history.deleteAll();
    else if (typeof period === 'string' && period in CLEAR_PERIODS) {
      const now = Date.now();
      ctx.profile.history.deleteRange(now - CLEAR_PERIODS[period as keyof typeof CLEAR_PERIODS], now + 1);
    }
  });

  ipcMain.handle(INTERNAL_IPC.settingsDefaultBrowser, (e) => {
    fromInternal(e, 'settings') ?? denied();
    return defaultBrowserStatus();
  });
  ipcMain.handle(INTERNAL_IPC.settingsMemory, (e): MemoryUsage => {
    fromInternal(e, 'settings') ?? denied();
    const metrics = app.getAppMetrics();
    const tabs = [...BrowserWindowController.all].flatMap((w) => w.tabs);
    const asleep = tabs.filter((t) => t.asleep).length;
    return {
      mb: Math.round(metrics.reduce((sum, m) => sum + (m.memory.privateBytes ?? m.memory.workingSetSize), 0) / 1024),
      processes: metrics.length,
      awakeTabs: tabs.length - asleep,
      asleepTabs: asleep,
    };
  });
  ipcMain.handle(INTERNAL_IPC.settingsUpdateStatus, (e) => {
    fromInternal(e, 'settings') ?? denied();
    return { enabled: updater.enabled, status: updater.status };
  });
  ipcMain.handle(INTERNAL_IPC.settingsCheckUpdate, async (e) => {
    fromInternal(e, 'settings') ?? denied();
    await updater.check();
    return { enabled: updater.enabled, status: updater.status };
  });
  ipcMain.on(INTERNAL_IPC.settingsInstallUpdate, (e) => {
    if (fromInternal(e, 'settings')) updater.installAndRestart();
  });
  ipcMain.on(INTERNAL_IPC.settingsMakeDefault, (e) => {
    if (!fromInternal(e, 'settings')) return;
    void defaultBrowserStatus().then((s) => openDefaultAppsSettings(s.registered));
  });
  // Borrar datos de navegación (desde la configuración). En una ventana privada, los del perfil de origen (como Chrome).
  ipcMain.handle(INTERNAL_IPC.settingsClearData, async (e, req: unknown) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    if (!isObj(req)) return;
    const profile = ctx.profile.parent ?? ctx.profile;
    const period = req.period;
    if (req.history === true) {
      if (period === 'all') profile.history.deleteAll();
      else if (typeof period === 'string' && period in CLEAR_PERIODS) {
        const now = Date.now();
        profile.history.deleteRange(now - CLEAR_PERIODS[period as keyof typeof CLEAR_PERIODS], now + 1);
      }
    }
    // Los datos de las extensiones (su configuración) no se tocan, como en Chrome
    const excludeOrigins = (profile.extensions?.registry.all() ?? []).map((r) => `chrome-extension://${r.id}`);
    const exclude = excludeOrigins.length ? { excludeOrigins } : {};
    if (req.siteData === true) {
      await profile.session.clearData({ dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'], ...exclude });
      await profile.session.clearAuthCache();
    }
    if (req.cache === true) await profile.session.clearData({ dataTypes: ['cache'], ...exclude });
  });

  ipcMain.on(INTERNAL_IPC.historyOpen, (e, url: unknown, where: unknown) => {
    const ctx = fromInternal(e, 'history');
    if (!ctx || typeof url !== 'string' || url.length > 8192) return;
    if (where !== 'current' && where !== 'new-tab' && where !== 'background-tab') return;
    ctx.win.openFromInternal(ctx.tab, url, where);
  });

  ipcMain.handle(INTERNAL_IPC.settingsGet, (e) => settingsSnapshot((fromInternal(e, 'settings') ?? denied()).profile));

  ipcMain.handle(INTERNAL_IPC.settingsSet, (e, partial: unknown) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    // La carpeta de descargas no se acepta desde la página: solo con el selector de carpetas de Windows
    const { downloadDir: _ignored, ...rest } = isObj(partial) ? partial : {};
    ctx.profile.updateSettings(rest);
    return settingsSnapshot(ctx.profile);
  });

  ipcMain.handle(INTERNAL_IPC.settingsChooseDownloadDir, async (e) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    const res = await dialog.showOpenDialog(ctx.win.win, { title: 'Carpeta de descargas', defaultPath: ctx.profile.downloadDir, properties: ['openDirectory', 'createDirectory'] });
    const dir = res.filePaths[0];
    if (!res.canceled && dir) ctx.profile.updateSettings({ downloadDir: dir });
    return settingsSnapshot(ctx.profile);
  });

  ipcMain.handle(INTERNAL_IPC.settingsResetDownloadDir, (e) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    ctx.profile.updateSettings({ downloadDir: null });
    return settingsSnapshot(ctx.profile);
  });

  ipcMain.handle(INTERNAL_IPC.downloadsList, (e, query: unknown) => {
    const ctx = fromInternal(e, 'downloads') ?? denied();
    return ctx.profile.downloads.entries({ query: typeof query === 'string' ? query.slice(0, 500) : undefined, limit: 500 });
  });

  ipcMain.handle(INTERNAL_IPC.downloadsAction, (e, id: unknown, action: unknown) => {
    const ctx = fromInternal(e, 'downloads') ?? denied();
    if (isId(id) && isDownloadAction(action)) runDownloadAction(ctx.profile.downloads, id, action);
  });

  // Administrador de favoritos (callisto://bookmarks)
  const withIcons = (profile: BrowserWindowController['ctx']['profile'], nodes: ReturnType<typeof profile.bookmarks.children>) =>
    nodes.map((n) => {
      const iconUrl = n.url ? profile.history.iconUrlFor(n.url) : null;
      return { ...n, icon: iconUrl ? (profile.favicons.cached(iconUrl) ?? null) : null };
    });
  ipcMain.handle(INTERNAL_IPC.bookmarksFolders, (e) => (fromInternal(e, 'bookmarks') ?? denied()).profile.bookmarks.folders());
  ipcMain.handle(INTERNAL_IPC.bookmarksChildren, (e, id: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    return isId(id) ? withIcons(ctx.profile, ctx.profile.bookmarks.children(id)) : [];
  });
  ipcMain.handle(INTERNAL_IPC.bookmarksSearch, (e, q: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    return typeof q === 'string' ? withIcons(ctx.profile, ctx.profile.bookmarks.search(q.slice(0, 500))) : [];
  });
  ipcMain.handle(INTERNAL_IPC.bookmarksAdd, (e, parentId: unknown, title: unknown, url: unknown, index: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    if (!isId(parentId) || typeof title !== 'string' || (url !== null && typeof url !== 'string')) return { error: 'Datos no válidos.' };
    const at = typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined;
    const r = bookmarkOp(ctx.profile, () =>
      url === null ? ctx.profile.bookmarks.addFolder(parentId, title.slice(0, 500), at) : ctx.profile.bookmarks.addUrl(parentId, title.slice(0, 500), url.trim().slice(0, 8192), at),
    );
    return r.error ? { error: r.error } : { id: r.value };
  });
  ipcMain.handle(INTERNAL_IPC.bookmarksUpdate, (e, id: unknown, patch: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    if (!isId(id) || !isObj(patch)) return { error: 'Datos no válidos.' };
    const p = { title: typeof patch.title === 'string' ? patch.title.slice(0, 500) : undefined, url: typeof patch.url === 'string' ? patch.url.trim().slice(0, 8192) : undefined };
    return { error: bookmarkOp(ctx.profile, () => ctx.profile.bookmarks.update(id, p)).error };
  });
  ipcMain.handle(INTERNAL_IPC.bookmarksMove, (e, id: unknown, parentId: unknown, index: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    if (!isId(id) || !isId(parentId)) return { error: 'Datos no válidos.' };
    const at = typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined;
    return { error: bookmarkOp(ctx.profile, () => ctx.profile.bookmarks.move(id, parentId, at)).error };
  });
  ipcMain.handle(INTERNAL_IPC.bookmarksRemove, async (e, id: unknown) => {
    const ctx = fromInternal(e, 'bookmarks') ?? denied();
    if (isId(id)) await ctx.win.removeBookmark(id);
  });
  ipcMain.on(INTERNAL_IPC.bookmarksOpen, (e, url: unknown, where: unknown) => {
    const ctx = fromInternal(e, 'bookmarks');
    if (!ctx || typeof url !== 'string' || !isOpenWhere(where)) return;
    if (where === 'current') ctx.win.openFromInternal(ctx.tab, url, 'current');
    else ctx.win.openUrl(url, where);
  });

  ipcMain.on(INTERNAL_IPC.downloadsOpenFolder, (e) => fromInternal(e, 'downloads')?.profile.downloads.openFolder());

  ipcMain.handle(INTERNAL_IPC.downloadsClear, (e) => {
    (fromInternal(e, 'downloads') ?? denied()).profile.downloads.clearFinished();
  });

  ipcMain.handle(INTERNAL_IPC.settingsRemovePermission, (e, origin: unknown, permission: unknown) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    if (typeof origin === 'string' && SITE_PERMISSIONS.includes(permission as SitePermission)) {
      ctx.profile.permissions.remove(origin, permission as SitePermission);
    }
    return settingsSnapshot(ctx.profile);
  });

  ipcMain.handle(INTERNAL_IPC.settingsRemoveZoom, (e, host: unknown) => {
    const ctx = fromInternal(e, 'settings') ?? denied();
    if (typeof host === 'string') {
      ctx.profile.zoom.remove(host);
      // Las pestañas abiertas en ese sitio vuelven al 100 % (Chromium aplica el zoom por sitio a todas)
      for (const w of BrowserWindowController.all) {
        const t = w.tabs.find((tab) => tab.kind === 'web' && hostOf(tab.url) === host);
        if (t) {
          t.webContents.setZoomFactor(1);
          break;
        }
      }
      BrowserWindowController.refreshAll();
    }
    return settingsSnapshot(ctx.profile);
  });

  ipcMain.on(INTERNAL_IPC.openPage, (e, page: unknown) => {
    const tab = Tab.fromWebContents(e.sender);
    if (!tab || tab.kind !== 'internal' || !internalPageOf(e.senderFrame?.url ?? '')) return;
    if (page !== 'history' && page !== 'settings' && page !== 'downloads' && page !== 'bookmarks' && page !== 'profiles' && page !== 'passwords' && page !== 'extensions') return;
    BrowserWindowController.ofTab(tab)?.navigateTab(tab, `callisto://${page}`, false);
  });

  registerPasswordsPageIpc();
  registerExtensionsPageIpc();
  // Tema de las páginas internas: cualquiera de ellas (desde su frame principal)
  ipcMain.handle(INTERNAL_IPC.themeGet, (e) => {
    const tab = Tab.fromWebContents(e.sender);
    const win = tab && tab.kind === 'internal' && e.senderFrame === e.sender.mainFrame ? BrowserWindowController.ofTab(tab) : undefined;
    return themeVars((win?.ctx.profile ?? denied()).theme);
  });
}

// ---------------------------------------------------------------- callisto://extensions

function registerExtensionsPageIpc(): void {
  const ctxOf = (e: IpcMainInvokeEvent | IpcMainEvent) => fromInternal(e, 'extensions');
  const managerOf = (e: IpcMainInvokeEvent | IpcMainEvent) => {
    const ctx = ctxOf(e);
    return ctx ? { ctx, ext: ctx.profile.extensions } : undefined;
  };
  ipcMain.handle(INTERNAL_IPC.extensionsList, async (e): Promise<ExtensionsSnapshot> => {
    const m = managerOf(e) ?? denied();
    if (!m.ext) return { available: false, items: [] };
    await m.ext.ready;
    return { available: true, items: m.ext.list() };
  });
  ipcMain.handle(INTERNAL_IPC.extensionsSetEnabled, async (e, id: unknown, enabled: unknown) => {
    const m = managerOf(e) ?? denied();
    if (m.ext && isExtensionId(id)) await m.ext.setEnabled(id, enabled === true);
  });
  ipcMain.handle(INTERNAL_IPC.extensionsRemove, (e, id: unknown) => {
    const m = managerOf(e) ?? denied();
    if (m.ext && isExtensionId(id)) m.ext.remove(id);
  });
  ipcMain.handle(INTERNAL_IPC.extensionsUpdate, async (e) => {
    const m = managerOf(e) ?? denied();
    return { updated: m.ext ? (await m.ext.checkUpdates()).length : 0 };
  });
  ipcMain.on(INTERNAL_IPC.extensionsOptions, (e, id: unknown) => {
    const m = managerOf(e);
    const url = m?.ext && isExtensionId(id) ? m.ext.optionsUrl(id) : null;
    if (m && url) m.ctx.win.newTab({ url, index: m.ctx.win.tabs.indexOf(m.ctx.tab) + 1, openerId: m.ctx.tab.id });
  });
  ipcMain.on(INTERNAL_IPC.extensionsOpenStore, (e, id: unknown) => {
    const m = managerOf(e);
    if (!m) return;
    const url = isExtensionId(id) ? `${WEBSTORE_ORIGIN}/detail/${id}` : `${WEBSTORE_ORIGIN}/category/extensions`;
    m.ctx.win.newTab({ url, index: m.ctx.win.tabs.indexOf(m.ctx.tab) + 1, openerId: m.ctx.tab.id });
  });
}

// ---------------------------------------------------------------- callisto://passwords

/** Cuánto vale una verificación de identidad (como en Chrome): ver otra contraseña enseguida no la vuelve a pedir. */
const PASSWORD_AUTH_WINDOW = 60_000;

type InternalContext = NonNullable<ReturnType<typeof fromInternal>>;

/** Pide a Windows que verifique la identidad (Windows Hello o la contraseña de la cuenta), salvo que sea reciente. */
async function authorizePasswords(ctx: InternalContext): Promise<PasswordResult | null> {
  const root = ctx.profile.parent ?? ctx.profile;
  if (Date.now() < root.passwordsAuthorizedUntil) return null;
  const result = await verifyUser(ctx.win.win, 'Verificá tu identidad para ver o editar las contraseñas guardadas en Callisto.');
  if (result === 'verified') {
    root.passwordsAuthorizedUntil = Date.now() + PASSWORD_AUTH_WINDOW;
    return null;
  }
  return result === 'rejected' ? NOT_VERIFIED : HELLO_FAILED;
}

const NOT_VERIFIED: PasswordResult = { error: 'No se verificó tu identidad.' };
const HELLO_FAILED: PasswordResult = { error: 'Windows no pudo verificar tu identidad (no respondió Windows Hello ni el cuadro de contraseña).' };
const vaultError = (e: unknown): PasswordResult => ({ error: e instanceof VaultError ? e.message : 'No se pudo completar la operación.' });

function registerPasswordsPageIpc(): void {
  const ctxOf = (e: IpcMainInvokeEvent) => fromInternal(e, 'passwords') ?? denied();

  ipcMain.handle(INTERNAL_IPC.passwordsList, async (e, query: unknown): Promise<PasswordsSnapshot> => {
    const ctx = ctxOf(e);
    const vault = ctx.profile.passwords;
    const status = await vault.open();
    const q = typeof query === 'string' ? query.slice(0, 200) : '';
    return {
      status,
      entries: vault.list(q).map((l) => {
        const iconUrl = ctx.profile.history.iconUrlFor(`${l.origin}/`);
        return { ...l, host: loginHost(l.origin), icon: iconUrl ? (ctx.profile.favicons.cached(iconUrl) ?? null) : null };
      }),
      blocked: vault.blocked(),
      offerToSave: ctx.profile.settings.offerPasswords,
      isPrivate: ctx.profile.isPrivate,
    };
  });
  ipcMain.handle(INTERNAL_IPC.passwordsReveal, async (e, id: unknown): Promise<PasswordResult> => {
    const ctx = ctxOf(e);
    if (!isId(id) || !ctx.profile.passwords.get(id)) return { error: 'La contraseña ya no existe.' };
    const denial = await authorizePasswords(ctx);
    if (denial) return denial;
    try {
      return { password: await ctx.profile.passwords.password(id) };
    } catch (err) {
      return vaultError(err);
    }
  });
  ipcMain.handle(INTERNAL_IPC.passwordsCopy, async (e, id: unknown): Promise<PasswordResult> => {
    const ctx = ctxOf(e);
    if (!isId(id) || !ctx.profile.passwords.get(id)) return { error: 'La contraseña ya no existe.' };
    const denial = await authorizePasswords(ctx);
    if (denial) return denial;
    try {
      clipboard.writeText(await ctx.profile.passwords.password(id));
      return {};
    } catch (err) {
      return vaultError(err);
    }
  });
  ipcMain.handle(INTERNAL_IPC.passwordsUpdate, async (e, id: unknown, patch: unknown): Promise<PasswordResult> => {
    const ctx = ctxOf(e);
    if (!isId(id) || !isObj(patch) || !ctx.profile.passwords.get(id)) return { error: 'La contraseña ya no existe.' };
    const username = typeof patch.username === 'string' ? patch.username.trim() : undefined;
    const password = typeof patch.password === 'string' ? patch.password : undefined;
    if ((username !== undefined && username.length > MAX_USERNAME_LENGTH) || (password !== undefined && password.length > MAX_PASSWORD_LENGTH)) return { error: 'Es demasiado largo.' };
    if (password !== undefined && !password) return { error: 'La contraseña no puede estar vacía.' };
    const denial = await authorizePasswords(ctx);
    if (denial) return denial;
    try {
      await ctx.profile.passwords.update(id, { username, password });
      return {};
    } catch (err) {
      return vaultError(err);
    }
  });
  ipcMain.handle(INTERNAL_IPC.passwordsRemove, (e, id: unknown) => {
    const ctx = ctxOf(e);
    if (isId(id)) ctx.profile.passwords.remove(id);
  });
  ipcMain.handle(INTERNAL_IPC.passwordsUnblock, (e, origin: unknown) => {
    const ctx = ctxOf(e);
    if (isLoginOrigin(origin)) ctx.profile.passwords.unblock(origin);
  });
  ipcMain.handle(INTERNAL_IPC.passwordsSetOffer, (e, on: unknown) => {
    const ctx = ctxOf(e);
    ctx.profile.updateSettings({ offerPasswords: on === true });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- administrar perfiles (callisto://profiles)

/** API de la página de perfiles. Solo responde a esa página; crear, cambiar y eliminar pasan por el gestor. */
export function registerProfilesIpc(manager: ProfileManager): void {
  const snapshot = (currentId: string): ProfilesSnapshot => ({
    profiles: manager.list().map((p) => ({ id: p.id, name: p.name, color: p.color, windows: manager.windowCount(p.id), current: p.id === currentId })),
    colors: PROFILE_COLOR_IDS.map((id) => ({ id, name: PROFILE_COLORS[id].name, hex: PROFILE_COLORS[id].hex })),
  });
  const currentOf = (ctx: NonNullable<ReturnType<typeof fromInternal>>) => (ctx.profile.parent ?? ctx.profile).id;

  ipcMain.handle(INTERNAL_IPC.profilesList, (e) => {
    const ctx = fromInternal(e, 'profiles') ?? denied();
    return snapshot(currentOf(ctx));
  });
  ipcMain.handle(INTERNAL_IPC.profilesCreate, (e, name: unknown, color: unknown) => {
    fromInternal(e, 'profiles') ?? denied();
    if (typeof name !== 'string' || !isProfileColor(color)) return { error: 'Datos no válidos.' };
    manager.create(name, color);
    return {};
  });
  ipcMain.handle(INTERNAL_IPC.profilesUpdate, (e, id: unknown, patch: unknown) => {
    fromInternal(e, 'profiles') ?? denied();
    if (!isProfileId(id) || !isObj(patch)) return { error: 'Datos no válidos.' };
    try {
      manager.update(id, { name: typeof patch.name === 'string' ? patch.name : undefined, color: isProfileColor(patch.color) ? patch.color : undefined });
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se pudo cambiar el perfil.' };
    }
  });
  ipcMain.handle(INTERNAL_IPC.profilesRemove, async (e, id: unknown) => {
    const ctx = fromInternal(e, 'profiles') ?? denied();
    if (!isProfileId(id)) return { error: 'Datos no válidos.' };
    const info = manager.list().find((p) => p.id === id);
    if (!info) return { error: 'El perfil no existe.' };
    if (manager.list().length <= 1) return { error: 'Tiene que quedar al menos un perfil.' };
    const res = await dialog.showMessageBox(ctx.win.win, {
      type: 'warning',
      title: 'Eliminar perfil',
      message: `¿Eliminar el perfil «${info.name}»?`,
      detail: 'Se borran su historial, favoritos, cookies, sesiones iniciadas y datos de sitios, y se cierran sus ventanas. Los archivos que descargaste no se tocan.',
      buttons: ['Eliminar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (res.response !== 0) return { cancelled: true };
    try {
      await manager.remove(id);
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'No se pudo eliminar el perfil.' };
    }
  });
  ipcMain.on(INTERNAL_IPC.profilesOpen, (e, id: unknown) => {
    if (fromInternal(e, 'profiles') && isProfileId(id) && manager.list().some((p) => p.id === id)) manager.openProfile(id);
  });
}
