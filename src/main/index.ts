import { app, session } from 'electron';
import { join } from 'node:path';
import { configureUserData, prepareQuarantine } from './paths';
import { configureTestMode } from './test-mode';
import { registerInternalScheme, serveInternalPages, serveInternalUi, UI_ORIGIN } from './internal-protocol';
import { Profile } from './profile';
import { BrowserWindowController, type WindowContext } from './window';
import { Tab } from './tab';
import { ClosedTabs } from './closed-tabs';
import { SessionStore } from './session-store';
import { SessionSaver } from './session-saver';
import { registerIpc } from './ipc';
import { buildUserAgent } from '../shared/user-agent';

// ---------------------------------------------------------------- antes de que Electron esté listo
configureUserData();
configureTestMode();
registerInternalScheme();
app.enableSandbox(); // todos los procesos de renderizado en sandbox, sin excepciones
const userAgent = buildUserAgent(app.userAgentFallback, app.getVersion());
app.userAgentFallback = userAgent;

/** URL http(s) pasada por línea de comandos (p. ej. al abrir un enlace con Callisto). */
function urlFromArgv(argv: string[]): string | undefined {
  for (const arg of argv.slice(1)) {
    if (!/^https?:\/\//i.test(arg)) continue;
    try {
      return new URL(arg).href;
    } catch {
      /* ignorar */
    }
  }
  return undefined;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());

  // Red de seguridad para cualquier webContents: sin <webview>.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    prepareQuarantine();
    // Identidad de la app para las notificaciones de Windows (si un sitio tiene permiso para mostrarlas)
    app.setAppUserModelId('app.callisto.browser');

    // Sesión interna (en memoria) de la interfaz: sin permisos, con el protocolo callisto://
    const uiSession = session.fromPartition('callisto-ui');
    uiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    uiSession.setPermissionCheckHandler(() => false);
    serveInternalUi(uiSession, join(__dirname, '../renderer'));

    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    const uiUrl = devUrl ? devUrl : `${UI_ORIGIN}/index.html`;
    const trustedOrigin = devUrl ? new URL(devUrl).origin : UI_ORIGIN;
    registerIpc((url) => url.startsWith(trustedOrigin + '/'));

    // Sesión de las páginas internas (historial, configuración): en memoria, sin permisos, separada de la web
    const internalSession = session.fromPartition('callisto-internal');
    internalSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    internalSession.setPermissionCheckHandler(() => false);
    serveInternalPages(internalSession, join(__dirname, '../renderer'), devUrl || undefined);

    const profile = new Profile('default', {
      userAgent,
      webContentPreload: join(__dirname, '../preload/web-content.js'),
      dataDir: join(app.getPath('userData'), 'Profiles', 'default'),
      internal: { session: internalSession, preload: join(__dirname, '../preload/internal.js') },
    });
    profile.history.expire();
    profile.on('download-blocked', (info, wc) => {
      Tab.fromWebContents(wc)?.showNotice(
        'warning',
        `Callisto bloqueó la descarga de «${info.filename}». Las descargas todavía no están disponibles en esta versión; no se guardó nada.`,
      );
    });
    profile.on('permission-request', (wc, request) => {
      const tab = Tab.fromWebContents(wc);
      if (tab) tab.requestPermission(request);
      else request.respond(false, false);
    });
    profile.on('settings-changed', () => BrowserWindowController.refreshAll());

    // Sesión de ventanas y pestañas: se guarda mientras se navega y se recupera al arrancar
    const sessionStore = new SessionStore(profile.kv);
    const saved = sessionStore.load();
    const closedTabs = new ClosedTabs(saved.closed);
    const saver = new SessionSaver(
      sessionStore,
      () => ({
        version: 1,
        windows: [...BrowserWindowController.all].filter((w) => !w.closing || BrowserWindowController.all.size === 1).map((w) => w.saved()),
        closed: closedTabs.entries(),
      }),
      (w) => BrowserWindowController.all.size === 1 && BrowserWindowController.all.has(w as BrowserWindowController),
    );
    closedTabs.onChange = () => saver.markDirty();
    app.on('before-quit', () => saver.finalSave());
    // La base se cierra en el último momento del proceso: después de 'will-quit' Chromium todavía puede consultar
    // permisos (service workers), y una base ya cerrada provocaba el error "database is not open".
    process.once('exit', () => profile.close());

    const ctx: WindowContext = { profile, uiSession, uiUrl, uiPreload: join(__dirname, '../preload/ui.js'), closedTabs, session: saver };

    const startUrl = urlFromArgv(process.argv);
    const restore = profile.settings.startup === 'restore' ? saved.windows : [];
    for (const w of restore) {
      new BrowserWindowController(ctx, { restore: { tabs: w.tabs, active: w.active }, bounds: w.bounds, maximized: w.maximized });
    }
    if (restore.length === 0) new BrowserWindowController(ctx, { url: startUrl });
    else if (startUrl) BrowserWindowController.current()?.newTab({ url: startUrl });

    if (profile.recoveredDatabase) {
      BrowserWindowController.current()?.active.showNotice(
        'warning',
        'Los datos de Callisto (historial, sesión) estaban dañados y se empezó de nuevo. La copia dañada se guardó aparte.',
      );
    }

    // Abrir Callisto otra vez: la URL recibida va a una pestaña nueva de la ventana actual (como Chrome);
    // sin URL, se enfoca la ventana.
    app.on('second-instance', (_e, argv) => {
      const url = urlFromArgv(argv);
      const current = BrowserWindowController.current();
      if (!current) {
        new BrowserWindowController(ctx, { url });
        return;
      }
      if (url) current.newTab({ url });
      current.focus();
    });
  });
}
