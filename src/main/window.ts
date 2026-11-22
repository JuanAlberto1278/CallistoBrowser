import { app, BaseWindow, clipboard, Menu, WebContentsView, type BrowserWindowConstructorOptions, type ContextMenuParams, type Event, type Input, type MenuItemConstructorOptions, type Referrer, type Session, type WebContents } from 'electron';
import { Tab } from './tab';
import type { Profile } from './profile';
import { matchShortcut, type ShortcutAction } from './shortcuts';
import { ClosedTabs, type TabSnapshot } from './closed-tabs';
import { pageMenuTemplate, tabMenuTemplate, uiEditMenuTemplate, type EditCommand } from './context-menu';
import { IPC, type WindowState } from '../shared/ipc';
import { chromeHeight } from '../shared/layout';
import { childInsertIndex, cycleIndex, indexAfterClose, moveItem } from '../shared/tab-order';
import { resolveInput, searchUrl } from '../shared/omnibox';

export interface WindowContext {
  profile: Profile;
  uiSession: Session;
  uiUrl: string;
  uiPreload: string;
  closedTabs: ClosedTabs;
}

export interface WindowOptions {
  /** URL de la primera pestaña (si no se pasan pestañas). */
  url?: string;
  referrer?: Referrer;
  /** Pestañas ya existentes que pasan a esta ventana (abiertas por una página, movidas desde otra ventana). */
  tabs?: Tab[];
  /** Pestañas a restaurar desde su historial (reabrir una ventana cerrada). */
  restore?: { tabs: TabSnapshot[]; active: number };
  /** Tamaño pedido por un popup (window.open con dimensiones). */
  popupSize?: { width?: number; height?: number };
}

type FocusMode = 'auto' | 'page' | 'none';

interface Attached {
  dispose(): void;
}

let nextWindowId = 1;

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
  private closingAll = false;

  constructor(readonly ctx: WindowContext, opts: WindowOptions = {}) {
    const popup = opts.popupSize;
    const width = popup?.width ? Math.max(400, popup.width) : 1280;
    const height = popup?.height ? Math.max(300, popup.height + chromeHeight({ notice: false, find: false })) : 860;
    this.win = new BaseWindow({ width, height, minWidth: 400, minHeight: 300, title: 'Callisto', backgroundColor: '#f7f7f7' });

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
    this.uiContents = this.ui.webContents;
    this.win.contentView.addChildView(this.ui);

    // La interfaz nunca navega ni abre ventanas.
    this.uiContents.on('will-navigate', (e) => e.preventDefault());
    this.uiContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.uiContents.on('before-input-event', (e, input) => this.onInput(e, input, false));
    this.uiContents.on('context-menu', (_e, params) => { void this.showUiMenu(params); });

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => { BrowserWindowController.lastFocused = this; });
    this.win.on('close', () => this.recordClosedWindow());
    this.win.on('closed', () => {
      BrowserWindowController.all.delete(this);
      for (const tab of this.tabs) {
        this.attached.get(tab)?.dispose();
        tab.destroy();
      }
      this.tabs = [];
      this.attached.clear();
      if (!this.uiContents.isDestroyed()) this.uiContents.close();
    });

    BrowserWindowController.all.add(this);
    BrowserWindowController.lastFocused = this;

    if (opts.tabs?.length) {
      opts.tabs.forEach((t, i) => this.insertTab(t, i, i === 0));
    } else if (opts.restore?.tabs.length) {
      opts.restore.tabs.forEach((s, i) => {
        const t = new Tab(ctx.profile);
        this.insertTab(t, i, i === opts.restore!.active);
        t.restore(s);
      });
    } else {
      const t = new Tab(ctx.profile);
      this.insertTab(t, 0, true);
      t.loadURL(opts.url ?? 'about:blank', opts.referrer);
    }

    this.uiContents.loadURL(ctx.uiUrl).catch(() => {});
  }

  get active(): Tab {
    return this.activeTab;
  }

  // ---------------------------------------------------------------- pestañas

  /**
   * Agrega una pestaña a esta ventana en la posición indicada. `focus`: 'auto' enfoca la barra de direcciones si la
   * pestaña está vacía y la página si no; 'page' enfoca siempre la página (contenido que todavía no empezó a cargar).
   */
  insertTab(tab: Tab, index: number, activate: boolean, focus: FocusMode = 'auto'): void {
    const i = Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(i, 0, tab);
    this.attach(tab);
    // Debajo de la interfaz (índice 0 = al fondo)
    this.win.contentView.addChildView(tab.view, 0);
    tab.view.setVisible(false);
    if (activate || !this.activeTab) this.activate(tab, { focus });
    else this.queueState();
  }

  /** Crea una pestaña nueva. Por defecto al final y activa. */
  newTab(opts: { url?: string; referrer?: Referrer; index?: number; activate?: boolean; openerId?: number | null; adopt?: BrowserWindowConstructorOptions } = {}): Tab {
    const tab = new Tab(this.ctx.profile, { adopt: opts.adopt, openerId: opts.openerId ?? null });
    const hasContent = !!opts.adopt || (!!opts.url && opts.url !== 'about:blank');
    this.insertTab(tab, opts.index ?? this.tabs.length, opts.activate ?? true, hasContent ? 'page' : 'auto');
    if (!opts.adopt) tab.loadURL(opts.url ?? 'about:blank', opts.referrer);
    return tab;
  }

  /** Pestaña hija de `opener` (enlaces): a la derecha de su pestaña de origen y de las hijas anteriores. */
  private childIndex(opener: Tab): number {
    return childInsertIndex(this.tabs.map((t) => t.openerId), this.tabs.indexOf(opener), opener.id);
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
    if (opts.record && !this.closingAll) {
      this.ctx.closedTabs.push({ kind: 'tab', windowId: this.id, index, tab: tab.snapshot() });
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
    const copy = new Tab(this.ctx.profile, { openerId: tab.id });
    this.insertTab(copy, this.tabs.indexOf(tab) + 1, true, 'page');
    copy.restore(tab.snapshot());
    return copy;
  }

  reopenClosed(): void {
    const entry = this.ctx.closedTabs.pop();
    if (!entry) return;
    if (entry.kind === 'window') {
      new BrowserWindowController(this.ctx, { restore: { tabs: entry.tabs, active: entry.active } });
      return;
    }
    // Vuelve a su ventana si sigue abierta; si no, a esta.
    const target = [...BrowserWindowController.all].find((w) => w.id === entry.windowId) ?? this;
    const tab = new Tab(this.ctx.profile);
    target.insertTab(tab, entry.index, true, 'page');
    tab.restore(entry.tab);
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
    const top = chromeHeight({ notice: !!tab?.notice, find: !!tab?.findOpen });
    this.ui.setBounds({ x: 0, y: 0, width, height: top });
    tab?.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  queueState(): void {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => {
      this.stateQueued = false;
      this.sendState();
    });
  }

  private sendState(): void {
    if (this.win.isDestroyed() || !this.activeTab) return;
    this.layout();
    const state: WindowState = { tabs: this.tabs.map((t) => t.state), activeTabId: this.activeTab.id };
    const active = state.tabs.find((t) => t.id === state.activeTabId)!;
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

  /** Favicon que trajo una pestaña movida desde otra ventana. */
  private findFavicon(key: string): string | undefined {
    for (const w of BrowserWindowController.all) {
      const d = w.favicons.get(key);
      if (d) {
        this.favicons.set(key, d);
        return d;
      }
    }
    return undefined;
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

  private recordClosedWindow(): void {
    this.closingAll = true;
    const restorable = this.tabs.map((t) => t.snapshot());
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

  // ---------------------------------------------------------------- menús contextuales (nativos)

  private popup(template: MenuItemConstructorOptions[]): void {
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: this.win });
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
    this.popup(
      pageMenuTemplate(params, {
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        openInNewTab: (url, referrer) => {
          if (!this.tabs.includes(tab)) return;
          this.newTab({ url, referrer, index: this.childIndex(tab), activate: false, openerId: tab.id });
        },
        openInNewWindow: (url, referrer) => { new BrowserWindowController(this.ctx, { url, referrer }); },
        copyText: (text) => { clipboard.writeText(text).catch(() => {}); },
        copyImageAt: (x, y) => wc.copyImageAt(x, y),
        searchFor: (text) => {
          if (!this.tabs.includes(tab)) return;
          this.newTab({ url: searchUrl(text.slice(0, 1000)), index: this.childIndex(tab), activate: true, openerId: tab.id });
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
    const resolved = text ? resolveInput(text) : null;
    this.popup(
      uiEditMenuTemplate(params, {
        edit: (cmd) => runEdit(this.uiContents, cmd),
        clipboardText: resolved ? text : null,
        clipboardIsUrl: resolved?.kind === 'url',
        // La barra de direcciones es un <input type="text">; el campo de búsqueda en la página es type="search"
        isAddressBar: params.formControlType === 'input-text',
        pasteAndGo: (t) => {
          if (this.activeTab.navigate(t)) this.activeTab.webContents.focus();
        },
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
