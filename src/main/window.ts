import { basename, dirname, join } from 'node:path';
import { app, BaseWindow, clipboard, dialog, Menu, MenuItem, nativeTheme, screen, WebContentsView, type BrowserWindowConstructorOptions, type ContextMenuParams, type Event, type Input, type MenuItemConstructorOptions, type Rectangle, type Referrer, type Session, type WebContents } from 'electron';
import { Tab, type TabKind } from './tab';
import { showWindow, SLEEP_MINUTE_MS } from './test-mode';
import { AutofillPopup } from './autofill-popup';
import { stopOrphanServiceWorkers } from './service-worker-reaper';
import { updater } from './updater';
import type { Profile } from './profile';
import { matchShortcut, type ShortcutAction } from './shortcuts';
import type { ClosedTabs, TabSnapshot } from './closed-tabs';
import { appMenuTemplate, pageMenuTemplate, tabMenuTemplate, uiEditMenuTemplate, type EditCommand } from './context-menu';
import { trimSnapshot, type SavedTab, type SavedWindow } from './session-store';
import { IPC, MAX_OVERLAY_HEIGHT, type BookmarksUiState, type DownloadsUiState, type OpenWhere, type WindowState } from '../shared/ipc';
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, isBookmarkableUrl, type BookmarkEditorState, type BookmarkNode } from '../shared/bookmarks';
import { bookmarkItemMenu, bookmarksSubmenu, folderMenu, nodesMenu } from './bookmark-menus';
import type { ProfileInfo, WindowProfile } from '../shared/profiles';
import { GROUP_COLORS, groupDropIndex, isGroupColor, keepGroupsTogether, nextGroupColor, sanitizeGroupTitle, type GroupAction, type TabGroupState } from '../shared/tab-groups';
import { sanitizeFileName, siteOf } from '../shared/downloads';
import { TAB_STRIP_HEIGHT, chromeHeight } from '../shared/layout';
import { childInsertIndex, cycleIndex, indexAfterClose, moveItem } from '../shared/tab-order';
import { matchesSite, normalizeSite } from '../shared/settings';
import { resolveInput, searchUrl, type ResolvedInput } from '../shared/omnibox';
import { internalPageOf, internalUrl, type InternalPage } from '../shared/internal-pages';
import type { ExtensionInstallPrompt } from '../shared/extensions';
import { themeVars, titleBarColors } from '../shared/themes';
import { INTERNAL_IPC } from '../shared/internal-api';

/** Guardado de la sesión: cada cambio lo marca; al cerrar la última ventana se guarda en el acto. */
export interface SessionSaver {
  markDirty(): void;
  windowClosing(w: BrowserWindowController): void;
  /** Guarda ya, con todas las ventanas abiertas, y deja de guardar (salida de la app). */
  finalSave(): void;
}

/** Perfiles: abrir otros perfiles o ventanas privadas, y avisar del ciclo de vida de las ventanas. */
export interface ProfilesApi {
  openProfile(id: string, opts?: { url?: string }): BrowserWindowController;
  openPrivateWindow(from: WindowContext, url?: string): BrowserWindowController;
  list(): ProfileInfo[];
  windowProfile(ctx: WindowContext): WindowProfile;
  windowOpened(w: BrowserWindowController): void;
  windowClosed(w: BrowserWindowController): void;
}

export interface WindowContext {
  profile: Profile;
  uiSession: Session;
  uiUrl: string;
  uiPreload: string;
  closedTabs: ClosedTabs;
  session: SessionSaver;
  profiles: ProfilesApi;
}

export interface WindowOptions {
  /** URL de la primera pestaña (si no se pasan pestañas). */
  url?: string;
  referrer?: Referrer;
  /** Pestañas ya existentes que pasan a esta ventana (abiertas por una página, movidas desde otra ventana). */
  tabs?: Tab[];
  /** Pestañas a restaurar (ventana cerrada que se reabre, o sesión anterior): se cargan al activarlas. */
  restore?: { tabs: SavedTab[]; active: number; groups?: TabGroupState[] };
  /** Grupos que llegan con `tabs` (mover un grupo a una ventana nueva). */
  groups?: TabGroupState[];
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
let nextGroupId = 1;
let nextExtensionPromptId = 1;

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
  /** Grupos de pestañas de la ventana. */
  private readonly groups = new Map<number, TabGroupState>();
  private groupEditorId: number | null = null;
  /** Menú de sugerencias de contraseñas (debajo del campo enfocado de la página). */
  readonly autofill: AutofillPopup;
  /** Revisa cada minuto qué pestañas dormir. */
  private readonly sleepTimer: NodeJS.Timeout;
  /** "¿Agregar la extensión?" esperando la respuesta del usuario. */
  private extensionPrompt: { prompt: ExtensionInstallPrompt; resolve: (allow: boolean) => void } | null = null;

  constructor(readonly ctx: WindowContext, opts: WindowOptions = {}) {
    // Sin barra de título propia (como Edge y Chrome): las pestañas van arriba, en la misma fila que los botones de ventana
    // de Windows, que los sigue dibujando el sistema (con los diseños de ajuste de Windows 11) con los colores del tema.
    this.win = new BaseWindow({
      ...initialBounds(opts),
      show: false,
      minWidth: 400,
      minHeight: 300,
      title: 'Callisto',
      backgroundColor: '#f7f7f7',
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...this.titleBarColorsFor(ctx), height: TAB_STRIP_HEIGHT },
    });
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
    this.autofill = new AutofillPopup(this.win, {
      session: ctx.uiSession,
      url: new URL('autofill.html', ctx.uiUrl).href,
      preload: join(dirname(ctx.uiPreload), 'autofill.js'),
      onManage: () => this.openInternalPage('passwords'),
    });

    // La interfaz nunca navega ni abre ventanas.
    this.uiContents.on('will-navigate', (e) => e.preventDefault());
    this.uiContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.uiContents.on('before-input-event', (e, input) => this.onInput(e, input, false));
    this.uiContents.on('context-menu', (_e, params) => { void this.showUiMenu(params); });

    this.win.on('resize', () => {
      this.autofill.hide();
      this.layout();
      this.ctx.session.markDirty();
    });
    this.win.on('move', () => this.ctx.session.markDirty());
    this.win.on('focus', () => {
      BrowserWindowController.lastFocused = this;
      this.applyNativeTheme();
    });
    // Windows va a cerrar la sesión o apagarse: se guardan todas las ventanas antes de que se cierren una por una
    this.win.on('query-session-end', () => this.ctx.session.finalSave());
    this.win.on('close', () => {
      // Si quedan otras ventanas, esta va a "cerradas recientemente"; si es la última, queda como sesión guardada.
      if (BrowserWindowController.all.size > 1) this.recordClosedWindow();
      // Descargas esperando autorización en esta ventana: pasan a otra del mismo perfil; si no hay, se rechazan
      const other = [...BrowserWindowController.all].find((w) => w !== this && !w.closing && w.ctx.profile === ctx.profile);
      for (const r of ctx.profile.downloads.requestsFor(this.id)) r.windowId = other ? other.id : null;
      ctx.profile.downloads.denyWithoutWindow();
      if (other) other.queueState();
      this.ctx.session.windowClosing(this);
      this.closing = true;
    });
    this.win.on('closed', () => {
      this.closing = true;
      BrowserWindowController.all.delete(this);
      this.autofill.destroy();
      clearInterval(this.sleepTimer);
      this.extensionPrompt?.resolve(false);
      this.extensionPrompt = null;
      for (const tab of this.tabs) {
        this.attached.get(tab)?.dispose();
        tab.destroy();
      }
      this.tabs = [];
      this.attached.clear();
      if (!this.uiContents.isDestroyed()) this.uiContents.close();
      this.ctx.session.markDirty();
      this.ctx.profiles.windowClosed(this);
    });

    BrowserWindowController.all.add(this);
    this.sleepTimer = setInterval(() => this.sleepIdleTabs(), SLEEP_MINUTE_MS);
    this.sleepTimer.unref();
    BrowserWindowController.lastFocused = this;

    if (opts.tabs?.length) {
      for (const g of opts.groups ?? []) this.groups.set(g.id, { ...g });
      opts.tabs.forEach((t, i) => this.insertTab(t, i, i === 0));
    } else if (opts.restore?.tabs.length) {
      // Grupos guardados: ids nuevos (los guardados son de otra sesión)
      const ids = new Map<number, number>();
      for (const g of opts.restore.groups ?? []) {
        const id = nextGroupId++;
        ids.set(g.id, id);
        this.groups.set(id, { ...g, id });
      }
      // Se agregan todas sin activar (quedan sin cargar) y después se activa, y carga, solo la que estaba activa
      const active = Math.max(0, Math.min(opts.restore.active, opts.restore.tabs.length - 1));
      opts.restore.tabs.forEach((s, i) => {
        const t = new Tab(ctx.profile, { pending: s });
        t.groupId = s.groupId != null ? (ids.get(s.groupId) ?? null) : null;
        this.insertTab(t, i, false, 'page', false);
      });
      this.activate(this.tabs[active]!, { focus: 'page' });
    } else {
      const t = this.createTab(opts.url);
      this.insertTab(t, 0, true);
      t.loadURL(opts.url ?? 'about:blank', opts.referrer);
    }

    this.uiContents.loadURL(ctx.uiUrl).catch(() => {});
    ctx.profiles.windowOpened(this);
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
    if (tab.groupId !== null && !this.groups.has(tab.groupId)) tab.groupId = null;
    this.tabs.splice(i, 0, tab);
    this.tidyGroups();
    this.attach(tab);
    // Debajo de la interfaz (índice 0 = al fondo)
    this.win.contentView.addChildView(tab.view, 0);
    tab.view.setVisible(false);
    if (activate || (!this.activeTab && activateIfFirst)) this.activate(tab, { focus });
    else this.queueState();
  }

  /** Crea una pestaña nueva. Por defecto al final y activa. */
  newTab(opts: { url?: string; referrer?: Referrer; index?: number; activate?: boolean; openerId?: number | null; adopt?: BrowserWindowConstructorOptions; groupId?: number | null } = {}): Tab {
    const tab = this.createTab(opts.url, { adopt: opts.adopt, openerId: opts.openerId });
    // Lo que se abre desde una pestaña agrupada queda en su grupo (como en Chrome)
    const opener = opts.openerId != null ? this.tabs.find((t) => t.id === opts.openerId) : undefined;
    tab.groupId = opts.groupId !== undefined ? opts.groupId : (opener?.groupId ?? null);
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
    // El usuario se va a otra parte: la oferta de guardar una contraseña ya no corresponde
    if (tab.passwordOffer) tab.setPasswordOffer(null);
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
    // Las extensiones ven las pestañas web del perfil (chrome.tabs), con esta ventana
    const extensions = tab.kind === 'web' ? this.ctx.profile.extensions : null;
    extensions?.tabAdded(tab.webContents, this.win);
    this.attached.set(tab, {
      dispose: () => {
        tab.off('state-changed', onState);
        tab.off('input', onInput);
        tab.off('context-menu', onMenu);
        tab.off('closed-by-page', onClosedByPage);
        tab.off('zoom-changed', onZoom);
        tab.off('favicon', onFavicon);
        tab.openHandler = null;
        extensions?.tabRemoved(tab.webContents);
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
    // Activar una pestaña de un grupo contraído lo expande
    const g = tab.groupId !== null ? this.groups.get(tab.groupId) : undefined;
    if (g?.collapsed) g.collapsed = false;
    const previous = this.activeTab;
    this.activeTab = tab;
    const now = Date.now();
    if (previous) previous.lastActive = now;
    tab.lastActive = now;
    if (this.autofill.openFor && this.autofill.openFor !== tab) this.autofill.hide();
    if (previous && previous !== tab && this.tabs.includes(previous)) previous.view.setVisible(false);
    tab.ensureLoaded(); // pestaña restaurada: se carga recién ahora
    tab.view.setVisible(true);
    if (tab.kind === 'web') this.ctx.profile.extensions?.tabSelected(tab.webContents);
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
    this.tidyGroups();

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

  /** Mueve una pestaña; si se indica `groupId`, queda en ese grupo (o sin grupo con null). */
  moveTab(tab: Tab, index: number, groupId?: number | null): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs = moveItem(this.tabs, from, index);
    if (groupId !== undefined) tab.groupId = groupId !== null && this.groups.has(groupId) ? groupId : null;
    this.tidyGroups();
    this.queueState();
  }

  // ---------------------------------------------------------------- grupos de pestañas

  /** Las pestañas de cada grupo juntas; los grupos sin pestañas desaparecen. */
  private tidyGroups(): void {
    this.tabs = keepGroupsTogether(this.tabs);
    for (const id of [...this.groups.keys()]) {
      if (!this.tabs.some((t) => t.groupId === id)) {
        this.groups.delete(id);
        if (this.groupEditorId === id) this.groupEditorId = null;
      }
    }
  }

  private members(groupId: number): Tab[] {
    return this.tabs.filter((t) => t.groupId === groupId);
  }

  /** Posición justo después de la última pestaña del grupo. */
  private groupEnd(groupId: number): number {
    const last = this.members(groupId).at(-1);
    return last ? this.tabs.indexOf(last) + 1 : this.tabs.length;
  }

  /** `fromExtension`: lo pide una extensión (chrome.tabs.group): queda en su lugar y sin abrir el panel. */
  createGroup(tab: Tab, fromExtension = false): number {
    const id = nextGroupId++;
    this.groups.set(id, { id, title: '', color: nextGroupColor([...this.groups.values()].map((g) => g.color)), collapsed: false });
    tab.groupId = id;
    // El grupo nuevo empieza a la izquierda del todo, antes de las demás pestañas y grupos
    if (!fromExtension) this.tabs = moveItem(this.tabs, this.tabs.indexOf(tab), 0);
    this.tidyGroups();
    if (!fromExtension) this.groupEditorId = id; // como en Chrome: se abre el panel para ponerle nombre
    this.queueState();
    return id;
  }

  addToGroup(tab: Tab, groupId: number): void {
    if (!this.groups.has(groupId) || tab.groupId === groupId) return;
    const end = this.groupEnd(groupId);
    const from = this.tabs.indexOf(tab);
    this.tabs = moveItem(this.tabs, from, from < end ? end - 1 : end);
    tab.groupId = groupId;
    this.tidyGroups();
    this.queueState();
  }

  removeFromGroup(tab: Tab): void {
    const gid = tab.groupId;
    if (gid === null) return;
    const end = this.groupEnd(gid);
    const from = this.tabs.indexOf(tab);
    this.tabs = moveItem(this.tabs, from, end - 1); // queda justo después del grupo
    tab.groupId = null;
    this.tidyGroups();
    this.queueState();
  }

  updateGroup(id: number, patch: { title?: unknown; color?: unknown; collapsed?: unknown }): void {
    const g = this.groups.get(id);
    if (!g) return;
    if (patch.title !== undefined) g.title = sanitizeGroupTitle(patch.title);
    if (patch.color !== undefined && isGroupColor(patch.color)) g.color = patch.color;
    if (typeof patch.collapsed === 'boolean' && patch.collapsed !== g.collapsed) {
      g.collapsed = patch.collapsed;
      // Contraer el grupo de la pestaña activa: se pasa a otra de fuera del grupo (o a una nueva)
      if (g.collapsed && this.activeTab.groupId === id) {
        const idx = this.tabs.indexOf(this.activeTab);
        const visible = (t: Tab) => t.groupId === null || !this.groups.get(t.groupId)?.collapsed;
        const next = this.tabs.slice(idx).find(visible) ?? [...this.tabs.slice(0, idx)].reverse().find(visible);
        if (next) this.activate(next);
        else this.newTab();
      }
    }
    this.queueState();
  }

  setGroupEditor(id: number | null): void {
    this.groupEditorId = id !== null && this.groups.has(id) ? id : null;
    this.queueState();
  }

  groupAction(id: number, action: GroupAction): void {
    const g = this.groups.get(id);
    if (!g) return;
    const members = this.members(id);
    this.groupEditorId = null;
    switch (action) {
      case 'new-tab':
        g.collapsed = false;
        this.newTab({ index: this.groupEnd(id), groupId: id });
        break;
      case 'ungroup':
        for (const t of members) t.groupId = null;
        this.tidyGroups();
        break;
      case 'close':
        for (const t of [...members].reverse()) this.closeTab(t);
        break;
      case 'move-to-window': {
        if (members.length === this.tabs.length) break; // ya está sola en su ventana
        for (const t of members) this.removeTab(t, { record: false, destroy: false });
        new BrowserWindowController(this.ctx, { tabs: members, groups: [{ ...g, collapsed: false }] });
        break;
      }
    }
    this.queueState();
  }

  /** Mueve el grupo entero (nunca adentro de otro grupo). */
  moveGroup(id: number, index: number): void {
    const members = this.members(id);
    if (!members.length) return;
    const firstIndex = this.tabs.indexOf(members[0]!);
    const rest = this.tabs.filter((t) => t.groupId !== id);
    // `index` cuenta las pestañas del grupo que se mueve: se descuentan si estaban antes
    const adjusted = index > firstIndex ? index - members.length : index;
    const at = groupDropIndex(rest, adjusted);
    rest.splice(at, 0, ...members);
    this.tabs = rest;
    this.queueState();
  }

  /** Pasa la pestaña a una ventana nueva, con todo su estado (no se recarga). */
  moveToNewWindow(tab: Tab): BrowserWindowController | undefined {
    if (this.tabs.length < 2 || !this.tabs.includes(tab)) return undefined;
    this.removeTab(tab, { record: false, destroy: false });
    tab.openerId = null;
    tab.groupId = null;
    return new BrowserWindowController(this.ctx, { tabs: [tab] });
  }

  // ---------------------------------------------------------------- pestañas dormidas

  /**
   * Duerme una pestaña: la reemplaza por una sin proceso que guarda su historial (y la posición en la página), como las
   * pestañas restauradas que todavía no se cargaron. Al activarla se vuelve a cargar. Devuelve si la durmió.
   */
  sleepTab(tab: Tab): boolean {
    if (tab === this.activeTab || !this.tabs.includes(tab) || !tab.canSleep) return false;
    const index = this.tabs.indexOf(tab);
    const saved = { ...savedFromSnapshot(tab.snapshot()), faviconKey: tab.state.faviconKey };
    const sleeping = new Tab(this.ctx.profile, { pending: saved, kind: tab.kind, asleep: true, openerId: tab.openerId });
    sleeping.groupId = tab.groupId;
    sleeping.lastActive = tab.lastActive;
    this.insertTab(sleeping, index, false, 'none', false);
    this.removeTab(tab, { record: false, destroy: true });
    return true;
  }

  /** Sitio de la pestaña para "No dormir nunca este sitio": su dominio y si ya está en la lista (null: no es un sitio web). */
  private neverSleepState(tab: Tab): { site: string; listed: boolean } | null {
    let site: string | null = null;
    try {
      const u = new URL(tab.url);
      site = u.protocol === 'http:' || u.protocol === 'https:' ? normalizeSite(u.hostname) : null;
    } catch {
      site = null;
    }
    if (!site) return null;
    return { site, listed: matchesSite(tab.url, this.ctx.profile.settings.neverSleepSites) };
  }

  private toggleNeverSleep(tab: Tab): void {
    const state = this.neverSleepState(tab);
    if (!state) return;
    const list = this.ctx.profile.settings.neverSleepSites;
    const next = state.listed ? list.filter((s) => !matchesSite(tab.url, [s])) : [...list, state.site];
    this.ctx.profile.updateSettings({ neverSleepSites: next });
  }

  /** Duerme las pestañas que no se usan hace más de lo configurado, y libera los service workers sin pestañas. */
  private sleepIdleTabs(): void {
    if (this.closing) return;
    const minutes = this.ctx.profile.settings.sleepTabsAfter;
    if (minutes) {
      const limit = Date.now() - minutes * SLEEP_MINUTE_MS;
      const keep = this.ctx.profile.settings.neverSleepSites;
      for (const tab of [...this.tabs]) if (tab !== this.activeTab && tab.lastActive < limit && !matchesSite(tab.url, keep)) this.sleepTab(tab);
    }
    // Una sola ventana por perfil hace la revisión (la primera), con las pestañas despiertas de todas
    const profile = this.ctx.profile;
    const windows = [...BrowserWindowController.all].filter((w) => w.ctx.profile === profile && !w.closing);
    if (windows[0] !== this) return;
    const live = windows.flatMap((w) => w.tabs.filter((t) => t.kind === 'web' && !t.isPending && !t.webContents.isDestroyed()).map((t) => t.webContents));
    void stopOrphanServiceWorkers(profile.session, live, SLEEP_MINUTE_MS).catch(() => {});
  }

  duplicate(tab: Tab): Tab {
    const copy = new Tab(this.ctx.profile, { kind: tab.kind, openerId: tab.id });
    copy.groupId = tab.groupId;
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

  /**
   * Modo claro u oscuro del tema para Chromium (menús, barras de desplazamiento, y prefers-color-scheme de los sitios,
   * como en Chrome). Es uno solo para toda la app: manda la ventana enfocada.
   */
  private titleBarColorsFor(ctx: WindowContext): { color: string; symbolColor: string } {
    return titleBarColors(ctx.profile.theme, { private: ctx.profile.isPrivate, systemDark: nativeTheme.shouldUseDarkColors });
  }

  /** Últimos colores que informó la interfaz (los reales de su franja). */
  private titleBarFromUi: { color: string; symbolColor: string } | null = null;

  /**
   * Colores de los botones de ventana de Windows. Los manda la interfaz (los que de verdad tiene su franja: tema, modo de
   * Windows, ventana privada); hasta entonces, los del tema.
   */
  applyTitleBar(colors?: { color: string; symbolColor: string }): void {
    if (colors) this.titleBarFromUi = colors;
    if (this.win.isDestroyed()) return;
    try {
      this.win.setTitleBarOverlay({ ...(this.titleBarFromUi ?? this.titleBarColorsFor(this.ctx)), height: TAB_STRIP_HEIGHT });
    } catch {
      /* ventana cerrándose */
    }
  }

  applyNativeTheme(): void {
    const t = this.ctx.profile.theme;
    const source = t.colors ? t.mode : 'system';
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    this.win.setBackgroundColor(t.colors ? t.colors.toolbar : nativeTheme.shouldUseDarkColors ? '#2b2b2b' : '#f7f7f7');
  }

  /** Grupos de la ventana (para chrome.tabGroups). */
  groupList(): TabGroupState[] {
    return [...this.groups.values()];
  }

  /** Posición de la primera pestaña del grupo (-1 si no existe). */
  groupIndex(id: number): number {
    return this.tabs.findIndex((t) => t.groupId === id);
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
    if (this.closing || this.win.isDestroyed() || !this.activeTab || !this.tabs.includes(this.activeTab)) return;
    this.layout();
    const state: WindowState = {
      tabs: this.tabs.map((t) => t.state),
      activeTabId: this.activeTab.id,
      searchEngine: this.ctx.profile.searchEngineName,
      profile: this.ctx.profiles.windowProfile(this.ctx),
      groups: [...this.groups.values()],
      groupEditor: this.groupEditorId,
      downloads: this.downloadsState(),
      bookmarks: this.bookmarksState(),
      theme: themeVars(this.ctx.profile.theme),
      updateReady: updater.status.state === 'ready' ? updater.status.version : null,
      extensions: {
        // Sin extensiones en las ventanas privadas
        partition: this.ctx.profile.extensions ? `persist:profile-${this.ctx.profile.id}` : null,
        prompt: this.extensionPrompt?.prompt ?? null,
      },
    };
    // La ventana se está cerrando (su última pestaña ya salió, p. ej. un popup que se cerró solo): no hay nada que mostrar
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (!active) return;
    const blank = !active.url || active.url === 'about:blank';
    // Con varios perfiles (o en privado) el título dice de cuál es la ventana
    const suffix = state.profile.private ? ' (Privada)' : state.profile.several ? ` (${state.profile.name})` : '';
    try {
      this.win.setTitle(`${!blank && active.title ? active.title : 'Nueva pestaña'} — Callisto${suffix}`);
    } catch {
      return; // la ventana se está destruyendo (al salir): no hay a quién mostrarle nada
    }
    // Las extensiones con chrome.tabGroups se enteran de los cambios de grupos
    this.ctx.profile.extensions?.emit('groups-maybe-changed');
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

  /** Cambió la configuración de un perfil: el tema llega a la interfaz (estado), a Chromium y a las páginas internas. */
  static settingsChanged(): void {
    this.refreshAll();
    this.current()?.applyNativeTheme();
    for (const w of this.all) w.applyTitleBar();
    for (const w of this.all) {
      const vars = themeVars(w.ctx.profile.theme);
      for (const t of w.tabs) if (t.kind === 'internal' && !t.webContents.isDestroyed()) t.webContents.send(INTERNAL_IPC.themeChanged, vars);
    }
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
        return { ...s, ...trimSnapshot(s), groupId: t.groupId };
      }),
      active: Math.max(0, this.tabs.indexOf(this.activeTab)),
      groups: [...this.groups.values()].map((g) => ({ ...g })),
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
      case 'new-private-window': this.ctx.profiles.openPrivateWindow(this.ctx); return;
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

  private popup(template: MenuItemConstructorOptions[], extra: MenuItem[] = []): void {
    if (template.length === 0 && extra.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    if (extra.length) {
      if (template.length) menu.append(new MenuItem({ type: 'separator' }));
      for (const item of extra) menu.append(item);
    }
    menu.popup({ window: this.win });
  }

  // ---------------------------------------------------------------- extensiones

  /** "¿Agregar la extensión?" en esta ventana. Resuelve con la respuesta (no, si la ventana se cierra). */
  askExtensionInstall(prompt: Omit<ExtensionInstallPrompt, 'id'>): Promise<boolean> {
    if (this.extensionPrompt || this.closing) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.extensionPrompt = { prompt: { ...prompt, id: nextExtensionPromptId++ }, resolve };
      this.focus();
      this.queueState();
    });
  }

  answerExtensionInstall(id: number, allow: boolean): void {
    const p = this.extensionPrompt;
    if (!p || p.prompt.id !== id) return;
    this.extensionPrompt = null;
    p.resolve(allow);
    this.queueState();
  }

  /** Menú del botón de una extensión en la barra. */
  showExtensionMenu(extensionId: string): void {
    const ext = this.ctx.profile.extensions;
    const info = ext?.list().find((e) => e.id === extensionId);
    if (!ext || !info) return;
    const options = ext.optionsUrl(extensionId);
    this.popup([
      { label: info.name.replace(/&/g, '&&'), click: () => this.newTab({ url: info.storeUrl }) },
      { type: 'separator' },
      { label: 'Opciones', enabled: !!options, click: () => options && this.newTab({ url: options }) },
      { label: 'Administrar extensiones', click: () => this.openInternalPage('extensions') },
      { type: 'separator' },
      { label: 'Quitar de Callisto…', click: () => void ext.removeWithConfirmation(extensionId, null) },
    ]);
  }

  /** Menú del botón de perfil: cambiar de perfil, ventana privada, agregar o administrar perfiles. */
  showProfileMenu(): void {
    const me = this.ctx.profiles.windowProfile(this.ctx);
    const items: MenuItemConstructorOptions[] = [];
    if (me.private) items.push({ label: `Ventana privada de «${me.name.replace(/&/g, '&&')}»`, enabled: false }, { type: 'separator' });
    for (const p of this.ctx.profiles.list()) {
      items.push({
        label: p.name.replace(/&/g, '&&'),
        type: 'radio',
        checked: !me.private && p.id === me.id,
        click: () => {
          if (me.private || p.id !== me.id) this.ctx.profiles.openProfile(p.id);
        },
      });
    }
    items.push(
      { type: 'separator' },
      { label: 'Nueva ventana privada', accelerator: 'Ctrl+Shift+N', registerAccelerator: false, click: () => { this.ctx.profiles.openPrivateWindow(this.ctx); } },
      { type: 'separator' },
      { label: 'Agregar perfil…', click: () => this.openInternalPage('profiles') },
      { label: 'Administrar perfiles', click: () => this.openInternalPage('profiles') },
    );
    this.popup(items);
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
        { zoomPercent: this.activeTab.state.zoomPercent, bookmarks, updateVersion: updater.status.state === 'ready' ? updater.status.version : undefined },
        {
          newTab: () => this.newTab(),
          newWindow: () => { new BrowserWindowController(this.ctx); },
          newPrivateWindow: () => { this.ctx.profiles.openPrivateWindow(this.ctx); },
          history: () => this.openInternalPage('history'),
          downloads: () => this.openInternalPage('downloads'),
          passwords: () => this.openInternalPage('passwords'),
          extensions: () => this.openInternalPage('extensions'),
          zoom: (d) => this.activeTab.zoom(d),
          find: () => this.openFind(),
          settings: () => this.openInternalPage('settings'),
          closeWindow: () => this.win.close(),
          installUpdate: () => updater.installAndRestart(),
        },
      ),
    );
  }

  showTabMenu(tab: Tab | null): void {
    const index = tab ? this.tabs.indexOf(tab) : -1;
    this.popup(
      tabMenuTemplate(
        {
          hasTab: !!tab,
          tabCount: this.tabs.length,
          tabsToRight: index < 0 ? 0 : this.tabs.length - index - 1,
          canSleep: !!tab && tab !== this.activeTab && tab.canSleep,
          neverSleepSite: tab ? this.neverSleepState(tab) : null,
          canReopen: this.ctx.closedTabs.size > 0,
          groupId: tab?.groupId ?? null,
          groups: [...this.groups.values()].map((g) => ({ id: g.id, title: g.title, colorName: GROUP_COLORS[g.color].name })),
        },
        {
          addToNewGroup: () => tab && this.createGroup(tab),
          addToGroup: (gid) => tab && this.addToGroup(tab, gid),
          removeFromGroup: () => tab && this.removeFromGroup(tab),
          newTab: () => this.newTab(),
          newTabToRight: () => tab && this.newTab({ index: index + 1, groupId: tab.groupId }),
          reload: () => tab?.reload(false),
          duplicate: () => tab && this.duplicate(tab),
          moveToNewWindow: () => tab && this.moveToNewWindow(tab),
          sleep: () => tab && this.sleepTab(tab),
          toggleNeverSleep: () => tab && this.toggleNeverSleep(tab),
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
        openInPrivateWindow: (url) => { this.ctx.profiles.openPrivateWindow(this.ctx, url); },
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
      // Lo que agregan las extensiones (chrome.contextMenus)
      tab.kind === 'web' ? (profile.extensions?.chrome.getContextMenuItems(wc, params) ?? []) : [],
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
