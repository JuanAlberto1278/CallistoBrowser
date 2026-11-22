import type { DatabaseSync } from 'node:sqlite';
import { ROOT_FOLDER_IDS, isBookmarkableUrl, type BookmarkNode, type FolderOption } from '../shared/bookmarks';

// Árbol de favoritos de un perfil (sin Electron, para probarlo de forma aislada).

const COLS = 'id, parent_id AS parentId, kind, title, url, position';
const MAX_TITLE = 500;

export class BookmarkError extends Error {}

export class BookmarkStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  get(id: number): BookmarkNode | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM bookmarks WHERE id = ?`).get(id) as unknown as BookmarkNode | undefined;
  }

  children(parentId: number): BookmarkNode[] {
    return this.db
      .prepare(`SELECT ${COLS}, (SELECT count(*) FROM bookmarks c WHERE c.parent_id = b.id) AS childCount FROM bookmarks b WHERE parent_id = ? ORDER BY position, id`)
      .all(parentId) as unknown as BookmarkNode[];
  }

  /** Todas las carpetas en orden de árbol, con su profundidad (para elegir destino). */
  folders(): FolderOption[] {
    const out: FolderOption[] = [];
    const walk = (parentId: number | null, depth: number) => {
      const rows = (parentId === null
        ? this.db.prepare("SELECT id, title FROM bookmarks WHERE parent_id IS NULL AND kind = 'folder' ORDER BY position, id").all()
        : this.db.prepare("SELECT id, title FROM bookmarks WHERE parent_id = ? AND kind = 'folder' ORDER BY position, id").all(parentId)) as Array<{ id: number; title: string }>;
      for (const r of rows) {
        out.push({ id: r.id, title: r.title, depth });
        walk(r.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** Favorito de esa dirección (el primero, si hay varios). */
  findByUrl(url: string): BookmarkNode | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM bookmarks WHERE kind = 'url' AND url = ? ORDER BY id LIMIT 1`).get(url) as unknown as BookmarkNode | undefined;
  }

  search(query: string, limit = 200): BookmarkNode[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    return this.db
      .prepare(`SELECT ${COLS} FROM bookmarks WHERE parent_id IS NOT NULL AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') ORDER BY kind DESC, title LIMIT ${Math.max(1, Math.min(limit, 1000))}`)
      .all(like, like) as unknown as BookmarkNode[];
  }

  /** Cantidad de elementos dentro de una carpeta, contando subcarpetas (para confirmar antes de borrar). */
  descendantCount(id: number): number {
    const r = this.db
      .prepare('WITH RECURSIVE t(id) AS (SELECT id FROM bookmarks WHERE parent_id = ? UNION ALL SELECT b.id FROM bookmarks b JOIN t ON b.parent_id = t.id) SELECT count(*) AS n FROM t')
      .get(id) as { n: number };
    return r.n;
  }

  // ---------------------------------------------------------------- cambios

  addUrl(parentId: number, title: string, url: string, index?: number): number {
    if (!isBookmarkableUrl(url)) throw new BookmarkError('Esa dirección no se puede guardar como favorito.');
    return this.insert(parentId, 'url', title.trim() || url, url, index);
  }

  addFolder(parentId: number, title: string, index?: number): number {
    return this.insert(parentId, 'folder', title.trim() || 'Carpeta nueva', null, index);
  }

  private insert(parentId: number, kind: 'folder' | 'url', title: string, url: string | null, index?: number): number {
    this.requireFolder(parentId);
    const res = this.db
      .prepare('INSERT INTO bookmarks (parent_id, kind, title, url, position, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parentId, kind, title.slice(0, MAX_TITLE), url, 1e9, this.now());
    const id = Number(res.lastInsertRowid);
    this.place(parentId, id, index);
    return id;
  }

  update(id: number, patch: { title?: string; url?: string }): void {
    const node = this.requireEditable(id);
    if (patch.title !== undefined) {
      const title = patch.title.trim() || (node.kind === 'url' ? (patch.url ?? node.url ?? '') : 'Carpeta nueva');
      this.db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title.slice(0, MAX_TITLE), id);
    }
    if (patch.url !== undefined && node.kind === 'url') {
      if (!isBookmarkableUrl(patch.url)) throw new BookmarkError('Esa dirección no se puede guardar como favorito.');
      this.db.prepare('UPDATE bookmarks SET url = ? WHERE id = ?').run(patch.url, id);
    }
  }

  /** Mueve a otra carpeta (o dentro de la misma) en la posición indicada (al final si no se indica). */
  move(id: number, parentId: number, index?: number): void {
    const node = this.requireEditable(id);
    this.requireFolder(parentId);
    if (node.kind === 'folder' && (parentId === id || this.isDescendant(parentId, id))) {
      throw new BookmarkError('Una carpeta no se puede mover dentro de sí misma.');
    }
    const from = node.parentId!;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE bookmarks SET parent_id = ? WHERE id = ?').run(parentId, id);
      this.place(parentId, id, index);
      if (from !== parentId) this.renumber(from);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Borra un favorito o una carpeta con todo su contenido. */
  remove(id: number): void {
    const node = this.requireEditable(id);
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    this.renumber(node.parentId!);
  }

  // ---------------------------------------------------------------- interno

  private requireFolder(id: number): void {
    const node = this.get(id);
    if (!node || node.kind !== 'folder') throw new BookmarkError('La carpeta no existe.');
  }

  private requireEditable(id: number): BookmarkNode {
    const node = this.get(id);
    if (!node) throw new BookmarkError('El favorito no existe.');
    if (ROOT_FOLDER_IDS.includes(id) || node.parentId === null) throw new BookmarkError('Las carpetas principales no se pueden cambiar.');
    return node;
  }

  /** ¿`id` está dentro de `ancestor` (a cualquier profundidad)? */
  private isDescendant(id: number, ancestor: number): boolean {
    let cur = this.get(id);
    while (cur && cur.parentId !== null) {
      if (cur.parentId === ancestor) return true;
      cur = this.get(cur.parentId);
    }
    return false;
  }

  /** Ubica `id` en la posición `index` entre sus hermanos y renumera 0..n. */
  private place(parentId: number, id: number, index?: number): void {
    const siblings = (this.db.prepare('SELECT id FROM bookmarks WHERE parent_id = ? AND id <> ? ORDER BY position, id').all(parentId, id) as Array<{ id: number }>).map((r) => r.id);
    const at = index === undefined ? siblings.length : Math.max(0, Math.min(Math.trunc(index), siblings.length));
    siblings.splice(at, 0, id);
    const upd = this.db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?');
    siblings.forEach((sid, i) => upd.run(i, sid));
  }

  private renumber(parentId: number): void {
    const rows = this.db.prepare('SELECT id FROM bookmarks WHERE parent_id = ? ORDER BY position, id').all(parentId) as Array<{ id: number }>;
    const upd = this.db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?');
    rows.forEach((r, i) => upd.run(i, r.id));
  }
}
