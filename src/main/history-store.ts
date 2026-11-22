import type { DatabaseSync } from 'node:sqlite';

// Historial de navegación de un perfil. Lógica sobre SQLite sin Electron, para poder probarla de forma aislada.

export interface HistoryVisit {
  id: number;
  url: string;
  title: string;
  host: string;
  time: number;
  iconUrl: string | null;
}

export interface UrlRow {
  url: string;
  title: string;
  host: string;
  visitCount: number;
  typedCount: number;
  lastVisit: number;
  iconUrl: string | null;
}

/** Solo se registran páginas web y archivos locales (no páginas en blanco, internas ni data:). */
export function isRecordable(url: string): boolean {
  return /^(https?:\/\/[^/]|file:\/\/)/i.test(url) && url.length <= 8192;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Host sin "www." (como lo muestran las sugerencias). */
export function bareHost(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Escapa % _ y \ para LIKE ... ESCAPE '\'. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Frase FTS5 literal (el texto del usuario nunca se interpreta como sintaxis de búsqueda). */
const ftsPhrase = (s: string) => `"${s.replace(/"/g, '""')}"`;

const DAY = 24 * 60 * 60 * 1000;
/** Como Chrome: el historial guarda los últimos 90 días. */
export const RETENTION_DAYS = 90;

export class HistoryStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  addVisit(url: string, opts: { typed?: boolean; title?: string } = {}): void {
    if (!isRecordable(url)) return;
    const time = this.now();
    const typed = opts.typed ? 1 : 0;
    this.db.prepare(
      `INSERT INTO urls (url, host, title, visit_count, typed_count, last_visit) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1, typed_count = typed_count + excluded.typed_count,
         last_visit = excluded.last_visit, title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END`,
    ).run(url, hostOf(url), opts.title ?? '', typed, time);
    const row = this.db.prepare('SELECT id FROM urls WHERE url = ?').get(url) as { id: number };
    this.db.prepare('INSERT INTO visits (url_id, time, typed) VALUES (?, ?, ?)').run(row.id, time, typed);
  }

  setTitle(url: string, title: string): void {
    if (!isRecordable(url) || !title) return;
    this.db.prepare('UPDATE urls SET title = ? WHERE url = ? AND title <> ?').run(title.slice(0, 1024), url, title.slice(0, 1024));
  }

  setIcon(url: string, iconUrl: string): void {
    if (!isRecordable(url)) return;
    this.db.prepare('UPDATE urls SET icon_url = ? WHERE url = ?').run(iconUrl.slice(0, 8192), url);
  }

  /**
   * Visitas, de la más reciente a la más antigua. `before` pagina: devuelve las anteriores a esa visita
   * (por tiempo y, a igual tiempo, por id).
   */
  search(opts: { query?: string; before?: { time: number; id: number }; limit?: number } = {}): HistoryVisit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const where: string[] = [];
    const args: (string | number)[] = [];
    const q = opts.query?.trim() ?? '';
    if (q) {
      if (q.length >= 3) {
        where.push('u.id IN (SELECT rowid FROM urls_fts WHERE urls_fts MATCH ?)');
        args.push(ftsPhrase(q));
      } else {
        where.push("(u.title LIKE ? ESCAPE '\\' OR u.url LIKE ? ESCAPE '\\')");
        const like = `%${likeEscape(q)}%`;
        args.push(like, like);
      }
    }
    if (opts.before) {
      where.push('(v.time < ? OR (v.time = ? AND v.id < ?))');
      args.push(opts.before.time, opts.before.time, opts.before.id);
    }
    const sql = `SELECT v.id, u.url, u.title, u.host, v.time, u.icon_url AS iconUrl
      FROM visits v JOIN urls u ON u.id = v.url_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY v.time DESC, v.id DESC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...args) as unknown as HistoryVisit[];
  }

  deleteVisit(id: number): void {
    this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    this.cleanup();
  }

  /** Todas las visitas a una dirección. */
  deleteUrl(url: string): void {
    this.db.prepare('DELETE FROM urls WHERE url = ?').run(url);
  }

  /** Visitas con tiempo en [from, to). */
  deleteRange(from: number, to: number): void {
    this.db.prepare('DELETE FROM visits WHERE time >= ? AND time < ?').run(from, to);
    this.cleanup();
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM visits; DELETE FROM urls;');
  }

  /** Borra lo que tiene más de RETENTION_DAYS días. */
  expire(): void {
    this.db.prepare('DELETE FROM visits WHERE time < ?').run(this.now() - RETENTION_DAYS * DAY);
    this.cleanup();
  }

  /** Quita direcciones sin visitas y recalcula contadores. */
  private cleanup(): void {
    this.db.exec(`
      DELETE FROM urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits);
      UPDATE urls SET
        visit_count = (SELECT count(*) FROM visits WHERE url_id = urls.id),
        typed_count = (SELECT count(*) FROM visits WHERE url_id = urls.id AND typed = 1),
        last_visit = (SELECT max(time) FROM visits WHERE url_id = urls.id);
    `);
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM visits').get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- sugerencias de la barra de direcciones

  /** Direcciones del historial que coinciden con lo escrito, ordenadas por relevancia. */
  suggest(text: string, limit = 6): UrlRow[] {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const cols = 'url, title, host, visit_count AS visitCount, typed_count AS typedCount, last_visit AS lastVisit, icon_url AS iconUrl';
    const hostPrefix = likeEscape(q.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!);
    const rows = new Map<string, UrlRow>();
    const add = (list: unknown[]) => {
      for (const r of list as UrlRow[]) rows.set(r.url, r);
    };
    if (hostPrefix) {
      add(this.db.prepare(`SELECT ${cols} FROM urls WHERE host LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' ORDER BY visit_count DESC LIMIT 100`).all(`${hostPrefix}%`, `www.${hostPrefix}%`));
    }
    if (q.length >= 3) {
      add(this.db.prepare(`SELECT ${cols} FROM urls WHERE id IN (SELECT rowid FROM urls_fts WHERE urls_fts MATCH ? LIMIT 300)`).all(ftsPhrase(q)));
    }
    const now = this.now();
    const score = (r: UrlRow) => {
      const days = Math.max(0, (now - r.lastVisit) / DAY);
      let s = Math.log2(1 + r.visitCount) + 2 * Math.log2(1 + r.typedCount) + 2 / (1 + days / 7);
      const display = r.url.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
      if (display.startsWith(q)) s += 4;
      else if (r.url.toLowerCase().includes(q)) s += 1;
      if (r.title.toLowerCase().includes(q)) s += 0.5;
      // Las páginas principales de un sitio primero
      if (/^[^/]+\/?$/.test(display)) s += 1;
      return s;
    };
    return [...rows.values()].sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  /**
   * Autocompletado en línea (como Chrome): si lo escrito es el comienzo del nombre de un sitio visitado con frecuencia
   * o escrito antes, devuelve ese sitio. Solo completa nombres de sitio, nunca rutas ni búsquedas.
   */
  inlineCandidate(text: string): { url: string; display: string; completion: string } | null {
    const q = text.trim().toLowerCase();
    if (!q || /[\s/?#]/.test(q) || q.includes('://')) return null;
    const typedHost = q.startsWith('www.') ? q.slice(4) : q;
    const like = likeEscape(typedHost);
    const rows = this.db
      .prepare(
        `SELECT host, max(typed_count) AS typed, sum(visit_count) AS visits, min(url) AS url FROM urls
         WHERE (host LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\') AND url LIKE 'http%'
         GROUP BY host ORDER BY typed DESC, visits DESC LIMIT 5`,
      )
      .all(`${like}%`, `www.${like}%`) as Array<{ host: string; typed: number; visits: number; url: string }>;
    for (const r of rows) {
      if (r.typed < 1 && r.visits < 2) continue;
      const display = bareHost(r.host);
      if (!display.startsWith(typedHost) || display === typedHost) continue;
      const origin = new URL(r.url).origin;
      return { url: `${origin}/`, display, completion: display.slice(typedHost.length) };
    }
    return null;
  }
}
