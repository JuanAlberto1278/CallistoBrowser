import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isProfileColor, isProfileId, sanitizeProfileName, type ProfileColor, type ProfileInfo } from '../shared/profiles';

// Lista de perfiles (fuera de las bases de cada perfil: se necesita antes de abrir ninguno).

export interface RegistryData {
  version: 1;
  profiles: ProfileInfo[];
  /** Último perfil usado (el que se abre si no hay nada que restaurar). */
  lastUsed: string;
  /** Perfiles con ventanas abiertas al salir: se vuelven a abrir al arrancar. */
  lastActive: string[];
  /** Perfiles eliminados cuyos archivos se borran en el próximo arranque (mientras corren, Chromium los tiene abiertos). */
  pendingDelete: string[];
}

export const DEFAULT_PROFILE: ProfileInfo = { id: 'default', name: 'Personal', color: 'blue', created: 0 };

export class RegistryError extends Error {}

function clean(raw: unknown): RegistryData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const profiles: ProfileInfo[] = [];
  for (const p of Array.isArray(r.profiles) ? r.profiles : []) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (!isProfileId(o.id) || seen.has(o.id)) continue;
    seen.add(o.id);
    profiles.push({ id: o.id, name: sanitizeProfileName(o.name), color: isProfileColor(o.color) ? o.color : 'blue', created: typeof o.created === 'number' ? o.created : 0 });
  }
  if (profiles.length === 0) profiles.push({ ...DEFAULT_PROFILE });
  const ids = new Set(profiles.map((p) => p.id));
  const lastUsed = typeof r.lastUsed === 'string' && ids.has(r.lastUsed) ? r.lastUsed : profiles[0]!.id;
  const lastActive = (Array.isArray(r.lastActive) ? r.lastActive : []).filter((id): id is string => typeof id === 'string' && ids.has(id));
  const pendingDelete = (Array.isArray(r.pendingDelete) ? r.pendingDelete : []).filter((id): id is string => isProfileId(id) && !ids.has(id));
  return { version: 1, profiles, lastUsed, lastActive: [...new Set(lastActive)], pendingDelete: [...new Set(pendingDelete)] };
}

export class ProfileRegistry {
  private data: RegistryData;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    let raw: unknown = null;
    try {
      if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = null; // archivo dañado: se empieza con el perfil predeterminado (los datos de los perfiles siguen en disco)
    }
    this.data = clean(raw);
  }

  get profiles(): readonly ProfileInfo[] {
    return this.data.profiles;
  }

  get lastUsed(): string {
    return this.data.lastUsed;
  }

  get lastActive(): readonly string[] {
    return this.data.lastActive;
  }

  get pendingDelete(): readonly string[] {
    return this.data.pendingDelete;
  }

  get(id: string): ProfileInfo | undefined {
    return this.data.profiles.find((p) => p.id === id);
  }

  create(name: unknown, color: unknown): ProfileInfo {
    let id: string;
    do id = `p-${randomBytes(4).toString('hex')}`;
    while (this.get(id));
    const used = new Set(this.data.profiles.map((p) => p.color));
    const fallbackColor: ProfileColor = (['green', 'purple', 'orange', 'pink', 'teal', 'red', 'gray', 'blue'] as ProfileColor[]).find((c) => !used.has(c)) ?? 'gray';
    const info: ProfileInfo = { id, name: sanitizeProfileName(name, `Perfil ${this.data.profiles.length + 1}`), color: isProfileColor(color) ? color : fallbackColor, created: this.now() };
    this.data.profiles.push(info);
    this.save();
    return info;
  }

  update(id: string, patch: { name?: unknown; color?: unknown }): ProfileInfo {
    const p = this.get(id);
    if (!p) throw new RegistryError('El perfil no existe.');
    if (patch.name !== undefined) p.name = sanitizeProfileName(patch.name, p.name);
    if (patch.color !== undefined && isProfileColor(patch.color)) p.color = patch.color;
    this.save();
    return p;
  }

  /** Quita el perfil de la lista; sus archivos se borran en el próximo arranque. No se puede quitar el último. */
  remove(id: string): void {
    if (!this.get(id)) throw new RegistryError('El perfil no existe.');
    if (this.data.profiles.length <= 1) throw new RegistryError('Tiene que quedar al menos un perfil.');
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    this.data.pendingDelete = [...new Set([...this.data.pendingDelete, id])];
    this.data.lastActive = this.data.lastActive.filter((x) => x !== id);
    if (this.data.lastUsed === id) this.data.lastUsed = this.data.profiles[0]!.id;
    this.save();
  }

  setLastUsed(id: string): void {
    if (!this.get(id) || this.data.lastUsed === id) return;
    this.data.lastUsed = id;
    this.save();
  }

  setLastActive(ids: string[]): void {
    const next = [...new Set(ids.filter((id) => this.get(id)))];
    if (next.join() === this.data.lastActive.join()) return;
    this.data.lastActive = next;
    this.save();
  }

  /** Perfiles cuyos archivos ya se borraron. */
  deleted(ids: string[]): void {
    this.data.pendingDelete = this.data.pendingDelete.filter((id) => !ids.includes(id));
    this.save();
  }

  /** Escritura atómica: un corte de luz a mitad nunca deja el archivo a medias. */
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
