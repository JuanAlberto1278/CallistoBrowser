import { EventEmitter } from 'node:events';
import { session, type Session, type WebContents } from 'electron';

/**
 * Permisos que se conceden sin preguntar. Todo lo demás (cámara, micrófono, ubicación, notificaciones, etc.)
 * se DENIEGA: Electron, por defecto, los concede todos. Los avisos para que el usuario decida llegan en una versión futura.
 */
const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

export interface BlockedDownload {
  filename: string;
  url: string;
}

export interface ProfileOptions {
  userAgent: string;
  /** Preload que se inyecta en todas las páginas web (corrección WebAuthn). */
  webContentPreload: string;
}

/**
 * Un perfil = un contexto de navegación independiente (cookies, almacenamiento, caché, permisos).
 * V0.2 usa un único perfil "default"; V0.7 agrega la gestión de varios.
 */
export class Profile extends EventEmitter<{ 'download-blocked': [BlockedDownload, WebContents] }> {
  readonly session: Session;

  constructor(readonly id: string, opts: ProfileOptions) {
    super();
    const ses = session.fromPartition(`persist:profile-${id}`);
    this.session = ses;

    ses.setUserAgent(opts.userAgent);
    ses.registerPreloadScript({ id: 'callisto-web-content', type: 'frame', filePath: opts.webContentPreload });

    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALWAYS_ALLOWED.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALWAYS_ALLOWED.has(permission));
    ses.setDevicePermissionHandler(() => false);

    // V0.2: todavía no hay gestor de descargas. Ninguna descarga se guarda: se cancela de inmediato
    // (misma primera acción que el diseño de V0.5) y se avisa al usuario.
    ses.on('will-download', (event, item, wc) => {
      const info: BlockedDownload = { filename: item.getFilename(), url: item.getURL() };
      event.preventDefault();
      this.emit('download-blocked', info, wc);
    });
  }
}
