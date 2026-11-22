import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { BrowserWindowController } from './window';
import { Tab } from './tab';
import { buildSuggestions } from './suggestions';
import { PERMISSION_LABELS } from './permissions';
import { SITE_PERMISSIONS, type SitePermission } from './profile-store';
import { IPC, MAX_ADDRESS_INPUT, MAX_FIND_INPUT, type SuggestResult } from '../shared/ipc';
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
  };
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
    ctx.profile.updateSettings(partial);
    return settingsSnapshot(ctx.profile);
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
    if (page !== 'history' && page !== 'settings') return;
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
