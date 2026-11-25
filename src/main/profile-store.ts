import type { DatabaseSync } from 'node:sqlite';
import type { SiteSettingKind } from '../shared/site-settings';

// Datos persistentes de un perfil además del historial: zoom por sitio, decisiones de permisos, favicons y
// configuración/estado (JSON). Sin Electron, para poder probarlos de forma aislada.

// ---------------------------------------------------------------- zoom por sitio

export class ZoomStore {
  constructor(private readonly db: DatabaseSync) {}

  get(host: string): number | undefined {
    const r = this.db.prepare('SELECT factor FROM zoom WHERE host = ?').get(host) as { factor: number } | undefined;
    return r?.factor;
  }

  /** Guarda el zoom del sitio; el 100 % no se guarda (es el valor por defecto). */
  set(host: string, factor: number): void {
    if (!host) return;
    if (Math.abs(factor - 1) < 0.001) this.db.prepare('DELETE FROM zoom WHERE host = ?').run(host);
    else this.db.prepare('INSERT INTO zoom (host, factor) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET factor = excluded.factor').run(host, factor);
  }

  all(): Array<{ host: string; factor: number }> {
    return this.db.prepare('SELECT host, factor FROM zoom ORDER BY host').all() as unknown as Array<{ host: string; factor: number }>;
  }

  remove(host: string): void {
    this.db.prepare('DELETE FROM zoom WHERE host = ?').run(host);
  }
}

// ---------------------------------------------------------------- permisos por sitio

export type SitePermission = 'camera' | 'microphone' | 'geolocation' | 'notifications';
export const SITE_PERMISSIONS: readonly SitePermission[] = ['camera', 'microphone', 'geolocation', 'notifications'];
export type PermissionSetting = 'allow' | 'block';

export interface PermissionRecord {
  origin: string;
  /** Un permiso que se pregunta o, desde la 1.5, un ajuste del sitio (sonido, ventanas emergentes, JavaScript, imágenes). */
  permission: SiteSettingKind;
  setting: PermissionSetting;
  updated: number;
}

export class PermissionStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  get(origin: string, permission: SiteSettingKind): PermissionSetting | undefined {
    const r = this.db.prepare('SELECT setting FROM permissions WHERE origin = ? AND permission = ?').get(origin, permission) as { setting: PermissionSetting } | undefined;
    return r?.setting;
  }

  set(origin: string, permission: SiteSettingKind, setting: PermissionSetting): void {
    this.db
      .prepare('INSERT INTO permissions (origin, permission, setting, updated) VALUES (?, ?, ?, ?) ON CONFLICT(origin, permission) DO UPDATE SET setting = excluded.setting, updated = excluded.updated')
      .run(origin, permission, setting, this.now());
  }

  remove(origin: string, permission: SiteSettingKind): void {
    this.db.prepare('DELETE FROM permissions WHERE origin = ? AND permission = ?').run(origin, permission);
  }

  list(): PermissionRecord[] {
    return this.db.prepare('SELECT origin, permission, setting, updated FROM permissions ORDER BY origin, permission').all() as unknown as PermissionRecord[];
  }
}

// ---------------------------------------------------------------- favicons (para mostrarlos sin volver a pedirlos)

const FAVICON_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export class FaviconStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  /** Favicon guardado y todavía vigente (30 días). */
  get(iconUrl: string): string | undefined {
    const r = this.db.prepare('SELECT data, fetched FROM favicons WHERE icon_url = ?').get(iconUrl) as { data: string; fetched: number } | undefined;
    return r && this.now() - r.fetched < FAVICON_MAX_AGE ? r.data : undefined;
  }

  put(iconUrl: string, data: string): void {
    this.db.prepare('INSERT INTO favicons (icon_url, data, fetched) VALUES (?, ?, ?) ON CONFLICT(icon_url) DO UPDATE SET data = excluded.data, fetched = excluded.fetched').run(iconUrl, data, this.now());
  }

  /** Borra los favicons que ya no usa ninguna dirección del historial ni la sesión guardada. */
  prune(keep: Set<string>): void {
    const rows = this.db.prepare('SELECT icon_url AS iconUrl FROM favicons WHERE icon_url NOT IN (SELECT icon_url FROM urls WHERE icon_url IS NOT NULL)').all() as Array<{ iconUrl: string }>;
    const del = this.db.prepare('DELETE FROM favicons WHERE icon_url = ?');
    for (const r of rows) if (!keep.has(r.iconUrl)) del.run(r.iconUrl);
  }
}

// ---------------------------------------------------------------- configuración y estado (JSON)

export class KeyValueStore {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}
