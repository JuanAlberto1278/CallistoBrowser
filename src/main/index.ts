import { app, session } from 'electron';
import { join } from 'node:path';
import { configureUserData, prepareQuarantine } from './paths';
import { registerInternalScheme, serveInternalUi, UI_ORIGIN } from './internal-protocol';
import { Profile } from './profile';
import { BrowserWindowController, type WindowContext } from './window';
import { Tab } from './tab';
import { ClosedTabs } from './closed-tabs';
import { registerIpc } from './ipc';
import { buildUserAgent } from '../shared/user-agent';

// ---------------------------------------------------------------- antes de que Electron esté listo
configureUserData();
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

    // Sesión interna (en memoria) de la interfaz: sin permisos, con el protocolo callisto://
    const uiSession = session.fromPartition('callisto-ui');
    uiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    uiSession.setPermissionCheckHandler(() => false);
    serveInternalUi(uiSession, join(__dirname, '../renderer'));

    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    const uiUrl = devUrl ? devUrl : `${UI_ORIGIN}/index.html`;
    const trustedOrigin = devUrl ? new URL(devUrl).origin : UI_ORIGIN;
    registerIpc((url) => url.startsWith(trustedOrigin + '/'));

    const profile = new Profile('default', {
      userAgent,
      webContentPreload: join(__dirname, '../preload/web-content.js'),
    });
    profile.on('download-blocked', (info, wc) => {
      Tab.fromWebContents(wc)?.showNotice(
        'warning',
        `Callisto bloqueó la descarga de «${info.filename}». Las descargas todavía no están disponibles en esta versión; no se guardó nada.`,
      );
    });

    const ctx: WindowContext = { profile, uiSession, uiUrl, uiPreload: join(__dirname, '../preload/ui.js'), closedTabs: new ClosedTabs() };
    new BrowserWindowController(ctx, { url: urlFromArgv(process.argv) });

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
