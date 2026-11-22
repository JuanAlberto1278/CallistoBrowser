import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { session, type Session, type WebContents } from 'electron';
import { FaviconLoader } from './favicon';
import { openDatabase } from './db';
import { HistoryStore } from './history-store';
import { FaviconStore, KeyValueStore, PermissionStore, ZoomStore, type SitePermission } from './profile-store';
import { ALWAYS_ALLOWED, sitePermissionForCheck, sitePermissionsFor, webOrigin } from './permissions';
import { DEFAULT_SETTINGS, sanitizeSettings, SEARCH_ENGINES, type Settings } from '../shared/settings';
import { DownloadStore } from './download-store';
import { DownloadManager } from './downloads';

/** Pedido de permiso que necesita la decisión del usuario. */
export interface PermissionRequest {
  origin: string;
  permissions: SitePermission[];
  /** `remember`: guardar la decisión para este sitio. */
  respond(allow: boolean, remember: boolean): void;
}

/** Pestañas internas (historial, configuración): sesión propia, separada de la web, con su preload. */
export interface InternalPages {
  session: Session;
  preload: string;
}

export interface ProfileOptions {
  userAgent: string;
  /** Preload que se inyecta en todas las páginas web (corrección WebAuthn). */
  webContentPreload: string;
  /** Carpeta de datos del perfil (base de datos). */
  dataDir: string;
  internal: InternalPages;
  /** Carpeta Descargas de Windows (se usa si el usuario no eligió otra). */
  defaultDownloadDir: string;
}

type ProfileEvents = {
  'permission-request': [WebContents, PermissionRequest];
  'settings-changed': [Settings];
};

/**
 * Un perfil = un contexto de navegación independiente: sesión de Chromium (cookies, almacenamiento, caché) más su base
 * de datos (historial, zoom por sitio, permisos, configuración, sesión de pestañas). Por ahora hay un único perfil
 * "default"; V0.7 agrega la gestión de varios.
 */
export class Profile extends EventEmitter<ProfileEvents> {
  readonly session: Session;
  readonly db: DatabaseSync;
  readonly history: HistoryStore;
  readonly zoom: ZoomStore;
  readonly permissions: PermissionStore;
  readonly kv: KeyValueStore;
  readonly favicons: FaviconLoader;
  readonly internal: InternalPages;
  readonly downloads: DownloadManager;
  readonly defaultDownloadDir: string;
  /** Los perfiles privados (V0.7) no guardan historial. */
  readonly recordsHistory = true;
  /** Si la base estaba dañada: dónde quedó la copia apartada. */
  readonly recoveredDatabase?: string;
  private settingsValue: Settings;

  constructor(readonly id: string, opts: ProfileOptions) {
    super();
    const opened = openDatabase(join(opts.dataDir, 'callisto.db'));
    this.db = opened.db;
    this.recoveredDatabase = opened.recoveredFrom;
    this.history = new HistoryStore(this.db);
    this.zoom = new ZoomStore(this.db);
    this.permissions = new PermissionStore(this.db);
    this.kv = new KeyValueStore(this.db);
    this.settingsValue = sanitizeSettings(this.kv.get('settings') ?? DEFAULT_SETTINGS);
    this.internal = opts.internal;

    const ses = session.fromPartition(`persist:profile-${id}`);
    this.session = ses;
    this.favicons = new FaviconLoader(ses, new FaviconStore(this.db));

    ses.setUserAgent(opts.userAgent);
    ses.registerPreloadScript({ id: 'callisto-web-content', type: 'frame', filePath: opts.webContentPreload });

    // Permisos: los inofensivos se conceden; cámara, micrófono, ubicación y notificaciones se le preguntan al usuario
    // (o se aplica lo que decidió antes para ese sitio); todo lo demás se deniega.
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return callback(true);
      const kinds = sitePermissionsFor(permission, 'mediaTypes' in details ? details.mediaTypes : undefined);
      const origin = webOrigin(details.requestingUrl ?? wc.getURL());
      if (!kinds || !origin) return callback(false);
      let saved: Array<'allow' | 'block' | undefined>;
      try {
        saved = kinds.map((k) => this.permissions.get(origin, k));
      } catch {
        return callback(false); // sin acceso a lo guardado, nunca se concede
      }
      if (saved.includes('block')) return callback(false);
      if (saved.every((s) => s === 'allow')) return callback(true);
      let answered = false;
      this.emit('permission-request', wc, {
        origin,
        permissions: kinds,
        respond: (allow, remember) => {
          if (answered) return;
          answered = true;
          if (remember) for (const k of kinds) this.permissions.set(origin, k, allow ? 'allow' : 'block');
          callback(allow);
        },
      });
      // Si nadie atiende el pedido (no es una pestaña de Callisto), se deniega.
      if (this.listenerCount('permission-request') === 0) callback(false);
    });
    // Chromium consulta esto en cualquier momento, incluso durante el cierre (p. ej. desde los service workers de un
    // sitio, que siguen vivos unos instantes después de cerrar las ventanas). Ante cualquier duda: denegado.
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (ALWAYS_ALLOWED.has(permission)) return true;
      const kind = sitePermissionForCheck(permission, 'mediaType' in details ? details.mediaType : undefined);
      const origin = webOrigin(requestingOrigin);
      try {
        return !!kind && !!origin && this.permissions.get(origin, kind) === 'allow';
      } catch {
        return false;
      }
    });
    ses.setDevicePermissionHandler(() => false);

    // Descargas: nada se guarda sin la autorización del usuario (ver downloads.ts)
    this.defaultDownloadDir = opts.defaultDownloadDir;
    this.downloads = new DownloadManager(ses, new DownloadStore(this.db), () => this.downloadDir);
  }

  /** Carpeta donde se guardan las descargas. */
  get downloadDir(): string {
    return this.settingsValue.downloadDir ?? this.defaultDownloadDir;
  }

  get settings(): Settings {
    return this.settingsValue;
  }

  get searchTemplate(): string {
    return SEARCH_ENGINES[this.settingsValue.searchEngine].template;
  }

  get searchEngineName(): string {
    return SEARCH_ENGINES[this.settingsValue.searchEngine].name;
  }

  updateSettings(partial: unknown): Settings {
    const merged = sanitizeSettings({ ...this.settingsValue, ...(partial && typeof partial === 'object' ? partial : {}) });
    this.settingsValue = merged;
    this.kv.set('settings', merged);
    this.emit('settings-changed', merged);
    return merged;
  }

}
