import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { safeStorage, session, type Session, type WebContents } from 'electron';
import { PasswordVault, type KeyWrapper } from './password-vault';
import type { ExtensionManager } from './extensions/manager';
import { FaviconLoader } from './favicon';
import { openDatabase, openMemoryDatabase } from './db';
import { HistoryStore } from './history-store';
import { FaviconStore, KeyValueStore, PermissionStore, ZoomStore, type SitePermission } from './profile-store';
import { ALWAYS_ALLOWED, sitePermissionForCheck, sitePermissionsFor, webOrigin } from './permissions';
import { DEFAULT_SETTINGS, sanitizeSettings, SEARCH_ENGINES, type Settings } from '../shared/settings';
import { DownloadStore } from './download-store';
import { DownloadManager } from './downloads';
import { BookmarkStore } from './bookmark-store';
import type { ProfileColor } from '../shared/profiles';
import { findTheme, type Theme } from '../shared/themes';

/** Clave de la bóveda de contraseñas protegida con DPAPI (la cuenta de Windows), vía safeStorage. */
const dpapiKeyWrapper: KeyWrapper = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  wrap: (secret) => safeStorage.encryptStringAsync(secret),
  unwrap: async (wrapped) => {
    const r = await safeStorage.decryptStringAsync(wrapped);
    return { secret: r.result, rewrap: r.shouldReEncrypt };
  },
};

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
  /** Carpeta de datos del perfil (base de datos). No se usa en los perfiles privados. */
  dataDir: string;
  name: string;
  color: ProfileColor;
  /**
   * Perfil privado (ventanas privadas): sesión de Chromium solo en memoria y base en memoria. Usa los favoritos y la
   * configuración del perfil de origen (como Chrome); no guarda historial, cookies ni datos de sitios.
   */
  private?: { parent: Profile; partition: string };
  internal: InternalPages;
  /** Carpeta Descargas de Windows (se usa si el usuario no eligió otra). */
  defaultDownloadDir: string;
}

type ProfileEvents = {
  'permission-request': [WebContents, PermissionRequest];
  'settings-changed': [Settings];
  /** Cambiaron los favoritos (para actualizar la barra y la estrella en todas las ventanas). */
  'bookmarks-changed': [];
};

/**
 * Un perfil = un contexto de navegación independiente: sesión de Chromium (cookies, almacenamiento, caché) más su base
 * de datos (historial, zoom por sitio, permisos, configuración, favoritos, sesión de pestañas). Cada ventana pertenece a
 * un perfil. Un perfil privado es la versión efímera de otro: todo en memoria.
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
  readonly bookmarks: BookmarkStore;
  /** Contraseñas. Una ventana privada usa (solo para autocompletar) las del perfil de origen y no guarda nuevas. */
  readonly passwords: PasswordVault;
  /** Hasta cuándo vale la última verificación de identidad (Windows Hello) para ver o editar contraseñas. */
  passwordsAuthorizedUntil = 0;
  /** Extensiones del perfil (las crea ProfileManager); null en los perfiles privados. */
  extensions: ExtensionManager | null = null;
  readonly defaultDownloadDir: string;
  /** Los perfiles privados no guardan historial. */
  readonly recordsHistory: boolean;
  readonly isPrivate: boolean;
  /** Perfil de origen de un perfil privado. */
  readonly parent: Profile | null;
  name: string;
  color: ProfileColor;
  /** Si la base estaba dañada: dónde quedó la copia apartada. */
  readonly recoveredDatabase?: string;
  private settingsValue: Settings;

  constructor(readonly id: string, opts: ProfileOptions) {
    super();
    const priv = opts.private;
    this.isPrivate = !!priv;
    this.parent = priv?.parent ?? null;
    this.recordsHistory = !priv;
    this.name = opts.name;
    this.color = opts.color;
    if (priv) {
      this.db = openMemoryDatabase();
    } else {
      const opened = openDatabase(join(opts.dataDir, 'callisto.db'));
      this.db = opened.db;
      this.recoveredDatabase = opened.recoveredFrom;
    }
    this.history = new HistoryStore(this.db);
    this.zoom = new ZoomStore(this.db);
    this.permissions = new PermissionStore(this.db);
    this.kv = new KeyValueStore(this.db);
    // Los favoritos de una ventana privada son los del perfil de origen (como en Chrome)
    this.bookmarks = priv ? priv.parent.bookmarks : new BookmarkStore(this.db);
    this.passwords = priv ? priv.parent.passwords : new PasswordVault(this.db, dpapiKeyWrapper);
    this.settingsValue = sanitizeSettings(this.kv.get('settings') ?? DEFAULT_SETTINGS);
    this.internal = opts.internal;

    // Privado: partición sin "persist:" = cookies, almacenamiento y caché solo en memoria
    const ses = session.fromPartition(priv ? priv.partition : `persist:profile-${id}`);
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
    if (this.parent) return this.parent.downloadDir;
    return this.settingsValue.downloadDir ?? this.defaultDownloadDir;
  }

  /** La configuración de un perfil privado es la de su perfil de origen. */
  get settings(): Settings {
    return this.parent ? this.parent.settings : this.settingsValue;
  }

  /** Tema elegido (el de una ventana privada es el de su perfil de origen). */
  get theme(): Theme {
    const s = this.settings;
    return findTheme(s.theme, s.customThemes);
  }

  get searchTemplate(): string {
    return SEARCH_ENGINES[this.settings.searchEngine].template;
  }

  get searchEngineName(): string {
    return SEARCH_ENGINES[this.settings.searchEngine].name;
  }

  updateSettings(partial: unknown): Settings {
    if (this.parent) return this.parent.updateSettings(partial);
    const merged = sanitizeSettings({ ...this.settingsValue, ...(partial && typeof partial === 'object' ? partial : {}) });
    this.settingsValue = merged;
    this.kv.set('settings', merged);
    this.emit('settings-changed', merged);
    return merged;
  }

  /**
   * Descarta un perfil privado al cerrar su última ventana: borra cookies, almacenamiento, caché y credenciales de su
   * sesión. (La sesión en memoria no se reutiliza: la próxima ventana privada usa una nueva.)
   */
  async discard(): Promise<void> {
    if (!this.isPrivate) return;
    this.removeAllListeners();
    await Promise.allSettled([this.session.clearStorageData(), this.session.clearCache(), this.session.clearAuthCache()]);
  }
}
