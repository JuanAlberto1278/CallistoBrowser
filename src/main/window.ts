import { app, BaseWindow, WebContentsView, type BrowserWindowConstructorOptions, type Event, type Input, type Session, type WebContents } from 'electron';
import { Tab } from './tab';
import type { Profile } from './profile';
import { matchShortcut, type ShortcutAction } from './shortcuts';
import { IPC, type Notice, type WindowState } from '../shared/ipc';

const TOOLBAR_HEIGHT = 48;
const NOTICE_HEIGHT = 40;

export interface WindowContext {
  profile: Profile;
  uiSession: Session;
  uiUrl: string;
  uiPreload: string;
}

export interface WindowOptions {
  url?: string;
  /** Ventana abierta por una página (window.open / target=_blank): adopta el webContents que creó Chromium. */
  adopt?: BrowserWindowConstructorOptions;
  disposition?: string;
}

/**
 * Ventana del navegador: interfaz (barra de navegación) arriba y la pestaña debajo.
 * La interfaz corre en su propia sesión interna, separada de las páginas web.
 */
export class BrowserWindowController {
  static readonly all = new Set<BrowserWindowController>();

  static fromUi(wc: WebContents): BrowserWindowController | undefined {
    for (const c of this.all) if (c.ui.webContents === wc) return c;
    return undefined;
  }

  static fromTabContents(wc: WebContents): BrowserWindowController | undefined {
    for (const c of this.all) if (c.tab.webContents === wc) return c;
    return undefined;
  }

  readonly win: BaseWindow;
  readonly ui: WebContentsView;
  readonly tab: Tab;
  private notice: Notice | null = null;
  private noticeSeq = 0;
  private uiReady = false;
  private focusAddressBarWhenReady: boolean;

  constructor(ctx: WindowContext, opts: WindowOptions = {}) {
    const isPopup = opts.disposition === 'new-window';
    const width = isPopup && opts.adopt?.width ? Math.max(400, opts.adopt.width) : 1280;
    const height = isPopup && opts.adopt?.height ? Math.max(300, opts.adopt.height + TOOLBAR_HEIGHT) : 860;
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
    this.tab = new Tab(ctx.profile, opts.adopt);
    this.tab.openWindow = (options, disposition) => new BrowserWindowController(ctx, { adopt: options, disposition }).tab;

    this.win.contentView.addChildView(this.tab.view);
    this.win.contentView.addChildView(this.ui);
    this.layout();
    this.win.on('resize', () => this.layout());

    // La interfaz nunca navega ni abre ventanas.
    this.ui.webContents.on('will-navigate', (e) => e.preventDefault());
    this.ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    this.ui.webContents.on('before-input-event', (e, input) => this.onInput(e, input, false));
    this.tab.webContents.on('before-input-event', (e, input) => this.onInput(e, input, true));

    this.tab.on('state-changed', () => this.sendState());
    this.tab.on('crashed', () => this.showNotice('warning', 'La página dejó de funcionar. Presioná F5 para volver a cargarla.'));

    this.win.on('closed', () => {
      BrowserWindowController.all.delete(this);
      this.tab.destroy();
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close();
    });

    BrowserWindowController.all.add(this);
    this.ui.webContents.loadURL(ctx.uiUrl).catch(() => {});

    this.focusAddressBarWhenReady = !opts.url && !opts.adopt;
    if (opts.url) this.tab.loadURL(opts.url);
    else if (!opts.adopt) this.tab.loadURL('about:blank');
  }

  private layout(): void {
    const { width, height } = this.win.getContentBounds();
    const top = TOOLBAR_HEIGHT + (this.notice ? NOTICE_HEIGHT : 0);
    this.ui.setBounds({ x: 0, y: 0, width, height: top });
    this.tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  onUiReady(): void {
    this.uiReady = true;
    this.sendState();
    if (this.focusAddressBarWhenReady) {
      this.focusAddressBarWhenReady = false;
      this.focusAddressBar();
    } else {
      this.tab.webContents.focus();
    }
  }

  sendState(): void {
    if (this.win.isDestroyed()) return;
    const state: WindowState = { tab: this.tab.state, notice: this.notice };
    const blank = !state.tab.url || state.tab.url === 'about:blank';
    const title = !blank && state.tab.title ? state.tab.title : 'Nueva pestaña';
    this.win.setTitle(`${title} — Callisto`);
    if (this.uiReady && !this.ui.webContents.isDestroyed()) this.ui.webContents.send(IPC.state, state);
  }

  focusAddressBar(): void {
    this.ui.webContents.focus();
    this.ui.webContents.send(IPC.focusAddressBar);
  }

  showNotice(kind: Notice['kind'], text: string): void {
    this.notice = { id: ++this.noticeSeq, kind, text };
    this.layout();
    this.sendState();
  }

  dismissNotice(id: number): void {
    if (this.notice?.id !== id) return;
    this.notice = null;
    this.layout();
    this.sendState();
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  private onInput(event: Event, input: Input, fromPage: boolean): void {
    const action = matchShortcut(input, { fromPage, isLoading: this.tab.webContents.isLoading() });
    if (!action) return;
    event.preventDefault();
    this.run(action);
  }

  private run(action: ShortcutAction): void {
    switch (action) {
      case 'focus-address-bar': return this.focusAddressBar();
      case 'back': return this.tab.goBack();
      case 'forward': return this.tab.goForward();
      case 'reload': return this.tab.reload(false);
      case 'reload-ignore-cache': return this.tab.reload(true);
      case 'stop': return this.tab.stop();
      case 'devtools': return this.tab.webContents.toggleDevTools();
      case 'close-window': return this.win.close();
    }
  }
}
