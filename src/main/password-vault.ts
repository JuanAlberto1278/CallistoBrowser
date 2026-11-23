import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, isLoginOrigin, type LoginSummary, type VaultStatus } from '../shared/passwords';

// Bóveda de contraseñas de un perfil (V0.9). Sin Electron, para poder probarla de forma aislada: la protección de la
// clave con DPAPI llega como un `KeyWrapper` (safeStorage en la app; uno falso en las pruebas).
//
// - Una clave de datos aleatoria de 256 bits por perfil, guardada SOLO envuelta (cifrada) por el `KeyWrapper`.
// - Cada contraseña: AES-256-GCM con IV aleatorio de 12 bytes. Datos asociados (AAD): sitio y usuario, así una
//   contraseña cifrada no se puede mover a otra fila sin que el descifrado falle.
// - Formato del campo `password`: [versión 1][IV 12][etiqueta GCM 16][texto cifrado].
// - La clave descifrada vive solo en la memoria del proceso principal; las contraseñas se descifran de a una, cuando se
//   necesitan (autocompletar, o ver/copiar/editar después de verificar la identidad).

export interface KeyWrapper {
  available(): Promise<boolean>;
  wrap(secret: string): Promise<Buffer>;
  /** `rewrap`: la clave del sistema cambió y conviene volver a envolver. */
  unwrap(wrapped: Buffer): Promise<{ secret: string; rewrap: boolean }>;
}

export class VaultError extends Error {}

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function aad(origin: string, username: string): Buffer {
  return Buffer.from(`callisto-login\0${origin}\0${username}`, 'utf8');
}

export function encryptPassword(key: Buffer, origin: string, username: string, password: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad(origin, username));
  const body = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** Descifra; falla (excepción) si el dato fue alterado, es de otra fila o se cifró con otra clave. */
export function decryptPassword(key: Buffer, origin: string, username: string, blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LENGTH + TAG_LENGTH || buf[0] !== FORMAT_VERSION) throw new VaultError('Formato de contraseña desconocido.');
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(aad(origin, username));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(1 + IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString('utf8');
}

/** Resultado de comparar lo que el usuario envió con lo guardado. */
export type SaveCheck = { kind: 'new' } | { kind: 'same'; id: number } | { kind: 'update'; id: number };

interface LoginRow {
  id: number;
  origin: string;
  username: string;
  password: Uint8Array;
  created: number;
  updated: number;
  last_used: number | null;
  times_used: number;
}

const summary = (r: Omit<LoginRow, 'password'>): LoginSummary => ({
  id: r.id,
  origin: r.origin,
  username: r.username,
  created: r.created,
  updated: r.updated,
  lastUsed: r.last_used,
  timesUsed: r.times_used,
});

const SUMMARY_COLUMNS = 'id, origin, username, created, updated, last_used, times_used';

function checkValues(origin: string, username: string, password?: string): void {
  if (!isLoginOrigin(origin)) throw new VaultError('Sitio no válido.');
  if (username.length > MAX_USERNAME_LENGTH) throw new VaultError('El usuario es demasiado largo.');
  if (password !== undefined && (password.length === 0 || password.length > MAX_PASSWORD_LENGTH)) throw new VaultError('La contraseña no puede estar vacía.');
}

export class PasswordVault {
  private key: Buffer | null = null;
  private opening: Promise<VaultStatus> | null = null;
  private statusValue: VaultStatus | null = null;

  constructor(private readonly db: DatabaseSync, private readonly wrapper: KeyWrapper, private readonly now: () => number = Date.now) {}

  /** Estado conocido sin esperar (null = todavía no se abrió). */
  get status(): VaultStatus | null {
    return this.statusValue;
  }

  /**
   * Abre la bóveda (una sola vez): crea la clave del perfil si no hay, o la desenvuelve. Si no se puede desenvolver
   * (p. ej. la carpeta del perfil se copió a otra cuenta de Windows), las contraseñas guardadas quedan ilegibles y no
   * se guardan nuevas, para no mezclar claves; sin contraseñas guardadas, simplemente se crea una clave nueva.
   */
  open(): Promise<VaultStatus> {
    this.opening ??= this.doOpen().then((s) => (this.statusValue = s));
    return this.opening;
  }

  private async doOpen(): Promise<VaultStatus> {
    try {
      if (!(await this.wrapper.available())) return 'unavailable';
    } catch {
      return 'unavailable';
    }
    const row = this.db.prepare('SELECT wrapped FROM password_key WHERE id = 1').get() as { wrapped: Uint8Array } | undefined;
    if (row) {
      try {
        const { secret, rewrap } = await this.wrapper.unwrap(Buffer.from(row.wrapped));
        const key = Buffer.from(secret, 'base64');
        if (key.length !== KEY_LENGTH) throw new Error('clave de longitud inválida');
        this.key = key;
        if (rewrap) {
          const wrapped = await this.wrapper.wrap(secret);
          this.db.prepare('UPDATE password_key SET wrapped = ? WHERE id = 1').run(wrapped);
        }
        return 'ready';
      } catch {
        if (this.count() > 0) return 'unreadable';
      }
    }
    try {
      const key = randomBytes(KEY_LENGTH);
      const wrapped = await this.wrapper.wrap(key.toString('base64'));
      this.db.prepare('INSERT INTO password_key (id, wrapped, created) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET wrapped = excluded.wrapped, created = excluded.created').run(wrapped, this.now());
      this.key = key;
      return 'ready';
    } catch {
      return 'unavailable';
    }
  }

  private async requireKey(): Promise<Buffer> {
    const status = await this.open();
    if (status !== 'ready' || !this.key) throw new VaultError(status === 'unreadable' ? 'Las contraseñas guardadas no se pueden descifrar con esta cuenta de Windows.' : 'El cifrado de Windows no está disponible.');
    return this.key;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM logins').get() as { n: number }).n;
  }

  /** Todas (o las que coinciden con la búsqueda en sitio o usuario), sin contraseñas. */
  list(query = ''): LoginSummary[] {
    const q = query.trim().toLowerCase();
    const rows = q
      ? this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins WHERE instr(lower(origin), ?) > 0 OR instr(lower(username), ?) > 0 ORDER BY origin, username`).all(q, q)
      : this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins ORDER BY origin, username`).all();
    return (rows as unknown as LoginRow[]).map(summary);
  }

  /** Las del sitio exacto (esquema, dominio y puerto), las usadas más recientemente primero. */
  forOrigin(origin: string): LoginSummary[] {
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins WHERE origin = ? ORDER BY COALESCE(last_used, updated) DESC, username`).all(origin);
    return (rows as unknown as LoginRow[]).map(summary);
  }

  get(id: number): LoginSummary | undefined {
    const r = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM logins WHERE id = ?`).get(id) as LoginRow | undefined;
    return r ? summary(r) : undefined;
  }

  /** Descifra una contraseña. */
  async password(id: number): Promise<string> {
    const key = await this.requireKey();
    const r = this.db.prepare('SELECT origin, username, password FROM logins WHERE id = ?').get(id) as Pick<LoginRow, 'origin' | 'username' | 'password'> | undefined;
    if (!r) throw new VaultError('La contraseña ya no existe.');
    try {
      return decryptPassword(key, r.origin, r.username, r.password);
    } catch {
      throw new VaultError('Esta contraseña está dañada y no se puede descifrar.');
    }
  }

  /** ¿Lo enviado ya está guardado igual, cambió la contraseña de un usuario conocido, o es nuevo? */
  async check(origin: string, username: string, password: string): Promise<SaveCheck> {
    const r = this.db.prepare('SELECT id FROM logins WHERE origin = ? AND username = ?').get(origin, username) as { id: number } | undefined;
    if (!r) return { kind: 'new' };
    try {
      return (await this.password(r.id)) === password ? { kind: 'same', id: r.id } : { kind: 'update', id: r.id };
    } catch {
      return { kind: 'update', id: r.id };
    }
  }

  /** Guarda (o reemplaza la contraseña del mismo usuario en el mismo sitio). Devuelve el id. */
  async save(origin: string, username: string, password: string): Promise<number> {
    checkValues(origin, username, password);
    const key = await this.requireKey();
    const blob = encryptPassword(key, origin, username, password);
    const now = this.now();
    this.db
      .prepare('INSERT INTO logins (origin, username, password, created, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(origin, username) DO UPDATE SET password = excluded.password, updated = excluded.updated')
      .run(origin, username, blob, now, now);
    return (this.db.prepare('SELECT id FROM logins WHERE origin = ? AND username = ?').get(origin, username) as { id: number }).id;
  }

  /** Cambia el usuario y/o la contraseña (se vuelve a cifrar: el usuario es parte de los datos asociados). */
  async update(id: number, patch: { username?: string; password?: string }): Promise<void> {
    const current = this.get(id);
    if (!current) throw new VaultError('La contraseña ya no existe.');
    const username = patch.username ?? current.username;
    const password = patch.password ?? (await this.password(id));
    checkValues(current.origin, username, password);
    if (username !== current.username) {
      const clash = this.db.prepare('SELECT id FROM logins WHERE origin = ? AND username = ? AND id <> ?').get(current.origin, username, id);
      if (clash) throw new VaultError('Ya hay una contraseña guardada con ese usuario para este sitio.');
    }
    const key = await this.requireKey();
    this.db.prepare('UPDATE logins SET username = ?, password = ?, updated = ? WHERE id = ?').run(username, encryptPassword(key, current.origin, username, password), this.now(), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM logins WHERE id = ?').run(id);
  }

  markUsed(id: number): void {
    this.db.prepare('UPDATE logins SET last_used = ?, times_used = times_used + 1 WHERE id = ?').run(this.now(), id);
  }

  // ------------------------------------------------------------ "Nunca guardar" en un sitio

  isBlocked(origin: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM password_blocklist WHERE origin = ?').get(origin);
  }

  block(origin: string): void {
    if (!isLoginOrigin(origin)) return;
    this.db.prepare('INSERT INTO password_blocklist (origin, created) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING').run(origin, this.now());
  }

  unblock(origin: string): void {
    this.db.prepare('DELETE FROM password_blocklist WHERE origin = ?').run(origin);
  }

  blocked(): string[] {
    return (this.db.prepare('SELECT origin FROM password_blocklist ORDER BY origin').all() as Array<{ origin: string }>).map((r) => r.origin);
  }
}
