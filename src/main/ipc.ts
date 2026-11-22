import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { BrowserWindowController } from './window';
import { Tab } from './tab';
import { buildSuggestions } from './suggestions';
import { PERMISSION_LABELS } from './permissions';
import { SITE_PERMISSIONS, type SitePermission } from './profile-store';
import { dialog } from 'electron';
import { IPC, MAX_ADDRESS_INPUT, MAX_FIND_INPUT, type DownloadAction, type OpenWhere, type SuggestResult, type TopSite } from '../shared/ipc';
import { BookmarkError } from './bookmark-store';
import { INTERNAL_IPC, type ClearPeriod, type HistoryEntry, type SettingsSnapshot } from '../shared/internal-api';
import { internalPageOf, type InternalPage } from '../shared/internal-pages';
import { resolveInput } from '../shared/omnibox';
import { SEARCH_ENGINES, type SearchEngineId } from '../shared/settings';
import { zoomPercent } from '../shared/zoom';

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

const HOUR = 60 * 60 * 1000;
const CLEAR_PERIODS: Record<Exclude<ClearPeriod, 'all'>, number> = { hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 28 * 24 * HOUR };

/**
 * Toda petición IPC de la interfaz debe venir del webContents de la interfaz de una ventana conocida y de un frame
 * cuyo origen sea el de la interfaz. Cualquier otro remitente (una página web, un frame inyectado) se ignora.
 * Los ids de pestaña solo se aceptan si la pestaña pertenece a la ventana que envía el mensaje.
 */
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
  ipcMain.on(IPC.moveTab, (e, id: unknown, index: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab && typeof index === 'number' && Number.isSafeInteger(index)) c.moveTab(tab, index);
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
    const items = buildSuggestions({
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
    if (page !== 'history' && page !== 'settings' && page !== 'downloads' && page !== 'bookmarks') return;
    BrowserWindowController.ofTab(tab)?.navigateTab(tab, `callisto://${page}`, false);
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
