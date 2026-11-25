import { app, Menu, nativeTheme, session } from 'electron';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { configureUserData, prepareQuarantine, quarantineDir } from './paths';
import { configureTestMode } from './test-mode';
import { configureMemorySaving } from './chromium-flags';
import { registerInternalScheme, serveInternalPages, serveInternalUi, UI_ORIGIN } from './internal-protocol';
import { BrowserWindowController } from './window';
import { registerIpc, registerProfilesIpc } from './ipc';
import { registerPasswordIpc } from './passwords';
import { updater } from './updater';
import { compareSemver, isSemver } from '../shared/updates';
import { ipcMain } from 'electron';
import { Tab } from './tab';
import { PAGE_EDITED } from '../shared/page-signals';
import { ProfileManager } from './profiles';
import { ProfileRegistry } from './profile-registry';
import { buildUserAgent } from '../shared/user-agent';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';

// ---------------------------------------------------------------- antes de que Electron esté listo
configureUserData();
configureMemorySaving();
configureTestMode();
registerInternalScheme();
app.enableSandbox(); // todos los procesos de renderizado en sandbox, sin excepciones
const userAgent = buildUserAgent(app.userAgentFallback, app.getVersion());
app.userAgentFallback = userAgent;

/**
 * Dirección pasada por línea de comandos: un enlace http(s) (Callisto como navegador predeterminado) o un archivo .htm o
 * .html que exista (abrirlo con Callisto desde el Explorador).
 */
function urlFromArgv(argv: string[]): string | undefined {
  for (const arg of argv.slice(1)) {
    if (/^https?:\/\//i.test(arg)) {
      try {
        return new URL(arg).href;
      } catch {
        /* ignorar */
      }
    }
    if (/^[a-zA-Z]:\\.+\.x?html?$/i.test(arg)) {
      try {
        if (existsSync(arg) && statSync(arg).isFile()) return pathToFileURL(arg).href;
      } catch {
        /* ignorar */
      }
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
    // Sin la barra de menú predeterminada de Electron ("File Edit View Window", en inglés): Callisto tiene su propio
    // menú (⋯) y atajos, como Chrome y Edge. Copiar, pegar, etc. siguen funcionando: los maneja Chromium.
    Menu.setApplicationMenu(null);
    // La carpeta Descargas real del usuario, antes de apuntar la de la app a la cuarentena privada. Con una carpeta de
    // datos aislada (pruebas automáticas), las descargas van dentro de ella: nunca a la carpeta Descargas real.
    const userDownloads = process.env.CALLISTO_USER_DATA_DIR ? join(app.getPath('userData'), 'Downloads') : app.getPath('downloads');
    prepareQuarantine();
    // Identidad de la app para las notificaciones de Windows (si un sitio tiene permiso para mostrarlas)
    app.setAppUserModelId('app.callisto.browser');

    // Sesión interna (en memoria) de la interfaz: sin permisos, con el protocolo callisto://
    const uiSession = session.fromPartition('callisto-ui');
    uiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    uiSession.setPermissionCheckHandler(() => false);
    serveInternalUi(uiSession, join(__dirname, '../renderer'));
    // Íconos de los botones de las extensiones (crx://) en la interfaz
    ElectronChromeExtensions.handleCRXProtocol(uiSession);

    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    const uiUrl = devUrl ? devUrl : `${UI_ORIGIN}/index.html`;
    const trustedOrigin = devUrl ? new URL(devUrl).origin : UI_ORIGIN;
    registerIpc((url) => url.startsWith(trustedOrigin + '/'));
    registerPasswordIpc((url) => url.startsWith(trustedOrigin + '/'));
    // Texto sin guardar en una pestaña (para no dormirla): de cualquier frame de una pestaña web
    ipcMain.on(PAGE_EDITED, (e) => {
      const tab = Tab.fromWebContents(e.sender);
      if (tab?.kind === 'web') tab.markEdited();
    });

    // Sesión de las páginas internas (historial, configuración): en memoria, sin permisos, separada de la web
    const internalSession = session.fromPartition('callisto-internal');
    internalSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    internalSession.setPermissionCheckHandler(() => false);
    serveInternalPages(internalSession, join(__dirname, '../renderer'), devUrl || undefined);

    // Perfiles: cada uno con su sesión de Chromium, su base y sus ventanas (ver profiles.ts)
    const registry = new ProfileRegistry(join(app.getPath('userData'), 'profiles.json'));
    const profiles = new ProfileManager(
      {
        userDataDir: app.getPath('userData'),
        userAgent,
        webContentPreload: join(__dirname, '../preload/web-content.js'),
        internal: { session: internalSession, preload: join(__dirname, '../preload/internal.js') },
        defaultDownloadDir: userDownloads,
        uiSession,
        uiUrl,
        uiPreload: join(__dirname, '../preload/ui.js'),
        extensionApiPreload: join(__dirname, '../preload/extension-apis.js'),
      },
      registry,
    );
    profiles.cleanupDeleted();
    registerProfilesIpc(profiles);

    app.on('before-quit', () => {
      BrowserWindowController.quitting = true; // salir no pregunta "¿Cerrar N pestañas?"
      profiles.finalSaveAll();
    });
    // La base de datos NO se cierra explícitamente: durante el cierre Chromium sigue emitiendo eventos (permisos que
    // consultan los service workers, títulos de páginas que terminan de cargar…), incluso después de 'exit', y una base
    // cerrada provocaba "database is not open". SQLite en modo WAL ya tiene a salvo todo lo confirmado; la base se
    // cierra sola al terminar el proceso y se pone al día al volver a abrirla.
    process.once('exit', () => {
      // Cuarentena privada de descargas: nada debe quedar ahí
      try {
        for (const f of readdirSync(quarantineDir())) rmSync(join(quarantineDir(), f), { recursive: true, force: true });
      } catch {
        /* se limpia también al arrancar */
      }
    });

    // Actualizaciones de Callisto (solo en el ejecutable empaquetado). Con una versión lista, las ventanas lo muestran.
    updater.on('status', () => BrowserWindowController.refreshAll());
    // Con el tema "Sistema", los botones de ventana siguen el modo claro u oscuro de Windows
    nativeTheme.on('updated', () => {
      for (const w of BrowserWindowController.all) w.applyTitleBar();
    });
    updater.start();

    // Al arrancar: los perfiles que estaban abiertos al salir (o el último usado). La URL recibida, en el último.
    const startUrl = urlFromArgv(process.argv);
    const toOpen = registry.lastActive.length ? [...registry.lastActive] : [registry.lastUsed];
    toOpen.forEach((id, i) => profiles.openProfile(id, i === toOpen.length - 1 && startUrl ? { url: startUrl } : {}));

    // ¿Callisto se actualizó desde la última vez? Se avisa una vez, en la ventana que queda al frente.
    const versionFile = join(app.getPath('userData'), 'last-version.txt');
    let previous = '';
    try {
      previous = readFileSync(versionFile, 'utf8').trim();
    } catch {
      /* primera vez */
    }
    if (isSemver(previous) && compareSemver(previous, app.getVersion()) < 0) {
      BrowserWindowController.current()?.active.showNotice('info', `Callisto se actualizó a la versión ${app.getVersion()}. Las novedades están en Configuración → Acerca de Callisto.`);
    }
    if (previous !== app.getVersion()) {
      try {
        writeFileSync(versionFile, app.getVersion());
      } catch {
        /* se reintenta la próxima vez */
      }
    }

    // Abrir Callisto otra vez: la URL recibida va a una pestaña nueva de la ventana actual (como Chrome);
    // sin URL, se enfoca la ventana.
    app.on('second-instance', (_e, argv) => {
      const url = urlFromArgv(argv);
      const current = BrowserWindowController.current();
      if (!current) {
        profiles.openProfile(registry.lastUsed, { url });
        return;
      }
      if (url) current.newTab({ url });
      current.focus();
    });
  });
}
