import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseAndVerifyCrx } from './crx';
import { extractZip } from './unzip';
import type { ExtensionManifest } from '../../shared/extensions';

// Instalación de extensiones de la Chrome Web Store (V0.10): descarga del CRX, verificación de firmas (crx.ts),
// extracción segura (unzip.ts) y registro. Sin Electron: la descarga llega como función (net.fetch en la app).

export class InstallError extends Error {}

/** Tamaño máximo de un CRX descargado. */
const MAX_CRX_BYTES = 200 * 1024 * 1024;

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; json(): Promise<unknown>; headers: { get(name: string): string | null } }>;

const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

/** Dirección del CRX más reciente de una extensión (la misma que usa Chrome). */
export function crxUrl(id: string, chromeVersion: string): string {
  const u = new URL(UPDATE_URL);
  u.searchParams.append('response', 'redirect');
  u.searchParams.append('acceptformat', 'crx3');
  u.searchParams.append('prodversion', chromeVersion);
  u.searchParams.append('x', new URLSearchParams({ id, installsource: 'ondemand', uc: '' }).toString());
  return u.toString();
}

/** Consulta de actualización: la versión disponible si es más nueva que `version`, o null. */
export function updateCheckUrl(id: string, version: string, chromeVersion: string): string {
  const u = new URL(UPDATE_URL);
  u.searchParams.append('response', 'updatecheck');
  u.searchParams.append('acceptformat', 'crx3');
  u.searchParams.append('prodversion', chromeVersion);
  u.searchParams.append('x', new URLSearchParams({ id, v: version, uc: '' }).toString());
  return u.toString();
}

/** Lee la respuesta (XML "gupdate") de la consulta de actualización. */
export function parseUpdateCheck(xml: string, id: string): string | null {
  const app = new RegExp(`<app[^>]*appid=["']${id}["'][^>]*>([\\s\\S]*?)</app>`).exec(xml);
  const check = app && /<updatecheck\b([^>]*)\/?>/.exec(app[1]!);
  if (!check) return null;
  const attr = (name: string) => new RegExp(`\\b${name}=["']([^"']*)["']`).exec(check[1]!)?.[1];
  if (attr('status') !== 'ok') return null;
  const version = attr('version');
  return version && isVersion(version) ? version : null;
}

export const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d{1,9}(\.\d{1,9}){0,3}$/.test(v);

/** -1, 0 o 1 (versiones de extensiones: hasta cuatro números). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function downloadCrx(fetcher: Fetcher, id: string, chromeVersion: string): Promise<Buffer> {
  const res = await fetcher(crxUrl(id, chromeVersion));
  if (!res.ok) throw new InstallError(`La Chrome Web Store respondió ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_CRX_BYTES) throw new InstallError('La extensión es demasiado grande.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_CRX_BYTES) throw new InstallError('La extensión es demasiado grande.');
  return buf;
}

export interface Unpacked {
  version: string;
  /** Carpeta dentro de <Extensions>/<id>/. */
  dir: string;
  manifest: ExtensionManifest;
}

/**
 * Verifica el CRX y lo extrae en <extensionsDir>/<id>/<versión>_<al azar>. Escribe en el manifiesto la clave del
 * desarrollador (así el ID no depende de la carpeta, como en Chrome). Si algo falla, no queda nada.
 */
export function unpackCrx(buf: Buffer, id: string, extensionsDir: string, publisherKeyHash?: string): Unpacked {
  const crx = publisherKeyHash ? parseAndVerifyCrx(buf, id, publisherKeyHash) : parseAndVerifyCrx(buf, id);
  const tmpName = `.instalando-${randomUUID()}`;
  const tmp = join(extensionsDir, id, tmpName);
  try {
    extractZip(crx.zip, tmp);
    const manifestPath = join(tmp, 'manifest.json');
    if (!existsSync(manifestPath)) throw new InstallError('La extensión no tiene manifiesto.');
    let manifest: ExtensionManifest & { key?: string };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    } catch {
      throw new InstallError('El manifiesto de la extensión no es válido.');
    }
    if (manifest.manifest_version !== 3) throw new InstallError('Solo se pueden instalar extensiones Manifest V3 (como en Chrome).');
    if (!isVersion(manifest.version)) throw new InstallError('La extensión no declara una versión válida.');
    manifest.key = crx.publicKey;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const dir = `${manifest.version}_${randomUUID().slice(0, 8)}`;
    renameSync(tmp, join(extensionsDir, id, dir));
    return { version: manifest.version, dir, manifest };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- registro (tabla extensions)

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  dir: string;
  enabled: boolean;
  installed: number;
  updated: number;
}

export class ExtensionRegistry {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  all(): ExtensionRecord[] {
    const rows = this.db.prepare('SELECT id, name, version, dir, enabled, installed, updated FROM extensions ORDER BY name COLLATE NOCASE').all() as Array<Omit<ExtensionRecord, 'enabled'> & { enabled: number }>;
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
  }

  get(id: string): ExtensionRecord | undefined {
    return this.all().find((r) => r.id === id);
  }

  /** Instalada o actualizada (queda activada). Devuelve la carpeta anterior, si había. */
  put(id: string, name: string, version: string, dir: string): string | null {
    const prev = this.get(id);
    const now = this.now();
    this.db
      .prepare('INSERT INTO extensions (id, name, version, dir, enabled, installed, updated) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, dir = excluded.dir, enabled = 1, updated = excluded.updated')
      .run(id, name, version, dir, now, now);
    return prev && prev.dir !== dir ? prev.dir : null;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE extensions SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM extensions WHERE id = ?').run(id);
  }
}
