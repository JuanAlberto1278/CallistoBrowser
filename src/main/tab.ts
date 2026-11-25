import { EventEmitter } from 'node:events';
import { WebContentsView, type BrowserWindowConstructorOptions, type ContextMenuParams, type Event, type Input, type Referrer, type WebContents } from 'electron';
import type { PermissionRequest, Profile } from './profile';
import { popupAllowed } from '../shared/site-settings';
import { SiteContentBlocker } from './site-blocking';
import type { FindState, Notice, NoticeAction, PermissionPrompt, TabState } from '../shared/ipc';
import type { ResolvedInput } from '../shared/omnibox';
import { classifyUrl } from '../shared/url-security';
import { stepZoom, zoomPercent } from '../shared/zoom';
import { describeNetError, ERR_ABORTED, HTTPS_UPGRADE_FALLBACK_ERRORS } from '../shared/net-errors';
import { internalPageOf } from '../shared/internal-pages';
import { errorPageScript } from './error-page';
import type { TabSnapshot } from './closed-tabs';
import type { SavedTab } from './session-store';
import { permissionPhrase, webOrigin } from './permissions';
import type { PasswordOffer } from '../shared/passwords';

/**
 * Lo asigna la ventana dueña: crea la pestaña (o la ventana) que alojará el contenido que abre la página
 * (target=_blank, window.open). Debe devolver la pestaña creada de forma síncrona.
 */
export type OpenHandler = (opener: Tab, options: BrowserWindowConstructorOptions, disposition: string) => Tab;

export type TabKind = 'web' | 'internal';

export interface TabOptions {
  /** 'internal': historial/configuración, con su propia sesión (nunca la sesión web del perfil). */
  kind?: TabKind;
  /** Contenido ya creado por Chromium (window.open, target=_blank): la pestaña lo adopta. */
  adopt?: BrowserWindowConstructorOptions;
  openerId?: number | null;
  /** Pestaña restaurada que todavía no se cargó: se carga recién cuando se la activa. */
  pending?: SavedTab;
  /** Pestaña nueva abierta por el usuario: mientras esté vacía muestra la página de nueva pestaña. */
  newTabPage?: boolean;
  /** Pestaña dormida (para ahorrar memoria): `pending` es lo que tenía; se vuelve a cargar al activarla. */
  asleep?: boolean;
}

interface FailedLoad {
  url: string;
  code: number;
  title: string;
}

interface PendingPermission extends PermissionPrompt {
  responders: PermissionRequest[];
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
  /** El frame principal cargó un documento nuevo (para las contraseñas: ¿el inicio de sesión funcionó?). */
  navigated: [];
  /** Abrir esta dirección en una pestaña nueva junto a esta (1.5: la ventana emergente bloqueada que el usuario abrió). */
  'open-url': [string];
};

/** Inicio de sesión enviado, a la espera de saber si funcionó (ver passwords.ts). La contraseña, solo en memoria. */
export interface PendingLogin {
  origin: string;
  username: string;
  password: string;
  at: number;
  navigated: boolean;
}

let nextTabId = 1;
let nextPromptId = 1;

/** Una pestaña: un WebContentsView con su navegación, búsqueda, zoom, avisos y permisos independientes. */
/** Botones del aviso "La página no responde". */
const UNRESPONSIVE_ACTIONS: NonNullable<Notice['actions']> = [
  { id: 'wait', label: 'Esperar' },
  { id: 'stop', label: 'Detener la página' },
];

export class Tab extends EventEmitter<TabEvents> {
  private static readonly byContentsId = new Map<number, Tab>();

  static fromWebContents(wc: WebContents): Tab | undefined {
    return Tab.byContentsId.get(wc.id);
  }

  readonly id = nextTabId++;
  readonly kind: TabKind;
  readonly view: WebContentsView;
  /**
   * Referencia propia al contenido: cuando se destruye, Electron deja `view.webContents` en undefined, pero acá sigue
   * disponible para preguntar `isDestroyed()` desde callbacks diferidos (estado, favicons) sin romper el proceso.
   */
  readonly webContents: WebContents;
  /** Pestaña desde la que se abrió (para ubicar las pestañas hijas a su derecha). */
  openerId: number | null;
  openHandler: OpenHandler | null = null;
  /** Abierta por el usuario como pestaña nueva (no por una página): vacía, muestra la página de nueva pestaña. */
  readonly newTabPage: boolean;
  private groupIdValue: number | null = null;
  private pinnedValue = false;
  private highCpuValue = false;

  /** En segundo plano y usando mucha CPU desde hace un rato (lo decide cpu-watch.ts). */
  get highCpu(): boolean {
    return this.highCpuValue;
  }

  set highCpu(on: boolean) {
    if (on === this.highCpuValue) return;
    this.highCpuValue = on;
    this.queueState();
  }

  /** Fijada (la ordena la ventana: siempre primero). */
  get pinned(): boolean {
    return this.pinnedValue;
  }

  set pinned(on: boolean) {
    if (on === this.pinnedValue) return;
    this.pinnedValue = on;
    if (!this.webContents.isDestroyed()) (this.webContents as unknown as NodeJS.EventEmitter).emit('tab-updated');
    this.queueState();
  }

  /** Grupo de pestañas al que pertenece (lo administra la ventana). */
  get groupId(): number | null {
    return this.groupIdValue;
  }

  set groupId(id: number | null) {
    if (id === this.groupIdValue) return;
    this.groupIdValue = id;
    // Las extensiones (chrome.tabs) ven el grupo de cada pestaña: 'tab-updated' es el aviso que espera
    // electron-chrome-extensions para volver a leer los datos de la pestaña y emitir tabs.onUpdated
    if (!this.webContents.isDestroyed()) (this.webContents as unknown as NodeJS.EventEmitter).emit('tab-updated');
  }
  /** Última vez que fue la pestaña activa (para dormir las que no se usan). */
  lastActive = Date.now();
  /** El usuario escribió en la página desde la última navegación (podría tener texto sin guardar: no se duerme sola). */
  private typedSinceNavigation = false;
  /** Dormida: sin proceso; se vuelve a cargar al activarla. */
  private asleepValue: boolean;

  /** Contraseñas (los administra passwords.ts): lo enviado, el usuario de un primer paso y la oferta de guardar. */
  pendingLogin: PendingLogin | null = null;
  usernameCandidate: { origin: string; username: string; at: number } | null = null;
  private passwordOfferValue: { offer: PasswordOffer; password: string; loginId: number | null } | null = null;

  private pending: SavedTab | null;
  private failed: FailedLoad | null = null;
  private pendingErrorScript: string | null = null;
  /** Navegación a https elegida por Callisto (no por el usuario): si la conexión falla, se reintenta con http. */
  private httpsUpgrade: { https: string; http: string } | null = null;
  /** Cómo empezó la próxima navegación (para el historial): escrita, recarga o atrás/adelante. */
  private nextTransition: 'typed' | 'reload' | 'history' | null = null;
  private lastRecordedUrl = '';
  private stateQueued = false;
  private closing = false;
  private faviconKey: string | null = null;
  private faviconSeq = 0;
  private findState: FindState | null = null;
  private findRequest = 0;
  private noticeState: Notice | null = null;
  private static noticeSeq = 0;
  private permissionQueue: PendingPermission[] = [];

  constructor(readonly profile: Profile, opts: TabOptions = {}) {
    super();
    this.openerId = opts.openerId ?? null;
    this.pending = opts.pending ?? null;
    this.kind = opts.kind ?? (opts.pending && internalPageOf(opts.pending.url) ? 'internal' : 'web');
    this.faviconKey = opts.pending?.faviconKey ?? null;
    this.newTabPage = opts.newTabPage ?? (!!opts.pending && (opts.pending.url === 'about:blank' || opts.pending.url === ''));
    this.asleepValue = !!opts.asleep && !!opts.pending;
    const adopt = opts.adopt;
    const secure = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, safeDialogs: true } as const;
    this.view = adopt
      ? // Electron exige construir el contenedor con las opciones recibidas (incluyen el webContents ya creado)
        new WebContentsView({ webContents: (adopt as { webContents?: WebContents }).webContents, webPreferences: adopt.webPreferences })
      : this.kind === 'internal'
        ? new WebContentsView({ webPreferences: { ...secure, session: profile.internal.session, preload: profile.internal.preload, spellcheck: false } })
        : new WebContentsView({
            webPreferences: {
              ...secure,
              session: profile.session,
              // Necesario para que el preload de corrección WebAuthn también corra en iframes (no da acceso a Node: sandbox)
              nodeIntegrationInSubFrames: true,
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
      this.blocker?.dispose();
      this.denyAllPermissions();
      if (!this.closing) this.emit('closed-by-page');
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.applySiteBlocking(details.url);
      this.failed = null;
      this.pendingErrorScript = null;
      if (this.httpsUpgrade && details.url !== this.httpsUpgrade.https) this.httpsUpgrade = null;
      // Los pedidos de permiso de la página anterior ya no corresponden
      if (this.permissionQueue.length && originOf(details.url) !== this.permissionQueue[0]!.origin) this.denyAllPermissions();
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
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      this.applySiteSound(url);
      // Documento nuevo: favicon y resultados de búsqueda anteriores ya no valen
      this.faviconKey = null;
      this.faviconSeq++;
      if (this.findState) this.findState = { ...this.findState, activeMatch: 0, matches: 0, searched: false };
      this.applySavedZoom(url);
      const transition = this.nextTransition;
      this.nextTransition = null;
      // Al historial: páginas que respondieron (no las de error), salvo recargas y atrás/adelante
      const responded = url.startsWith('file:') ? !this.failed : httpResponseCode > 0;
      if (responded && transition !== 'reload' && transition !== 'history') this.record(url, transition === 'typed');
      else this.lastRecordedUrl = url;
      this.typedSinceNavigation = false;
      changed();
      this.emit('navigated');
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      // Navegación dentro de la página (aplicaciones web): cuenta como visita si cambia algo más que el ancla (#)
      // (acá el título sí es el del documento actual)
      if (isMainFrame && url.split('#')[0] !== this.lastRecordedUrl.split('#')[0]) this.record(url, false, this.realTitle());
      changed();
    });
    wc.on('page-title-updated', (_e, title) => {
      if (this.isRecording) this.profile.history.setTitle(wc.getURL(), title);
      changed();
    });
    wc.on('did-finish-load', () => {
      const title = this.realTitle();
      if (this.isRecording && title) this.profile.history.setTitle(wc.getURL(), title);
    });
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
    // La página no responde (un script que no termina): esperar o detenerla, como en Chrome y Edge
    wc.on('unresponsive', () => this.showNotice('warning', 'La página no responde. Podés esperar a que vuelva a responder o detenerla.', UNRESPONSIVE_ACTIONS));
    wc.on('responsive', () => {
      if (this.noticeState?.actions === UNRESPONSIVE_ACTIONS) {
        this.noticeState = null;
        this.queueState();
      }
    });

    wc.on('before-input-event', (e, input) => this.emit('input', e, input));
    // Empieza o deja de sonar: el ícono de audio de la pestaña
    wc.on('audio-state-changed', changed);
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

    if (this.kind === 'internal') {
      // Las páginas internas no navegan ni abren ventanas por su cuenta: todo pasa por su API, que valida el proceso principal.
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      return;
    }

    // Enlaces target=_blank y window.open: la ventana dueña decide si van a una pestaña o a una ventana nueva.
    // Se conserva window.opener (necesario para los popups de inicio de sesión OAuth).
    wc.setWindowOpenHandler((details) => {
      let url: URL;
      try { url = new URL(details.url); } catch { return { action: 'deny' }; }
      if (!['http:', 'https:', 'about:'].includes(url.protocol) || !this.openHandler) return { action: 'deny' };
      // Bloqueador de ventanas emergentes (1.5): solo las que pidió el usuario, salvo que el sitio esté permitido
      const origin = webOrigin(wc.getURL());
      if (origin && !popupAllowed(this.profile.contentSetting(origin, 'popups'), this.lastActivation, Date.now())) {
        this.popupBlocked(details.url, origin);
        return { action: 'deny' };
      }
      const open = this.openHandler;
      return {
        action: 'allow',
        outlivesOpener: details.disposition !== 'new-window',
        createWindow: (options) => open(this, options, details.disposition).webContents,
      };
    });
  }

  private get isRecording(): boolean {
    return this.kind === 'web' && this.profile.recordsHistory;
  }

  /**
   * Registra la visita. El título se guarda aparte (al informarlo la página o al terminar de cargar): justo al llegar a
   * un documento nuevo, Chromium todavía puede devolver el título de la página anterior.
   */
  private record(url: string, typed: boolean, title = ''): void {
    this.lastRecordedUrl = url;
    if (this.isRecording) this.profile.history.addVisit(url, { typed, title });
  }

  /** Título real de la página (Chromium devuelve la dirección cuando la página no tiene título). */
  private realTitle(): string {
    const title = this.webContents.getTitle();
    const url = this.webContents.getURL();
    return title && title !== url && !url.endsWith(title) ? title : '';
  }

  private loadFavicon(iconUrl: string): void {
    const seq = ++this.faviconSeq;
    const pageUrl = this.webContents.getURL();
    this.profile.favicons.load(iconUrl).then((data) => {
      if (seq !== this.faviconSeq || this.webContents.isDestroyed() || !data) return;
      this.faviconKey = iconUrl;
      if (this.isRecording && !iconUrl.startsWith('data:')) this.profile.history.setIcon(pageUrl, iconUrl);
      this.emit('favicon', iconUrl, data);
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
    if (this.pending) return this.pending.url;
    return this.failed ? this.failed.url : this.webContents.getURL();
  }

  /** Pestaña sin contenido (nueva pestaña). */
  get isBlank(): boolean {
    const url = this.url;
    return (url === '' || url === 'about:blank') && !this.webContents.isLoading();
  }

  /** ¿Se muestra ahora la página de nueva pestaña (encima de esta pestaña vacía)? */
  get showsNewTabPage(): boolean {
    return this.newTabPage && this.kind === 'web' && this.isBlank;
  }

  /** Página interna que muestra (si es una pestaña interna). */
  get internalPage() {
    return this.kind === 'internal' ? internalPageOf(this.url) : null;
  }

  get state(): TabState {
    const wc = this.webContents;
    const url = this.url;
    const p = this.pending;
    const blank = url === '' || url === 'about:blank';
    return {
      id: this.id,
      url,
      // Una página en blanco no tiene título (Chromium devolvería "about:blank")
      title: p ? p.title : this.failed ? this.failed.title : blank ? '' : wc.getTitle(),
      isLoading: p ? false : wc.isLoading(),
      canGoBack: p ? p.index > 0 : wc.navigationHistory.canGoBack(),
      canGoForward: p ? p.index < p.entries.length - 1 : wc.navigationHistory.canGoForward(),
      security: classifyUrl(url, this.failed !== null),
      faviconKey: this.faviconKey,
      zoomPercent: zoomPercent(p ? (this.savedZoom(url) ?? 1) : wc.getZoomFactor()),
      find: this.findState,
      notice: this.noticeState,
      newTabPage: this.showsNewTabPage,
      asleep: this.asleepValue,
      audible: !p && !wc.isDestroyed() && wc.isCurrentlyAudible(),
      muted: !wc.isDestroyed() && wc.isAudioMuted(),
      pinned: this.pinnedValue,
      highCpu: this.highCpuValue,
      groupId: this.groupId,
      permission: this.permissionQueue[0] ? { id: this.permissionQueue[0].id, origin: this.permissionQueue[0].origin, permissions: this.permissionQueue[0].permissions, phrase: this.permissionQueue[0].phrase } : null,
      passwordOffer: this.passwordOfferValue?.offer ?? null,
    };
  }

  /** Oferta de guardar una contraseña (la contraseña queda en el proceso principal; a la interfaz va sin ella). */
  get passwordOffer(): { offer: PasswordOffer; password: string; loginId: number | null } | null {
    return this.passwordOfferValue;
  }

  setPasswordOffer(value: { offer: PasswordOffer; password: string; loginId: number | null } | null): void {
    this.passwordOfferValue = value;
    this.queueState();
  }

  /** ¿Restaurada pero todavía sin cargar? */
  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Carga una pestaña restaurada (se llama al activarla). */
  ensureLoaded(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.asleepValue = false;
    this.restore(p);
  }

  /** Silenciar la pestaña o devolverle el sonido. */
  toggleMute(): void {
    if (this.webContents.isDestroyed()) return;
    this.webContents.setAudioMuted(!this.webContents.isAudioMuted());
    this.queueState();
  }

  /** El usuario editó algo en la página (aviso del preload): no se duerme sola hasta que navegue. */
  markEdited(): void {
    this.typedSinceNavigation = true;
  }

  get asleep(): boolean {
    return this.asleepValue;
  }

  /**
   * ¿Se puede dormir sin que el usuario pierda nada? No si está cargando, suena, tiene un pedido de permiso o una
   * oferta de contraseña pendiente, la búsqueda abierta, las herramientas de desarrollo, o si el usuario escribió algo.
   */
  get canSleep(): boolean {
    if (this.pending || this.closing) return false;
    const wc = this.webContents;
    if (wc.isDestroyed() || wc.isLoading() || wc.isCurrentlyAudible() || wc.isDevToolsOpened()) return false;
    if (this.typedSinceNavigation || this.permissionQueue.length || this.findState || this.passwordOfferValue) return false;
    const url = wc.getURL();
    return !!url && url !== 'about:blank';
  }

  // ---------------------------------------------------------------- navegación

  /** Abre lo que resolvió la barra de direcciones. `typed`: lo escribió el usuario (cuenta para el autocompletado). */
  openResolved(resolved: ResolvedInput, typed: boolean): void {
    this.httpsUpgrade = resolved.kind === 'url' && resolved.upgradedToHttps ? { https: resolved.url, http: resolved.url.replace(/^https:/, 'http:') } : null;
    this.nextTransition = typed ? 'typed' : null;
    this.loadURL(resolved.url);
  }

  loadURL(url: string, referrer?: Referrer): void {
    this.pending = null;
    // Los errores de carga se manejan con 'did-fail-load'; la promesa rechazada no aporta nada más.
    this.webContents.loadURL(url, referrer ? { httpReferrer: referrer } : undefined).catch(() => {});
  }

  goBack(): void {
    this.ensureLoaded();
    if (!this.webContents.navigationHistory.canGoBack()) return;
    this.nextTransition = 'history';
    this.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    this.ensureLoaded();
    if (!this.webContents.navigationHistory.canGoForward()) return;
    this.nextTransition = 'history';
    this.webContents.navigationHistory.goForward();
  }

  reload(ignoreCache = false): void {
    if (this.pending) return this.ensureLoaded();
    if (this.failed) return this.loadURL(this.failed.url);
    this.nextTransition = 'reload';
    if (ignoreCache) this.webContents.reloadIgnoringCache();
    else this.webContents.reload();
  }

  stop(): void {
    this.webContents.stop();
  }

  // ---------------------------------------------------------------- historial (duplicar / reabrir / sesión)

  snapshot(): TabSnapshot {
    if (this.pending) return { entries: this.pending.entries, index: this.pending.index };
    const h = this.webContents.navigationHistory;
    const entries = h.getAllEntries();
    // Una carga fallida no queda como entrada propia: se guarda la URL que falló para poder reintentarla.
    if (this.failed && entries.length > 0) {
      const i = h.getActiveIndex();
      entries[i] = { ...entries[i]!, url: this.failed.url, title: '', pageState: undefined };
    }
    return { entries, index: h.getActiveIndex() };
  }

  /** Estado para guardar en la sesión. */
  saved(): SavedTab {
    const s = this.snapshot();
    const state = this.state;
    return { ...s, url: state.url, title: state.title, faviconKey: this.faviconKey };
  }

  restore(s: TabSnapshot): void {
    this.pending = null;
    this.nextTransition = 'history'; // volver a una página no es una visita nueva
    this.webContents.navigationHistory.restore({ entries: s.entries, index: s.index }).catch(() => {});
  }

  // ---------------------------------------------------------------- zoom por sitio (como Chrome y Edge), guardado

  private savedZoom(url: string): number | undefined {
    const host = webHost(url);
    return host ? this.profile.zoom.get(host) : undefined;
  }

  /**
   * Al llegar a un sitio, aplica el zoom guardado; sin zoom guardado, el 100 % (todo cambio de zoom pasa por `zoom()`,
   * que lo guarda, así que un sitio sin registro es un sitio al 100 %, aunque se haya borrado hace un momento).
   */
  private applySavedZoom(url: string): void {
    if (!webHost(url)) return;
    const target = this.savedZoom(url) ?? 1;
    if (Math.abs(target - this.webContents.getZoomFactor()) > 0.001) this.webContents.setZoomFactor(target);
  }

  zoom(direction: 'in' | 'out' | 'reset'): void {
    const wc = this.webContents;
    const factor = direction === 'reset' ? 1 : stepZoom(wc.getZoomFactor(), direction);
    wc.setZoomFactor(factor);
    const host = webHost(wc.getURL());
    if (host) this.profile.zoom.set(host, factor);
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

  showNotice(kind: Notice['kind'], text: string, actions?: Notice['actions']): void {
    this.noticeState = { id: ++Tab.noticeSeq, kind, text, ...(actions ? { actions } : {}) };
    this.queueState();
  }

  /** Un botón del aviso. "Detener la página" termina su proceso (queda "La página dejó de funcionar", F5 la recarga). */
  noticeAction(id: number, action: NoticeAction): void {
    const n = this.noticeState;
    if (!n || n.id !== id || !n.actions?.some((a) => a.id === action)) return;
    this.noticeState = null;
    this.queueState();
    if (action === 'stop' && !this.webContents.isDestroyed()) this.webContents.forcefullyCrashRenderer();
    const blocked = this.blockedPopup;
    if ((action === 'open-popup' || action === 'allow-popups') && blocked) {
      this.blockedPopup = null;
      if (action === 'allow-popups') this.profile.setSiteSetting(blocked.origin, 'popups', 'allow');
      this.emit('open-url', blocked.url);
    }
  }

  // ---------------------------------------------------------------- ventanas emergentes y sonido por sitio (1.5)

  /** Último clic o tecla real del usuario en la página (ms). */
  private lastActivation = 0;
  private blockedPopup: { url: string; origin: string } | null = null;
  /** La pestaña está silenciada por el ajuste del sitio (no por el usuario). */
  private mutedBySite = false;

  noteActivation(): void {
    this.lastActivation = Date.now();
  }

  private popupBlocked(url: string, origin: string): void {
    this.blockedPopup = { url, origin };
    let host = origin;
    try {
      host = new URL(origin).host;
    } catch {
      /* el origen tal cual */
    }
    this.showNotice('info', `Callisto bloqueó una ventana emergente de ${host}.`, [
      { id: 'open-popup', label: 'Abrirla' },
      { id: 'allow-popups', label: 'Permitir siempre en este sitio' },
    ]);
  }

  /** JavaScript e imágenes bloqueados en el sitio que se abre (1.5): ver site-blocking.ts. */
  private blocker: SiteContentBlocker | null = null;
  private applySiteBlocking(url: string): void {
    if (this.kind !== 'web') return;
    const origin = webOrigin(url);
    const state = { javascript: !!origin && this.profile.contentSetting(origin, 'javascript') === 'block', images: !!origin && this.profile.contentSetting(origin, 'images') === 'block' };
    if (!this.blocker && !state.javascript && !state.images) return;
    this.blocker ??= new SiteContentBlocker(this.webContents);
    void this.blocker.apply(state);
  }

  /** Silencia la pestaña si su sitio está silenciado (y le devuelve el sonido si dejó de estarlo). */
  applySiteSound(url = this.url): void {
    const wc = this.webContents;
    if (this.kind !== 'web' || wc.isDestroyed()) return;
    const origin = webOrigin(url);
    const muted = !!origin && this.profile.contentSetting(origin, 'sound') === 'block';
    if (muted && !wc.isAudioMuted()) {
      wc.setAudioMuted(true);
      this.mutedBySite = true;
      this.queueState();
    } else if (!muted && this.mutedBySite) {
      this.mutedBySite = false;
      wc.setAudioMuted(false);
      this.queueState();
    }
  }

  dismissNotice(id: number): void {
    if (this.noticeState?.id !== id) return;
    this.noticeState = null;
    this.queueState();
  }

  // ---------------------------------------------------------------- permisos (cámara, micrófono, ubicación, notificaciones)

  get hasPermissionPrompt(): boolean {
    return this.permissionQueue.length > 0;
  }

  /** Muestra el pedido en la barra de la pestaña (uno a la vez; pedidos iguales esperan la misma respuesta). */
  requestPermission(req: PermissionRequest): void {
    const same = this.permissionQueue.find((p) => p.origin === req.origin && p.permissions.join() === req.permissions.join());
    if (same) {
      same.responders.push(req);
      return;
    }
    this.permissionQueue.push({ id: nextPromptId++, origin: req.origin, permissions: req.permissions, phrase: permissionPhrase(req.permissions), responders: [req] });
    this.queueState();
  }

  respondPermission(id: number, allow: boolean, remember: boolean): void {
    const i = this.permissionQueue.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.permissionQueue.splice(i, 1);
    for (const r of p!.responders) r.respond(allow, remember);
    this.queueState();
  }

  private denyAllPermissions(): void {
    const queue = this.permissionQueue;
    this.permissionQueue = [];
    for (const p of queue) for (const r of p.responders) r.respond(false, false);
    if (queue.length && !this.webContents.isDestroyed()) this.queueState();
  }

  // ---------------------------------------------------------------- ciclo de vida

  destroy(): void {
    this.closing = true;
    this.denyAllPermissions();
    this.removeAllListeners();
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Host de una página web (http/https); null para otras. */
function webHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}
