import { EventEmitter } from 'node:events';
import { WebContentsView, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import type { Profile } from './profile';
import type { TabState } from '../shared/ipc';
import { resolveInput } from '../shared/omnibox';
import { classifyUrl } from '../shared/url-security';
import { describeNetError, ERR_ABORTED, HTTPS_UPGRADE_FALLBACK_ERRORS } from '../shared/net-errors';
import { errorPageScript } from './error-page';

/** Crea la pestaña que alojará una ventana abierta por la página (target=_blank, window.open). */
export type OpenWindowHandler = (options: BrowserWindowConstructorOptions, disposition: string) => Tab;

interface FailedLoad {
  url: string;
  code: number;
  title: string;
}

/**
 * Una pestaña: un WebContentsView con su navegación independiente.
 * V0.2 tiene una pestaña por ventana; V0.3 agrega varias por ventana.
 */
export class Tab extends EventEmitter<{ 'state-changed': []; crashed: [string] }> {
  readonly view: WebContentsView;
  /** Lo asigna la ventana dueña de la pestaña. */
  openWindow: OpenWindowHandler | null = null;
  private failed: FailedLoad | null = null;
  private pendingErrorScript: string | null = null;
  /** Navegación a https elegida por Callisto (no por el usuario): si la conexión falla, se reintenta con http. */
  private httpsUpgrade: { https: string; http: string } | null = null;
  private stateQueued = false;

  constructor(readonly profile: Profile, adopt?: BrowserWindowConstructorOptions) {
    super();
    this.view = adopt
      ? // Electron exige construir la ventana hija con las opciones recibidas (incluyen el webContents ya creado)
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
    this.wire();
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  private wire(): void {
    const wc = this.webContents;
    const changed = () => this.queueState();

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
    wc.on('did-navigate', changed);
    wc.on('did-navigate-in-page', changed);
    wc.on('page-title-updated', changed);

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
      this.emit('crashed', details.reason);
      changed();
    });

    // Enlaces target=_blank y window.open: se crean como ventanas de Callisto conservando window.opener
    // (necesario para los popups de inicio de sesión OAuth). En V0.3 las pestañas nuevas irán a la misma ventana.
    wc.setWindowOpenHandler((details) => {
      let url: URL;
      try { url = new URL(details.url); } catch { return { action: 'deny' }; }
      if (!['http:', 'https:', 'about:'].includes(url.protocol) || !this.openWindow) return { action: 'deny' };
      const open = this.openWindow;
      return {
        action: 'allow',
        outlivesOpener: details.disposition !== 'new-window',
        createWindow: (options) => open(options, details.disposition).webContents,
      };
    });
  }

  private queueState(): void {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => {
      this.stateQueued = false;
      if (!this.webContents.isDestroyed()) this.emit('state-changed');
    });
  }

  get state(): TabState {
    const wc = this.webContents;
    const url = this.failed ? this.failed.url : wc.getURL();
    return {
      url,
      title: this.failed ? this.failed.title : wc.getTitle(),
      isLoading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      security: classifyUrl(url, this.failed !== null),
    };
  }

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

  loadURL(url: string): void {
    // Los errores de carga se manejan con 'did-fail-load'; la promesa rechazada no aporta nada más.
    this.webContents.loadURL(url).catch(() => {});
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

  destroy(): void {
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}
