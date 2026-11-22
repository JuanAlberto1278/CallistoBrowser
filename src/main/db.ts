import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// Base de datos SQLite de cada perfil (node:sqlite, sin módulos nativos). Las migraciones son versionadas con
// PRAGMA user_version: cada una corre una sola vez, dentro de una transacción.

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visit_count INTEGER NOT NULL DEFAULT 0,
        typed_count INTEGER NOT NULL DEFAULT 0,
        last_visit INTEGER NOT NULL DEFAULT 0,
        icon_url TEXT
      );
      CREATE INDEX urls_host ON urls(host);
      CREATE INDEX urls_last_visit ON urls(last_visit);

      CREATE TABLE visits (
        id INTEGER PRIMARY KEY,
        url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
        time INTEGER NOT NULL,
        typed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX visits_time ON visits(time);
      CREATE INDEX visits_url ON visits(url_id);

      -- Búsqueda por fragmentos de texto (trigramas) en título y dirección
      CREATE VIRTUAL TABLE urls_fts USING fts5(title, url, content='urls', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER urls_ai AFTER INSERT ON urls BEGIN
        INSERT INTO urls_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
      END;
      CREATE TRIGGER urls_ad AFTER DELETE ON urls BEGIN
        INSERT INTO urls_fts(urls_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
      END;
      CREATE TRIGGER urls_au AFTER UPDATE OF title, url ON urls BEGIN
        INSERT INTO urls_fts(urls_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
        INSERT INTO urls_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
      END;

      CREATE TABLE favicons (
        icon_url TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        fetched INTEGER NOT NULL
      );

      CREATE TABLE zoom (
        host TEXT PRIMARY KEY,
        factor REAL NOT NULL
      );

      CREATE TABLE permissions (
        origin TEXT NOT NULL,
        permission TEXT NOT NULL,
        setting TEXT NOT NULL CHECK (setting IN ('allow', 'block')),
        updated INTEGER NOT NULL,
        PRIMARY KEY (origin, permission)
      );

      -- Configuración y estado (sesión de ventanas y pestañas) como JSON
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export interface OpenResult {
  db: DatabaseSync;
  /** La base anterior estaba dañada: se apartó (renombrada) y se empezó una nueva. */
  recoveredFrom?: string;
}

/**
 * Abre (o crea) la base del perfil. Si está dañada y no se puede abrir, se aparta con otro nombre, sin borrarla, y se
 * empieza una nueva: es preferible un historial vacío a un navegador que no arranca.
 */
export function openDatabase(file: string): OpenResult {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return { db: open(file) };
  } catch (e) {
    if (!existsSync(file)) throw e;
    const aside = `${file}.danada-${Date.now()}`;
    renameSync(file, aside);
    for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    return { db: open(file), recoveredFrom: aside };
  }
}

function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') throw new Error(`base de datos dañada: ${check.quick_check}`);
    migrate(db);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
