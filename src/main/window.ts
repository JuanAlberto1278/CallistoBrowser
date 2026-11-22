import { basename, join } from 'node:path';
import { app, BaseWindow, clipboard, dialog, Menu, screen, WebContentsView, type BrowserWindowConstructorOptions, type ContextMenuParams, type Event, type Input, type MenuItemConstructorOptions, type Rectangle, type Referrer, type Session, type WebContents } from 'electron';
import { Tab, type TabKind } from './tab';
import { showWindow } from './test-mode';
import type { Profile } from './profile';
import { matchShortcut, type ShortcutAction } from './shortcuts';
import type { ClosedTabs, TabSnapshot } from './closed-tabs';
import { appMenuTemplate, pageMenuTemplate, tabMenuTemplate, uiEditMenuTemplate, type EditCommand } from './context-menu';
import { trimSnapshot, type SavedTab, type SavedWindow } from './session-store';
import { IPC, MAX_OVERLAY_HEIGHT, type BookmarksUiState, type DownloadsUiState, type OpenWhere, type WindowState } from '../shared/ipc';
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, isBookmarkableUrl, type BookmarkEditorState, type BookmarkNode } from '../shared/bookmarks';
import { bookmarkItemMenu, bookmarksSubmenu, folderMenu, nodesMenu } from './bookmark-menus';
import { sanitizeFileName, siteOf } from '../shared/downloads';
import { chromeHeight } from '../shared/layout';
import { childInsertIndex, cycleIndex, indexAfterClose, moveItem } from '../shared/tab-order';
import { resolveInput, searchUrl, type ResolvedInput } from '../shared/omnibox';
import { internalPageOf, internalUrl, type InternalPage } from '../shared/internal-pages';

/** Guardado de la sesión: cada cambio lo marca; al cerrar la última ventana se guarda en el acto. */
export interface SessionSaver {
  markDirty(): void;
  windowClosing(w: BrowserWindowController): void;
  /** Guarda ya, con todas las ventanas abiertas, y deja de guardar (salida de la app). */
  finalSave(): void;
}

export interface WindowContext {
  profile: Profile;
  uiSession: Session;
  uiUrl: string;
  uiPreload: string;
  closedTabs: ClosedTabs;
  session: SessionSaver;
}

export interface WindowOptions {
  /** URL de la primera pestaña (si no se pasan pestañas). */
  url?: string;
  referrer?: Referrer;
  /** Pestañas ya existentes que pasan a esta ventana (abiertas por una página, movidas desde otra ventana). */
  tabs?: Tab[];
  /** Pestañas a restaurar (ventana cerrada que se reabre, o sesión anterior): se cargan al activarlas. */
  restore?: { tabs: SavedTab[]; active: number };
  /** Posición y tamaño guardados. */
  bounds?: Rectangle;
  maximized?: boolean;
  /** Tamaño pedido por un popup (window.open con dimensiones). */
  popupSize?: { width?: number; height?: number };
}

type FocusMode = 'auto' | 'page' | 'none';

interface Attached {
  dispose(): void;
}

let nextWindowId = 1;

const DEFAULT_SIZE = { width: 1280, height: 860 };

/** Posición inicial: la guardada si sigue visible en alguna pantalla; si no, un tamaño que entre en la pantalla. */
function initialBounds(opts: WindowOptions): Partial<Rectangle> {
  const work = screen.getPrimaryDisplay().workArea;
  const saved = opts.bounds;
  if (saved) {
    const area = screen.getDisplayMatching(saved).workArea;
    const visibleW = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const visibleH = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    if (visibleW >= 120 && visibleH >= 60) {
      return { x: saved.x, y: saved.y, width: Math.min(Math.max(400, saved.width), area.width), height: Math.min(Math.max(300, saved.height), area.height) };
    }
  }
  const popup = opts.popupSize;
  const width = popup?.width ? Math.max(400, popup.width) : DEFAULT_SIZE.width;
  const height = popup?.height ? Math.max(300, popup.height + chromeHeight({ notice: false, find: false })) : DEFAULT_SIZE.height;
  return { width: Math.min(width, work.width), height: Math.min(height, work.height) };
}

/** Pestaña restaurable a partir de un historial (pestaña o ventana cerrada). */
export function savedFromSnapshot(s: TabSnapshot): SavedTab {
  const e = s.entries[s.index] ?? s.entries[s.entries.length - 1]!;
  return { ...s, url: e.url, title: e.title, faviconKey: null };
}

/**
 * Ventana del navegador: la interfaz (pestañas, barra de herramientas, avisos, búsqueda) arriba y la pestaña activa
 * debajo. La interfaz corre en su propia sesión interna, separada de las páginas web.
 */
export class BrowserWindowController {
  static readonly all = new Set<BrowserWindowController>();

  static fromUi(wc: WebContents): BrowserWindowController | undefined {
    for (const c of this.all) if (c.uiContents === wc) return c;
    return undefined;
  }

  static ofTab(tab: Tab): BrowserWindowController | undefined {
    for (const c of this.all) if (c.tabs.includes(tab)) return c;
    return undefined;
  }

  /** La ventana enfocada o, si no hay, la última usada. */
  static current(): BrowserWindowController | undefined {
    const focused = BaseWindow.getFocusedWindow();
    for (const c of this.all) if (c.win === focused) return c;
    return this.lastFocused && this.all.has(this.lastFocused) ? this.lastFocused : [...this.all].pop();
  }

  private static lastFocused: BrowserWindowController | undefined;

  readonly id = nextWindowId++;
  readonly win: BaseWindow;
  readonly ui: WebContentsView;
  /** Contenido de la interfaz (referencia propia: Electron vacía `ui.webContents` cuando se destruye). */
  private readonly uiContents: WebContents;
  tabs: Tab[] = [];
  private activeTab!: Tab;
  private readonly attached = new Map<Tab, Attached>();
  private uiReady = false;
  private stateQueued = false;
  private readonly sentFavicons = new Set<string>();
  private readonly favicons = new Map<string, string>();
  /** La ventana se está cerrando: sus pestañas ya no van a "cerradas" una por una ni a la sesión. */
  closing = false;
  /** Alto del panel de sugerencias abierto sobre la página (0 = cerrado). */
  private overlayHeight = 0;
  /** Panel de descargas abierto (debajo del botón de descargas). */
  private downloadsPanelOpen = false;
  /** Editor de favoritos abierto (bajo la estrella o bajo la barra). */
  private bookmarkEditor: BookmarkEditorState | null = null;

  constructor(readonly ctx: WindowContext, opts: WindowOptions = {}) {
    this.win = new BaseWindow({ ...initialBounds(opts), show: false, minWidth: 400, minHeight: 300, title: 'Callisto', backgroundColor: '#f7f7f7' });
    showWindow(this.win);
    if (opts.maximized) this.win.maximize();

    this.ui = new WebContentsView({
      webPreferences: {
        session: ctx.uiSession,
        preload: ctx.uiPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    // Transparente: el panel de sugerencias se superpone a la página y alrededor tiene que verse la página
    this.ui.setBackgroundColor('#00000000');
    this.uiContents = this.ui.webContents;
    this.win.contentView.addChildView(this.ui);

    // La interfaz nunca navega ni abre ventanas.
    this.uiContents.on('will-navigate', (e) => e.preventDefault());
    this.uiContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.uiContents.on('before-input-event', (e, input) => this.onInput(e, input, false));
    this.uiContents.on('context-menu', (_e, params) => { void this.showUiMenu(params); });

    this.win.on('resize', () => {
      this.layout();
      this.ctx.session.markDirty();
    });
    this.win.on('move', () => this.ctx.session.markDirty());
    this.win.on('focus', () => { BrowserWindowController.lastFocused = this; });
    // Windows va a cerrar la sesión o apagarse: se guardan todas las ventanas antes de que se cierren una por una
    this.win.on('query-session-end', () => this.ctx.session.finalSave());
    this.win.on('close', () => {
      // Si quedan otras ventanas, esta va a "cerradas recientemente"; si es la última, queda como sesión guardada.
      if (BrowserWindowController.all.size > 1) this.recordClosedWindow();
      // Descargas esperando autorización en esta ventana: pasan a otra; si no queda ninguna, se rechazan (nada se guarda)
      const other = [...BrowserWindowController.all].find((w) => w !== this && !w.closing);
      for (const r of ctx.profile.downloads.requestsFor(this.id)) r.windowId = other ? other.id : null;
      ctx.profile.downloads.denyWithoutWindow();
      if (other) other.queueState();
      this.ctx.session.windowClosing(this);
      this.closing = true;
    });
    this.win.on('closed', () => {
      this.closing = true;
      BrowserWindowController.all.delete(this);
      for (const tab of this.tabs) {
        this.attached.get(tab)?.dispose();
        tab.destroy();
      }
      this.tabs = [];
      this.attached.clear();
      if (!this.uiContents.isDestroyed()) this.uiContents.close();
      this.ctx.session.markDirty();
    });

    BrowserWindowController.all.add(this);
    BrowserWindowController.lastFocused = this;

    if (opts.tabs?.length) {
      opts.tabs.forEach((t, i) => this.insertTab(t, i, i === 0));
    } else if (opts.restore?.tabs.length) {
      // Se agregan todas sin activar (quedan sin cargar) y después se activa, y carga, solo la que estaba activa
      const active = Math.max(0, Math.min(opts.restore.active, opts.restore.tabs.length - 1));
      opts.restore.tabs.forEach((s, i) => this.insertTab(new Tab(ctx.profile, { pending: s }), i, false, 'page', false));
      this.activate(this.tabs[active]!, { focus: 'page' });
    } else {
      const t = this.createTab(opts.url);
      this.insertTab(t, 0, true);
      t.loadURL(opts.url ?? 'about:blank', opts.referrer);
    }

    this.uiContents.loadURL(ctx.uiUrl).catch(() => {});
  }

  get active(): Tab {
    return this.activeTab;
  }

  // ---------------------------------------------------------------- pestañas

  private createTab(url: string | undefined, opts: { adopt?: BrowserWindowConstructorOptions; openerId?: number | null } = {}): Tab {
    const kind: TabKind = url && internalPageOf(url) ? 'internal' : 'web';
    // Sin dirección ni contenido de una página: pestaña nueva del usuario, con su página de nueva pestaña
    const newTabPage = !url && !opts.adopt;
    return new Tab(this.ctx.profile, { kind, adopt: opts.adopt, openerId: opts.openerId ?? null, newTabPage });
  }

  /**
   * Agrega una pestaña a esta ventana en la posición indicada. `focus`: 'auto' enfoca la barra de direcciones si la
   * pestaña está vacía y la página si no; 'page' enfoca siempre la página (contenido que todavía no empezó a cargar).
   */
  insertTab(tab: Tab, index: number, activate: boolean, focus: FocusMode = 'auto', activateIfFirst = true): void {
    const i = Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(i, 0, tab);
    this.attach(tab);
    // Debajo de la interfaz (índice 0 = al fondo)
    this.win.contentView.addChildView(tab.view, 0);
    tab.view.setVisible(false);
    if (activate || (!this.activeTab && activateIfFirst)) this.activate(tab, { focus });
    else this.queueState();
  }

  /** Crea una pestaña nueva. Por defecto al final y activa. */
  newTab(opts: { url?: string; referrer?: Referrer; index?: number; activate?: boolean; openerId?: number | null; adopt?: BrowserWindowConstructorOptions } = {}): Tab {
    const tab = this.createTab(opts.url, { adopt: opts.adopt, openerId: opts.openerId });
    const hasContent = !!opts.adopt || (!!opts.url && opts.url !== 'about:blank');
    this.insertTab(tab, opts.index ?? this.tabs.length, opts.activate ?? true, hasContent ? 'page' : 'auto');
    if (!opts.adopt) tab.loadURL(opts.url ?? 'about:blank', opts.referrer);
    return tab;
  }

  /** Pestaña hija de `opener` (enlaces): a la derecha de su pestaña de origen y de las hijas anteriores. */
  private childIndex(opener: Tab): number {
    return childInsertIndex(this.tabs.map((t) => t.openerId), this.tabs.indexOf(opener), opener.id);
  }

  /**
   * Navega una pestaña a lo que escribió el usuario. Las páginas internas y las web usan sesiones distintas: si hay
   * que pasar de una a otra, la pestaña se reemplaza por una nueva en el mismo lugar.
   */
  navigateTab(tab: Tab, input: string, typed = true): boolean {
    const resolved = resolveInput(input, this.ctx.profile.searchTemplate);
    if (!resolved) return false;
    this.openResolved(tab, resolved, typed);
    return true;
  }

  private openResolved(tab: Tab, resolved: ResolvedInput, typed: boolean): void {
    const kind: TabKind = resolved.kind === 'internal' ? 'internal' : 'web';
    const target = kind === tab.kind ? tab : this.replaceTab(tab, kind);
    target.openResolved(resolved, typed);
    if (target === this.activeTab) target.webContents.focus();
  }

  /** Reemplaza una pestaña por otra vacía de otro tipo, en la misma posición. */
  private replaceTab(old: Tab, kind: TabKind): Tab {
    const index = this.tabs.indexOf(old);
    const wasActive = old === this.activeTab;
    const tab = new Tab(this.ctx.profile, { kind, openerId: old.openerId });
    this.insertTab(tab, index, wasActive, 'page');
    this.removeTab(old, { record: false, destroy: true });
    return tab;
  }

  /** Abre una página interna: si ya está abierta en esta ventana, la muestra; si no, en una pestaña nueva. */
  openInternalPage(page: InternalPage): void {
    const existing = this.tabs.find((t) => t.internalPage === page);
    if (existing) return this.activate(existing);
    this.newTab({ url: internalUrl(page), index: this.childIndex(this.activeTab), openerId: this.activeTab.id });
  }

  /** Abre una dirección elegida en una página interna (historial). */
  openFromInternal(source: Tab, url: string, where: 'current' | 'new-tab' | 'background-tab'): void {
    if (!/^(https?|file):/i.test(url)) return;
    if (where === 'current') {
      this.openResolved(source, { kind: 'url', url, upgradedToHttps: false }, false);
      return;
    }
    this.newTab({ url, index: this.childIndex(source), activate: where === 'new-tab', openerId: source.id });
  }

  private attach(tab: Tab): void {
    tab.openHandler = (opener, options, disposition) => this.openFromPage(opener, options, disposition);
    const onState = () => this.queueState();
    const onInput = (e: Event, input: Input) => this.onInput(e, input, true, tab);
    const onMenu = (params: ContextMenuParams) => this.showPageMenu(tab, params);
    const onClosedByPage = () => this.removeTab(tab, { record: false, destroy: false });
    const onZoom = () => BrowserWindowController.refreshAll();
    const onFavicon = (key: string, data: string) => {
      this.favicons.set(key, data);
      this.queueState();
    };
    tab.on('state-changed', onState);
    tab.on('input', onInput);
    tab.on('context-menu', onMenu);
    tab.on('closed-by-page', onClosedByPage);
    tab.on('zoom-changed', onZoom);
    tab.on('favicon', onFavicon);
    this.attached.set(tab, {
      dispose: () => {
        tab.off('state-changed', onState);
        tab.off('input', onInput);
        tab.off('context-menu', onMenu);
        tab.off('closed-by-page', onClosedByPage);
        tab.off('zoom-changed', onZoom);
        tab.off('favicon', onFavicon);
        tab.openHandler = null;
      },
    });
  }

  /** Saca la pestaña de esta ventana sin destruirla (para moverla a otra). */
  private detach(tab: Tab): void {
    this.attached.get(tab)?.dispose();
    this.attached.delete(tab);
    this.win.contentView.removeChildView(tab.view);
  }

  activate(tab: Tab, opts: { focus?: FocusMode } = {}): void {
    if (!this.tabs.includes(tab)) return;
    const previous = this.activeTab;
    this.activeTab = tab;
    if (previous && previous !== tab && this.tabs.includes(previous)) previous.view.setVisible(false);
    tab.ensureLoaded(); // pestaña restaurada: se carga recién ahora
    tab.view.setVisible(true);
    this.layout();
    this.queueState();
    if (opts.focus !== 'none') this.focusContent(opts.focus ?? 'auto');
  }

  /** Enfoca la página activa, o la barra de direcciones si la pestaña está vacía. */
  private focusContent(mode: FocusMode = 'auto'): void {
    if (!this.uiReady) return;
    if (mode === 'auto' && this.activeTab.isBlank) this.focusAddressBar();
    else this.activeTab.webContents.focus();
  }

  closeTab(tab: Tab): void {
    this.removeTab(tab, { record: true, destroy: true });
  }

  private removeTab(tab: Tab, opts: { record: boolean; destroy: boolean }): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    if (opts.record && !this.closing) {
      this.ctx.closedTabs.push({ kind: 'tab', windowId: this.id, index, tab: trimSnapshot(tab.snapshot()) });
    }
    const wasActive = tab === this.activeTab;
    const countBefore = this.tabs.length;
    this.detach(tab);
    this.tabs.splice(index, 1);
    if (opts.destroy) tab.destroy();

    if (this.tabs.length === 0) {
      if (!this.win.isDestroyed()) this.win.close();
      return;
    }
    if (wasActive) this.activate(this.tabs[indexAfterClose(countBefore, index)]!);
    else this.queueState();
  }

  closeOtherTabs(keep: Tab): void {
    for (const t of this.tabs.filter((t) => t !== keep)) this.closeTab(t);
    this.activate(keep);
  }

  closeTabsToRight(of: Tab): void {
    const i = this.tabs.indexOf(of);
    for (const t of this.tabs.slice(i + 1).reverse()) this.closeTab(t);
  }

  moveTab(tab: Tab, index: number): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs = moveItem(this.tabs, from, index);
    this.queueState();
  }

  /** Pasa la pestaña a una ventana nueva, con todo su estado (no se recarga). */
  moveToNewWindow(tab: Tab): BrowserWindowController | undefined {
    if (this.tabs.length < 2 || !this.tabs.includes(tab)) return undefined;
    this.removeTab(tab, { record: false, destroy: false });
    tab.openerId = null;
    return new BrowserWindowController(this.ctx, { tabs: [tab] });
  }

  duplicate(tab: Tab): Tab {
    const copy = new Tab(this.ctx.profile, { kind: tab.kind, openerId: tab.id });
    this.insertTab(copy, this.tabs.indexOf(tab) + 1, true, 'page');
    copy.restore(tab.snapshot());
    return copy;
  }

  reopenClosed(): void {
    const entry = this.ctx.closedTabs.pop();
    if (!entry) return;
    if (entry.kind === 'window') {
      new BrowserWindowController(this.ctx, { restore: { tabs: entry.tabs.map(savedFromSnapshot), active: entry.active } });
      return;
    }
    // Vuelve a su ventana si sigue abierta; si no, a esta.
    const target = [...BrowserWindowController.all].find((w) => w.id === entry.windowId) ?? this;
    const tab = new Tab(this.ctx.profile, { pending: savedFromSnapshot(entry.tab) });
    target.insertTab(tab, entry.index, true, 'page');
    if (target !== this) target.focus();
  }

  /** Contenido abierto por una página: pestaña nueva en esta ventana, o ventana nueva para los popups. */
  private openFromPage(opener: Tab, options: BrowserWindowConstructorOptions, disposition: string): Tab {
    if (disposition === 'new-window') {
      const tab = new Tab(this.ctx.profile, { adopt: options });
      new BrowserWindowController(this.ctx, { tabs: [tab], popupSize: { width: options.width, height: options.height } });
      return tab;
    }
    const background = disposition === 'background-tab';
    return this.newTab({ adopt: options, index: this.childIndex(opener), activate: !background, openerId: opener.id });
  }

  // ---------------------------------------------------------------- estado hacia la interfaz

  private layout(): void {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const tab = this.activeTab;
    const top = chromeHeight({ notice: !!tab?.notice, find: !!tab?.findOpen, permission: !!tab?.hasPermissionPrompt, bookmarksBar: this.barVisible() });
    // La página de nueva pestaña la dibuja la interfaz: ocupa toda la ventana
    const uiHeight = tab?.showsNewTabPage ? height : Math.min(height, top + this.overlayHeight);
    this.ui.setBounds({ x: 0, y: 0, width, height: uiHeight });
    tab?.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  setOverlayHeight(px: number): void {
    const h = Math.max(0, Math.min(Math.round(px), MAX_OVERLAY_HEIGHT));
    if (h === this.overlayHeight) return;
    this.overlayHeight = h;
    this.layout();
  }

  queueState(): void {
    this.ctx.session.markDirty();
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => {
      this.stateQueued = false;
      this.sendState();
    });
  }

  private sendState(): void {
    // La pestaña activa ya no es de esta ventana: la ventana se está cerrando (p. ej. un popup que se cerró solo)
    if (this.win.isDestroyed() || !this.activeTab || !this.tabs.includes(this.activeTab)) return;
    this.layout();
    const state: WindowState = {
      tabs: this.tabs.map((t) => t.state),
      activeTabId: this.activeTab.id,
      searchEngine: this.ctx.profile.searchEngineName,
      downloads: this.downloadsState(),
      bookmarks: this.bookmarksState(),
    };
    // La ventana se está cerrando (su última pestaña ya salió, p. ej. un popup que se cerró solo): no hay nada que mostrar
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (!active) return;
    const blank = !active.url || active.url === 'about:blank';
    this.win.setTitle(`${!blank && active.title ? active.title : 'Nueva pestaña'} — Callisto`);
    if (!this.uiReady || this.uiContents.isDestroyed()) return;

    // Favicons: se envían una sola vez por ventana; el estado solo lleva la clave.
    const fresh: Record<string, string> = {};
    for (const t of state.tabs) {
      const key = t.faviconKey;
      if (!key || this.sentFavicons.has(key)) continue;
      const data = this.favicons.get(key) ?? this.findFavicon(key);
      if (!data) continue;
      fresh[key] = data;
      this.sentFavicons.add(key);
    }
    if (Object.keys(fresh).length) this.uiContents.send(IPC.favicons, fresh);
    this.uiContents.send(IPC.state, state);
  }

  /** Favicon que trajo una pestaña movida desde otra ventana, o guardado de la sesión anterior. */
  private findFavicon(key: string): string | undefined {
    for (const w of BrowserWindowController.all) {
      const d = w.favicons.get(key);
      if (d) {
        this.favicons.set(key, d);
        return d;
      }
    }
    const saved = this.ctx.profile.favicons.cached(key);
    if (saved) this.favicons.set(key, saved);
    return saved;
  }

  // ---------------------------------------------------------------- favoritos

  /** ¿Se muestra la barra de favoritos? (siempre, nunca o solo en pestañas nuevas, según la configuración) */
  private barVisible(): boolean {
    const setting = this.ctx.profile.settings.bookmarksBar;
    return setting === 'always' || (setting === 'newtab' && !!this.activeTab?.showsNewTabPage);
  }

  private iconFor(url: string | null): string | null {
    if (!url) return null;
    const iconUrl = this.ctx.profile.history.iconUrlFor(url);
    return iconUrl ? (this.ctx.profile.favicons.cached(iconUrl) ?? null) : null;
  }

  private bookmarksState(): BookmarksUiState {
    const store = this.ctx.profile.bookmarks;
    const visible = this.barVisible();
    const url = this.activeTab.url;
    const starrable = isBookmarkableUrl(url) && this.activeTab.state.security !== 'error';
    return {
      barVisible: visible,
      bar: visible ? store.children(BAR_FOLDER_ID).map((n) => ({ ...n, icon: this.iconFor(n.url) })) : [],
      starred: starrable && !!store.findByUrl(url),
      starrable,
      editor: this.bookmarkEditor,
    };
  }

  private bookmarksChanged(): void {
    this.ctx.profile.emit('bookmarks-changed');
  }

  /** Carpetas donde se puede guardar `node` (una carpeta no puede ir dentro de sí misma). */
  private folderOptions(node?: BookmarkNode): BookmarkEditorState['folders'] {
    const all = this.ctx.profile.bookmarks.folders();
    if (node?.kind !== 'folder') return all;
    const i = all.findIndex((f) => f.id === node.id);
    if (i < 0) return all;
    let end = i + 1;
    while (end < all.length && all[end]!.depth > all[i]!.depth) end++;
    return [...all.slice(0, i), ...all.slice(end)];
  }

  /** Estrella / Ctrl+D: agrega la página (a la última carpeta usada) o abre el editor si ya es favorito. */
  toggleStar(): void {
    const tab = this.activeTab;
    const url = tab.url;
    if (!isBookmarkableUrl(url) || tab.state.security === 'error') return;
    const store = this.ctx.profile.bookmarks;
    const existing = store.findByUrl(url);
    if (existing) {
      this.openBookmarkEditor(existing.id, { justAdded: false, anchor: 'star' });
      return;
    }
    const last = this.ctx.profile.kv.get<number>('bookmarks.lastFolder');
    const parent = last && store.get(last)?.kind === 'folder' ? last : BAR_FOLDER_ID;
    const id = store.addUrl(parent, tab.state.title || url, url);
    this.bookmarksChanged();
    this.openBookmarkEditor(id, { justAdded: true, anchor: 'star' });
  }

  openBookmarkEditor(id: number, opts: { justAdded: boolean; anchor: 'star' | 'bar' }): void {
    const node = this.ctx.profile.bookmarks.get(id);
    if (!node || node.parentId === null) return;
    this.bookmarkEditor = {
      mode: 'edit',
      id,
      kind: node.kind,
      title: node.title,
      url: node.url ?? '',
      parentId: node.parentId,
      folders: this.folderOptions(node),
      justAdded: opts.justAdded,
      anchor: opts.anchor,
      error: null,
    };
    this.queueState();
  }

  /** "Agregar página…" / "Agregar carpeta…": editor vacío (la página se completa con la pestaña activa). */
  openNewBookmarkEditor(kind: 'url' | 'folder', parentId = BAR_FOLDER_ID): void {
    const tab = this.activeTab;
    const usable = isBookmarkableUrl(tab.url);
    this.bookmarkEditor = {
      mode: kind === 'url' ? 'new-page' : 'new-folder',
      id: null,
      kind,
      title: kind === 'url' && usable ? tab.state.title : '',
      url: kind === 'url' && usable ? tab.url : '',
      parentId,
      folders: this.folderOptions(),
      justAdded: false,
      anchor: 'bar',
      error: null,
    };
    this.queueState();
  }

  bookmarkEditorSave(values: { title: string; url: string; parentId: number }): void {
    const ed = this.bookmarkEditor;
    if (!ed) return;
    const store = this.ctx.profile.bookmarks;
    try {
      if (ed.mode === 'edit' && ed.id !== null) {
        store.update(ed.id, ed.kind === 'url' ? { title: values.title, url: values.url.trim() } : { title: values.title });
        if (values.parentId !== ed.parentId) store.move(ed.id, values.parentId);
      } else if (ed.mode === 'new-page') {
        store.addUrl(values.parentId, values.title, normalizeBookmarkUrl(values.url));
      } else {
        store.addFolder(values.parentId, values.title);
      }
    } catch (e) {
      this.bookmarkEditor = { ...ed, ...values, error: e instanceof Error ? e.message : 'No se pudo guardar.' };
      this.queueState();
      return;
    }
    if (ed.kind === 'url') this.ctx.profile.kv.set('bookmarks.lastFolder', values.parentId);
    this.bookmarkEditor = null;
    this.bookmarksChanged();
  }

  /** "Quitar" en el editor: borra el favorito (o descarta uno nuevo). */
  bookmarkEditorRemove(): void {
    const ed = this.bookmarkEditor;
    this.bookmarkEditor = null;
    if (ed?.mode === 'edit' && ed.id !== null) {
      void this.removeBookmark(ed.id);
      return;
    }
    this.queueState();
  }

  closeBookmarkEditor(): void {
    if (!this.bookmarkEditor) return;
    this.bookmarkEditor = null;
    this.queueState();
  }

  /** Borra un favorito; una carpeta con contenido, después de confirmar. */
  async removeBookmark(id: number): Promise<void> {
    const store = this.ctx.profile.bookmarks;
    const node = store.get(id);
    if (!node || node.parentId === null) return;
    if (node.kind === 'folder') {
      const count = store.descendantCount(id);
      if (count > 0) {
        const res = await dialog.showMessageBox(this.win, {
          type: 'warning',
          title: 'Eliminar carpeta',
          message: `¿Eliminar la carpeta «${node.title}» y todo lo que contiene (${count} ${count === 1 ? 'elemento' : 'elementos'})?`,
          buttons: ['Eliminar', 'Cancelar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (res.response !== 0) return;
      }
    }
    store.remove(id);
    this.bookmarksChanged();
  }

  moveBookmark(id: number, parentId: number, index: number): void {
    try {
      this.ctx.profile.bookmarks.move(id, parentId, index);
      this.bookmarksChanged();
    } catch {
      /* movimiento no válido (p. ej. una carpeta dentro de sí misma): se ignora */
    }
  }

  /** Abre una dirección guardada (favorito, menú). */
  openUrl(url: string, where: OpenWhere): void {
    if (!isBookmarkableUrl(url)) return;
    if (where === 'current') {
      this.navigateTab(this.activeTab, url, false);
    } else if (where === 'new-window') {
      new BrowserWindowController(this.ctx, { url });
    } else {
      this.newTab({ url, index: this.tabs.indexOf(this.activeTab) + 1, activate: where === 'new-tab', openerId: this.activeTab.id });
    }
  }

  openBookmark(id: number, where: OpenWhere): void {
    const node = this.ctx.profile.bookmarks.get(id);
    if (node?.kind === 'url' && node.url) this.openUrl(node.url, where);
  }

  private openAllBookmarks(nodes: BookmarkNode[]): void {
    for (const n of nodes) if (n.url) this.openUrl(n.url, 'background-tab');
  }

  private folderActions() {
    return { open: (n: BookmarkNode, where: OpenWhere) => n.url && this.openUrl(n.url, where), openAll: (nodes: BookmarkNode[]) => this.openAllBookmarks(nodes) };
  }

  showBookmarkFolder(id: number): void {
    const node = this.ctx.profile.bookmarks.get(id);
    if (node?.kind !== 'folder') return;
    this.popup(folderMenu(id, this.ctx.profile.bookmarks, this.folderActions()));
  }

  showBookmarkOverflow(fromIndex: number): void {
    const items = this.ctx.profile.bookmarks.children(BAR_FOLDER_ID).slice(Math.max(0, fromIndex));
    if (items.length) this.popup(nodesMenu(items, this.ctx.profile.bookmarks, this.folderActions()));
  }

  showBookmarkMenu(id: number | null): void {
    const store = this.ctx.profile.bookmarks;
    const node = id === null ? null : (store.get(id) ?? null);
    if (id !== null && !node) return;
    const folderUrls = node?.kind === 'folder' ? store.children(node.id).filter((c) => c.kind === 'url') : [];
    const parentForNew = node?.kind === 'folder' ? node.id : (node?.parentId ?? BAR_FOLDER_ID);
    this.popup(
      bookmarkItemMenu(
        { node, folderUrls, barShown: this.barVisible() },
        {
          open: (where) => node?.url && this.openUrl(node.url, where),
          openAll: () => this.openAllBookmarks(folderUrls),
          edit: () => node && this.openBookmarkEditor(node.id, { justAdded: false, anchor: 'bar' }),
          remove: () => node && void this.removeBookmark(node.id),
          addPage: () => this.openNewBookmarkEditor('url', parentForNew),
          addFolder: () => this.openNewBookmarkEditor('folder', parentForNew),
          toggleBar: () => this.toggleBookmarksBar(),
          manage: () => this.openInternalPage('bookmarks'),
        },
      ),
    );
  }

  /** Ctrl+Shift+B: mostrar u ocultar la barra en todas las ventanas. */
  toggleBookmarksBar(): void {
    const p = this.ctx.profile;
    p.updateSettings({ bookmarksBar: p.settings.bookmarksBar === 'always' ? 'never' : 'always' });
  }

  // ---------------------------------------------------------------- descargas

  private downloadsState(): DownloadsUiState {
    const dm = this.ctx.profile.downloads;
    const requests = dm.requestsFor(this.id);
    const r = requests[0];
    const dir = this.ctx.profile.downloadDir;
    // La carpeta predeterminada se llama "Downloads" en disco aunque Windows en español la muestre como "Descargas"
    const folderName = this.ctx.profile.settings.downloadDir === null ? 'Descargas' : basename(dir) || dir;
    return {
      prompt: r ? { id: r.id, filename: r.filename, site: siteOf(r.url, r.pageUrl), totalBytes: r.totalBytes, mime: r.mime, dangerous: r.dangerous, folderName } : null,
      waiting: Math.max(0, requests.length - 1),
      panelOpen: this.downloadsPanelOpen,
      items: this.downloadsPanelOpen ? dm.entries({ limit: 8 }) : [],
      active: dm.activeCount,
      progress: dm.progress,
    };
  }

  /** Llegó un pedido de autorización para esta ventana. */
  onDownloadRequest(): void {
    if (!this.win.isFocused()) this.win.flashFrame(true);
    this.queueState();
  }

  setDownloadsPanel(open: boolean): void {
    if (this.downloadsPanelOpen === open) return;
    this.downloadsPanelOpen = open;
    this.queueState();
  }

  async answerDownload(id: number, answer: 'save' | 'save-as' | 'cancel'): Promise<void> {
    const dm = this.ctx.profile.downloads;
    const req = dm.requestsFor(this.id).find((r) => r.id === id);
    if (!req) return;
    if (answer === 'cancel') {
      dm.deny(id);
    } else if (answer === 'save') {
      dm.approve(id);
      this.setDownloadsPanel(true); // para ver el progreso
    } else {
      const res = await dialog.showSaveDialog(this.win, { title: 'Guardar como', defaultPath: join(this.ctx.profile.downloadDir, req.filename) });
      // Si se cierra el diálogo sin elegir, el pedido sigue abierto (se puede Guardar o Cancelar)
      if (res.canceled || !res.filePath || this.win.isDestroyed()) return;
      dm.approve(id, res.filePath);
      this.setDownloadsPanel(true);
    }
    if (!this.win.isDestroyed()) this.win.flashFrame(false);
    this.queueState();
  }

  /** "Guardar imagen como…" / "Guardar enlace como…": el diálogo de Windows es la autorización. */
  private async saveUrlAs(url: string, source: Tab): Promise<void> {
    let suggested = 'descarga';
    try {
      const u = new URL(url);
      suggested = sanitizeFileName(decodeURIComponent(u.pathname.split('/').pop() || '') || u.hostname);
    } catch {
      /* nombre por defecto */
    }
    const res = await dialog.showSaveDialog(this.win, { title: 'Guardar como', defaultPath: join(this.ctx.profile.downloadDir, suggested) });
    if (res.canceled || !res.filePath) return;
    const alive = !source.webContents.isDestroyed();
    this.ctx.profile.downloads.startAuthorized(
      { url, pageUrl: alive ? source.webContents.getURL() : '', filename: basename(res.filePath), mime: '', totalBytes: 0, sourceId: alive ? source.webContents.id : null },
      res.filePath,
    );
    this.setDownloadsPanel(true);
  }

  static refreshAll(): void {
    for (const w of this.all) w.queueState();
  }

  onUiReady(): void {
    this.uiReady = true;
    this.sentFavicons.clear();
    this.sendState();
    this.focusContent();
  }

  focusAddressBar(): void {
    this.uiContents.focus();
    this.uiContents.send(IPC.focusAddressBar);
  }

  openFind(): void {
    this.activeTab.openFind();
    this.uiContents.focus();
    this.uiContents.send(IPC.focusFind);
  }

  closeFind(): void {
    this.activeTab.closeFind();
    this.activeTab.webContents.focus();
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  /** Estado para guardar en la sesión. */
  saved(): SavedWindow {
    return {
      bounds: this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      tabs: this.tabs.map((t) => {
        const s = t.saved();
        return { ...s, ...trimSnapshot(s) };
      }),
      active: Math.max(0, this.tabs.indexOf(this.activeTab)),
    };
  }

  private recordClosedWindow(): void {
    const restorable = this.tabs.map((t) => trimSnapshot(t.snapshot()));
    if (restorable.length > 1) {
      this.ctx.closedTabs.push({ kind: 'window', tabs: restorable, active: Math.max(0, this.tabs.indexOf(this.activeTab)) });
    } else if (restorable.length === 1) {
      this.ctx.closedTabs.push({ kind: 'tab', windowId: this.id, index: 0, tab: restorable[0]! });
    }
  }

  // ---------------------------------------------------------------- teclado

  private onInput(event: Event, input: Input, fromPage: boolean, source?: Tab): void {
    // Una pestaña en segundo plano no debería recibir teclas, pero por las dudas solo se atiende a la activa.
    if (source && source !== this.activeTab) return;
    const action = matchShortcut(input, { fromPage, isLoading: this.activeTab.webContents.isLoading() });
    if (!action) return;
    event.preventDefault();
    this.run(action);
  }

  run(action: ShortcutAction): void {
    const tab = this.activeTab;
    const index = this.tabs.indexOf(tab);
    switch (action) {
      case 'focus-address-bar': return this.focusAddressBar();
      case 'back': return tab.goBack();
      case 'forward': return tab.goForward();
      case 'reload': return tab.reload(false);
      case 'reload-ignore-cache': return tab.reload(true);
      case 'stop': return tab.stop();
      case 'devtools': return tab.webContents.toggleDevTools();
      case 'new-tab': this.newTab(); return;
      case 'close-tab': return this.closeTab(tab);
      case 'new-window': new BrowserWindowController(this.ctx); return;
      case 'close-window': return this.win.close();
      case 'next-tab': return this.activate(this.tabs[cycleIndex(this.tabs.length, index, 1)]!);
      case 'prev-tab': return this.activate(this.tabs[cycleIndex(this.tabs.length, index, -1)]!);
      case 'select-last-tab': return this.activate(this.tabs[this.tabs.length - 1]!);
      case 'reopen-closed-tab': return this.reopenClosed();
      case 'duplicate-tab': this.duplicate(tab); return;
      case 'history': return this.openInternalPage('history');
      case 'downloads': return this.openInternalPage('downloads');
      case 'bookmarks': return this.openInternalPage('bookmarks');
      case 'bookmark-page': return this.toggleStar();
      case 'toggle-bookmarks-bar': return this.toggleBookmarksBar();
      case 'find': return this.openFind();
      case 'find-next':
      case 'find-prev':
        if (!tab.findAgain(action === 'find-next')) this.openFind();
        return;
      case 'zoom-in': return tab.zoom('in');
      case 'zoom-out': return tab.zoom('out');
      case 'zoom-reset': return tab.zoom('reset');
      default: {
        const n = Number(action.slice('select-tab-'.length));
        const target = this.tabs[n - 1];
        if (target) this.activate(target);
      }
    }
  }

  // ---------------------------------------------------------------- menús (nativos)

  private popup(template: MenuItemConstructorOptions[]): void {
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  /** Menú "Configuración y más" (botón ⋯ de la barra). */
  showAppMenu(): void {
    const bm = this.bookmarksState();
    const bookmarks = bookmarksSubmenu(this.ctx.profile.bookmarks, BAR_FOLDER_ID, OTHER_FOLDER_ID, { canAdd: bm.starrable, starred: bm.starred, barShown: this.ctx.profile.settings.bookmarksBar !== 'never' }, {
      ...this.folderActions(),
      addCurrent: () => this.toggleStar(),
      toggleBar: () => this.toggleBookmarksBar(),
      manage: () => this.openInternalPage('bookmarks'),
    });
    this.popup(
      appMenuTemplate(
        { zoomPercent: this.activeTab.state.zoomPercent, bookmarks },
        {
          newTab: () => this.newTab(),
          newWindow: () => { new BrowserWindowController(this.ctx); },
          history: () => this.openInternalPage('history'),
          downloads: () => this.openInternalPage('downloads'),
          zoom: (d) => this.activeTab.zoom(d),
          find: () => this.openFind(),
          settings: () => this.openInternalPage('settings'),
          closeWindow: () => this.win.close(),
        },
      ),
    );
  }

  showTabMenu(tab: Tab | null): void {
    const index = tab ? this.tabs.indexOf(tab) : -1;
    this.popup(
      tabMenuTemplate(
        { hasTab: !!tab, tabCount: this.tabs.length, tabsToRight: index < 0 ? 0 : this.tabs.length - index - 1, canReopen: this.ctx.closedTabs.size > 0 },
        {
          newTab: () => this.newTab(),
          newTabToRight: () => tab && this.newTab({ index: index + 1 }),
          reload: () => tab?.reload(false),
          duplicate: () => tab && this.duplicate(tab),
          moveToNewWindow: () => tab && this.moveToNewWindow(tab),
          close: () => tab && this.closeTab(tab),
          closeOthers: () => tab && this.closeOtherTabs(tab),
          closeToRight: () => tab && this.closeTabsToRight(tab),
          reopenClosed: () => this.reopenClosed(),
        },
      ),
    );
  }

  private showPageMenu(tab: Tab, params: ContextMenuParams): void {
    const wc = tab.webContents;
    const profile = this.ctx.profile;
    this.popup(
      pageMenuTemplate(params, {
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        searchEngineName: profile.searchEngineName,
        openInNewTab: (url, referrer) => {
          if (!this.tabs.includes(tab)) return;
          this.newTab({ url, referrer, index: this.childIndex(tab), activate: false, openerId: tab.id });
        },
        openInNewWindow: (url, referrer) => { new BrowserWindowController(this.ctx, { url, referrer }); },
        copyText: (text) => { clipboard.writeText(text).catch(() => {}); },
        copyImageAt: (x, y) => wc.copyImageAt(x, y),
        saveAs: (url) => { void this.saveUrlAs(url, tab); },
        searchFor: (text) => {
          if (!this.tabs.includes(tab)) return;
          this.newTab({ url: searchUrl(text.slice(0, 1000), profile.searchTemplate), index: this.childIndex(tab), activate: true, openerId: tab.id });
        },
        edit: (cmd) => runEdit(wc, cmd),
        replaceMisspelling: (word) => wc.replaceMisspelling(word),
        back: () => tab.goBack(),
        forward: () => tab.goForward(),
        reload: () => tab.reload(false),
        inspect: (x, y) => wc.inspectElement(x, y),
      }),
    );
  }

  private async showUiMenu(params: ContextMenuParams): Promise<void> {
    if (!params.isEditable) return; // el resto de la interfaz tiene sus propios menús (pestañas) o ninguno
    const text = (await clipboard.readText().catch(() => '')).trim().slice(0, 8192);
    if (this.win.isDestroyed()) return;
    const resolved = text ? resolveInput(text, this.ctx.profile.searchTemplate) : null;
    this.popup(
      uiEditMenuTemplate(params, {
        edit: (cmd) => runEdit(this.uiContents, cmd),
        clipboardText: resolved ? text : null,
        clipboardIsUrl: resolved?.kind === 'url' || resolved?.kind === 'internal',
        // La barra de direcciones es un <input type="text">; el campo de búsqueda en la página es type="search"
        isAddressBar: params.formControlType === 'input-text',
        pasteAndGo: (t) => { this.navigateTab(this.activeTab, t); },
      }),
    );
  }
}

function runEdit(wc: WebContents, cmd: EditCommand): void {
  switch (cmd) {
    case 'undo': return wc.undo();
    case 'redo': return wc.redo();
    case 'cut': return wc.cut();
    case 'copy': return wc.copy();
    case 'paste': return wc.paste();
    case 'pasteAndMatchStyle': return wc.pasteAndMatchStyle();
    case 'delete': return wc.delete();
    case 'selectAll': return wc.selectAll();
  }
}

/** Dirección escrita en "Agregar página…": sin esquema se asume https (como en la barra de direcciones). */
function normalizeBookmarkUrl(raw: string): string {
  const t = raw.trim();
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return `https://${t}`;
}
