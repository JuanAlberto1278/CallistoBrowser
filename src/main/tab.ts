import { EventEmitter } from 'node:events';
import { WebContentsView, type BrowserWindowConstructorOptions, type ContextMenuParams, type Event, type Input, type Referrer, type WebContents } from 'electron';
import type { Profile } from './profile';
import type { FindState, Notice, TabState } from '../shared/ipc';
import { resolveInput } from '../shared/omnibox';
import { classifyUrl } from '../shared/url-security';
import { stepZoom, zoomPercent } from '../shared/zoom';
import { describeNetError, ERR_ABORTED, HTTPS_UPGRADE_FALLBACK_ERRORS } from '../shared/net-errors';
import { errorPageScript } from './error-page';
import type { TabSnapshot } from './closed-tabs';

/**
 * Lo asigna la ventana dueña: crea la pestaña (o la ventana) que alojará el contenido que abre la página
 * (target=_blank, window.open). Debe devolver la pestaña creada de forma síncrona.
 */
export type OpenHandler = (opener: Tab, options: BrowserWindowConstructorOptions, disposition: string) => Tab;

export interface TabOptions {
  /** Contenido ya creado por Chromium (window.open, target=_blank): la pestaña lo adopta. */
  adopt?: BrowserWindowConstructorOptions;
  openerId?: number | null;
}

interface FailedLoad {
  url: string;
  code: number;
  title: string;
}

type TabEvents = {
  'state-changed': [];
  input: [Event, Input];
  'context-menu': [ContextMenuParams];
  /** La página se cerró sola (window.close()) o su contenido se destruyó sin que Callisto lo pidiera. */
  'closed-by-page': [];
  /** Cambió el zoom. Chromium lo aplica por sitio: puede afectar a otras pestañas del mismo sitio. */
  'zoom-changed': [];
  /** Hay un favicon nuevo para mostrar (clave + imagen como URL data:). */
  favicon: [string, string];
};

let nextTabId = 1;

/** Una pestaña: un WebContentsView con su navegación, búsqueda, zoom y aviso independientes. */
export class Tab extends EventEmitter<TabEvents> {
  private static readonly byContentsId = new Map<number, Tab>();

  static fromWebContents(wc: WebContents): Tab | undefined {
    return Tab.byContentsId.get(wc.id);
  }

  readonly id = nextTabId++;
  readonly view: WebContentsView;
  /**
   * Referencia propia al contenido: cuando se destruye, Electron deja `view.webContents` en undefined, pero acá sigue
   * disponible para preguntar `isDestroyed()` desde callbacks diferidos (estado, favicons) sin romper el proceso.
   */
  readonly webContents: WebContents;
  /** Pestaña desde la que se abrió (para ubicar las pestañas hijas a su derecha). */
  openerId: number | null;
  openHandler: OpenHandler | null = null;

  private failed: FailedLoad | null = null;
  private pendingErrorScript: string | null = null;
  /** Navegación a https elegida por Callisto (no por el usuario): si la conexión falla, se reintenta con http. */
  private httpsUpgrade: { https: string; http: string } | null = null;
  private stateQueued = false;
  private closing = false;
  private faviconKey: string | null = null;
  private faviconSeq = 0;
  private findState: FindState | null = null;
  private findRequest = 0;
  private noticeState: Notice | null = null;
  private static noticeSeq = 0;

  constructor(readonly profile: Profile, opts: TabOptions = {}) {
    super();
    this.openerId = opts.openerId ?? null;
    const adopt = opts.adopt;
    this.view = adopt
      ? // Electron exige construir el contenedor con las opciones recibidas (incluyen el webContents ya creado)
        new WebContentsView({ webContents: (adopt as { webContents?: WebContents }).webContents, webPreferences: adopt.webPreferences })
      : new WebContentsView({
          webPreferences: {
            session: profile.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // Necesario para que el preload de corrección WebAuthn también corra en iframes (no da acceso a Node: sandbox)
            nodeIntegrationInSubFrames: true,
            webviewTag: false,
            safeDialogs: true,
            spellcheck: true,
          },
        });
    this.view.setBackgroundColor('#ffffff');
    this.webContents = this.view.webContents;
    Tab.byContentsId.set(this.webContents.id, this);
    this.wire();
  }

  private wire(): void {
    const wc = this.webContents;
    const contentsId = wc.id;
    const changed = () => this.queueState();

    wc.on('destroyed', () => {
      Tab.byContentsId.delete(contentsId);
      if (!this.closing) this.emit('closed-by-page');
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.failed = null;
      this.pendingErrorScript = null;
      if (this.httpsUpgrade && details.url !== this.httpsUpgrade.https) this.httpsUpgrade = null;
      changed();
    });
    wc.on('did-start-loading', changed);
    wc.on('did-stop-loading', () => {
      if (this.pendingErrorScript) {
        const script = this.pendingErrorScript;
        this.pendingErrorScript = null;
        wc.executeJavaScript(script).catch(() => {});
      }
      changed();
    });
    wc.on('did-navigate', () => {
      // Documento nuevo: favicon y resultados de búsqueda anteriores ya no valen
      this.faviconKey = null;
      this.faviconSeq++;
      if (this.findState) this.findState = { ...this.findState, activeMatch: 0, matches: 0, searched: false };
      changed();
    });
    wc.on('did-navigate-in-page', changed);
    wc.on('page-title-updated', changed);
    // Chromium informa los íconos declarados en <head> y, si no hay ninguno, propone /favicon.ico del sitio (como Chrome).
    wc.on('page-favicon-updated', (_e, favicons) => {
      const url = favicons.find((f) => /^(https?:|data:)/i.test(f));
      if (url) this.loadFavicon(url);
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      const up = this.httpsUpgrade;
      if (up && validatedURL === up.https && HTTPS_UPGRADE_FALLBACK_ERRORS.has(code)) {
        // Igual que las "HTTPS-Upgrades" de Chrome: el sitio no ofrece HTTPS -> se carga por HTTP (marcado "No seguro").
        this.httpsUpgrade = null;
        wc.loadURL(up.http).catch(() => {});
        return;
      }
      const info = describeNetError(code, description);
      this.failed = { url: validatedURL, code, title: info.title };
      this.pendingErrorScript = errorPageScript(info, validatedURL, code);
      changed();
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.showNotice('warning', 'La página dejó de funcionar. Presioná F5 para volver a cargarla.');
    });

    wc.on('before-input-event', (e, input) => this.emit('input', e, input));
    wc.on('context-menu', (_e, params) => this.emit('context-menu', params));
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction)); // Ctrl + rueda del mouse

    wc.on('found-in-page', (_e, result) => {
      if (!this.findState || result.requestId !== this.findRequest) return;
      this.findState = {
        ...this.findState,
        activeMatch: result.activeMatchOrdinal ?? this.findState.activeMatch,
        matches: result.matches ?? this.findState.matches,
        searched: true,
      };
      changed();
    });

    // Enlaces target=_blank y window.open: la ventana dueña decide si van a una pestaña o a una ventana nueva.
    // Se conserva window.opener (necesario para los popups de inicio de sesión OAuth).
    wc.setWindowOpenHandler((details) => {
      let url: URL;
      try { url = new URL(details.url); } catch { return { action: 'deny' }; }
      if (!['http:', 'https:', 'about:'].includes(url.protocol) || !this.openHandler) return { action: 'deny' };
      const open = this.openHandler;
      return {
        action: 'allow',
        outlivesOpener: details.disposition !== 'new-window',
        createWindow: (options) => open(this, options, details.disposition).webContents,
      };
    });
  }

  private loadFavicon(url: string): void {
    const seq = ++this.faviconSeq;
    this.profile.favicons.load(url).then((data) => {
      if (seq !== this.faviconSeq || this.webContents.isDestroyed() || !data) return;
      this.faviconKey = url;
      this.emit('favicon', url, data);
      this.queueState();
    });
  }

  queueState(): void {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => {
      this.stateQueued = false;
      if (!this.webContents.isDestroyed()) this.emit('state-changed');
    });
  }

  get url(): string {
    return this.failed ? this.failed.url : this.webContents.getURL();
  }

  /** Pestaña sin contenido (nueva pestaña). */
  get isBlank(): boolean {
    const url = this.url;
    return (url === '' || url === 'about:blank') && !this.webContents.isLoading();
  }

  get state(): TabState {
    const wc = this.webContents;
    const url = this.url;
    return {
      id: this.id,
      url,
      // Una página en blanco no tiene título (Chromium devolvería "about:blank")
      title: this.failed ? this.failed.title : url === '' || url === 'about:blank' ? '' : wc.getTitle(),
      isLoading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      security: classifyUrl(url, this.failed !== null),
      faviconKey: this.faviconKey,
      zoomPercent: zoomPercent(wc.getZoomFactor()),
      find: this.findState,
      notice: this.noticeState,
    };
  }

  // ---------------------------------------------------------------- navegación

  /** Navega a lo que el usuario escribió en la barra de direcciones. Devuelve false si no había nada que hacer. */
  navigate(input: string): boolean {
    const resolved = resolveInput(input);
    if (!resolved) return false;
    if (resolved.kind === 'url' && resolved.upgradedToHttps) {
      this.httpsUpgrade = { https: resolved.url, http: resolved.url.replace(/^https:/, 'http:') };
    } else {
      this.httpsUpgrade = null;
    }
    this.loadURL(resolved.url);
    return true;
  }

  loadURL(url: string, referrer?: Referrer): void {
    // Los errores de carga se manejan con 'did-fail-load'; la promesa rechazada no aporta nada más.
    this.webContents.loadURL(url, referrer ? { httpReferrer: referrer } : undefined).catch(() => {});
  }

  goBack(): void {
    if (this.webContents.navigationHistory.canGoBack()) this.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    if (this.webContents.navigationHistory.canGoForward()) this.webContents.navigationHistory.goForward();
  }

  reload(ignoreCache = false): void {
    if (this.failed) return this.loadURL(this.failed.url);
    if (ignoreCache) this.webContents.reloadIgnoringCache();
    else this.webContents.reload();
  }

  stop(): void {
    this.webContents.stop();
  }

  // ---------------------------------------------------------------- historial (duplicar / reabrir)

  snapshot(): TabSnapshot {
    const h = this.webContents.navigationHistory;
    const entries = h.getAllEntries();
    // Una carga fallida no queda como entrada propia: se guarda la URL que falló para poder reintentarla.
    if (this.failed && entries.length > 0) {
      const i = h.getActiveIndex();
      entries[i] = { ...entries[i]!, url: this.failed.url, title: '', pageState: undefined };
    }
    return { entries, index: h.getActiveIndex() };
  }

  restore(s: TabSnapshot): void {
    this.webContents.navigationHistory.restore({ entries: s.entries, index: s.index }).catch(() => {});
  }

  // ---------------------------------------------------------------- zoom (Chromium lo aplica por sitio, como Chrome y Edge)

  zoom(direction: 'in' | 'out' | 'reset'): void {
    const wc = this.webContents;
    wc.setZoomFactor(direction === 'reset' ? 1 : stepZoom(wc.getZoomFactor(), direction));
    this.emit('zoom-changed');
  }

  // ---------------------------------------------------------------- buscar en la página

  get findOpen(): boolean {
    return this.findState !== null;
  }

  openFind(): void {
    if (!this.findState) {
      this.findState = { query: '', activeMatch: 0, matches: 0, searched: false };
      this.queueState();
    }
  }

  find(query: string, forward: boolean, newSession: boolean): void {
    if (!this.findState) this.openFind();
    if (!query) {
      this.webContents.stopFindInPage('clearSelection');
      this.findState = { query: '', activeMatch: 0, matches: 0, searched: false };
      this.queueState();
      return;
    }
    const isNew = newSession || query !== this.findState!.query || !this.findState!.searched;
    this.findState = isNew ? { query, activeMatch: 0, matches: 0, searched: false } : { ...this.findState!, query };
    this.findRequest = this.webContents.findInPage(query, { forward, findNext: isNew });
    this.queueState();
  }

  /** Repite la última búsqueda (F3 / Shift+F3). Devuelve false si no hay nada que repetir. */
  findAgain(forward: boolean): boolean {
    if (!this.findState?.query) return false;
    this.find(this.findState.query, forward, false);
    return true;
  }

  closeFind(): void {
    if (!this.findState) return;
    this.findState = null;
    this.webContents.stopFindInPage('keepSelection');
    this.queueState();
  }

  // ---------------------------------------------------------------- avisos

  get notice(): Notice | null {
    return this.noticeState;
  }

  showNotice(kind: Notice['kind'], text: string): void {
    this.noticeState = { id: ++Tab.noticeSeq, kind, text };
    this.queueState();
  }

  dismissNotice(id: number): void {
    if (this.noticeState?.id !== id) return;
    this.noticeState = null;
    this.queueState();
  }

  // ---------------------------------------------------------------- ciclo de vida

  destroy(): void {
    this.closing = true;
    this.removeAllListeners();
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}
