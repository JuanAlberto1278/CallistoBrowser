import type { DatabaseSync } from 'node:sqlite';
import type { DownloadState } from '../shared/downloads';

// Lista persistente de descargas de un perfil (sin Electron, para probarla de forma aislada).

export interface DownloadRecord {
  id: number;
  url: string;
  pageUrl: string;
  filename: string;
  path: string;
  mime: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  error: string | null;
  startTime: number;
  endTime: number | null;
}

const COLS = `id, url, page_url AS pageUrl, filename, path, mime, total_bytes AS totalBytes, received_bytes AS receivedBytes,
  state, error, start_time AS startTime, end_time AS endTime`;

export class DownloadStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  insert(r: Omit<DownloadRecord, 'id' | 'startTime' | 'endTime'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO downloads (url, page_url, filename, path, mime, total_bytes, received_bytes, state, error, start_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.url, r.pageUrl, r.filename, r.path, r.mime, r.totalBytes, r.receivedBytes, r.state, r.error, this.now());
    return Number(res.lastInsertRowid);
  }

  update(id: number, patch: Partial<Pick<DownloadRecord, 'path' | 'filename' | 'totalBytes' | 'receivedBytes' | 'state' | 'error' | 'mime'>>): void {
    const map: Record<string, string> = { path: 'path', filename: 'filename', totalBytes: 'total_bytes', receivedBytes: 'received_bytes', state: 'state', error: 'error', mime: 'mime' };
    const keys = Object.keys(patch).filter((k) => k in map);
    if (!keys.length) return;
    const finished = patch.state === 'completed' || patch.state === 'cancelled' || patch.state === 'interrupted';
    const sql = `UPDATE downloads SET ${keys.map((k) => `${map[k]} = ?`).join(', ')}${finished ? ', end_time = ?' : ''} WHERE id = ?`;
    const values = keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null);
    this.db.prepare(sql).run(...values, ...(finished ? [this.now()] : []), id);
  }

  get(id: number): DownloadRecord | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM downloads WHERE id = ?`).get(id) as unknown as DownloadRecord | undefined;
  }

  /** Las más recientes primero; `query` filtra por nombre o dirección. */
  list(opts: { query?: string; limit?: number } = {}): DownloadRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const q = opts.query?.trim();
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      return this.db.prepare(`SELECT ${COLS} FROM downloads WHERE filename LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' ORDER BY start_time DESC, id DESC LIMIT ${limit}`).all(like, like) as unknown as DownloadRecord[];
    }
    return this.db.prepare(`SELECT ${COLS} FROM downloads ORDER BY start_time DESC, id DESC LIMIT ${limit}`).all() as unknown as DownloadRecord[];
  }

  /** Quita de la lista (el archivo no se toca). */
  remove(id: number): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  /** Quita de la lista todas las que ya terminaron (las que siguen en curso quedan). */
  clearFinished(): void {
    this.db.prepare("DELETE FROM downloads WHERE state IN ('completed', 'cancelled', 'interrupted')").run();
  }

  /** Al arrancar: lo que quedó a medias en la sesión anterior se marca como interrumpido. */
  markUnfinishedAsInterrupted(reason: string): void {
    this.db
      .prepare("UPDATE downloads SET state = 'interrupted', error = ?, end_time = ? WHERE state IN ('starting', 'in_progress', 'paused', 'waiting_click')")
      .run(reason, this.now());
  }
}
