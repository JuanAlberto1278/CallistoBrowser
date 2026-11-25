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

/** Cambios del historial (para chrome.history.onVisited / onVisitRemoved). */
export type HistoryChange = { type: 'visited'; url: string } | { type: 'removed'; allHistory: boolean; urls: string[] };

export class HistoryStore {
  private readonly listeners = new Set<(c: HistoryChange) => void>();

  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  onChange(fn: (c: HistoryChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(c: HistoryChange): void {
    for (const fn of this.listeners) {
      try {
        fn(c);
      } catch {
        /* un oyente no corta a los demás */
      }
    }
  }

  addVisit(url: string, opts: { typed?: boolean; title?: string; time?: number } = {}): void {
    if (!isRecordable(url)) return;
    const time = opts.time ?? this.now();
    const typed = opts.typed ? 1 : 0;
    this.db.prepare(
      `INSERT INTO urls (url, host, title, visit_count, typed_count, last_visit) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(url) DO UPDATE SET visit_count = visit_count + 1, typed_count = typed_count + excluded.typed_count,
         last_visit = excluded.last_visit, title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END`,
    ).run(url, hostOf(url), opts.title ?? '', typed, time);
    const row = this.db.prepare('SELECT id FROM urls WHERE url = ?').get(url) as { id: number };
    this.db.prepare('INSERT INTO visits (url_id, time, typed) VALUES (?, ?, ?)').run(row.id, time, typed);
    this.notify({ type: 'visited', url });
  }

  /**
   * Direcciones (no visitas) con su última visita en [startTime, endTime), las más recientes primero
   * (chrome.history.search). Con texto, el que esté en el título o la dirección.
   */
  urls(opts: { text?: string; startTime?: number; endTime?: number; limit?: number } = {}): Array<UrlRow & { id: number }> {
    const where = ['last_visit >= ?', 'last_visit < ?'];
    const args: (string | number)[] = [opts.startTime ?? 0, opts.endTime ?? Number.MAX_SAFE_INTEGER];
    const q = opts.text?.trim() ?? '';
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
      const like = `%${likeEscape(q)}%`;
      args.push(like, like);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 10_000));
    return this.db
      .prepare(`SELECT id, url, title, host, visit_count AS visitCount, typed_count AS typedCount, last_visit AS lastVisit, icon_url AS iconUrl FROM urls WHERE ${where.join(' AND ')} ORDER BY last_visit DESC LIMIT ${limit}`)
      .all(...args) as unknown as Array<UrlRow & { id: number }>;
  }

  /** La dirección guardada (id, contadores), si existe. */
  urlRow(url: string): (UrlRow & { id: number }) | undefined {
    return this.db.prepare('SELECT id, url, title, host, visit_count AS visitCount, typed_count AS typedCount, last_visit AS lastVisit, icon_url AS iconUrl FROM urls WHERE url = ?').get(url) as unknown as (UrlRow & { id: number }) | undefined;
  }

  /** Visitas a una dirección, de la más antigua a la más reciente (chrome.history.getVisits). */
  visitsOf(url: string): Array<{ id: number; urlId: number; time: number; typed: boolean }> {
    const rows = this.db.prepare('SELECT v.id, v.url_id AS urlId, v.time, v.typed FROM visits v JOIN urls u ON u.id = v.url_id WHERE u.url = ? ORDER BY v.time, v.id').all(url) as Array<{ id: number; urlId: number; time: number; typed: number }>;
    return rows.map((r) => ({ ...r, typed: r.typed === 1 }));
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
    const removed = this.db.prepare('DELETE FROM urls WHERE url = ?').run(url).changes > 0;
    if (removed) this.notify({ type: 'removed', allHistory: false, urls: [url] });
  }

  /** Visitas con tiempo en [from, to). */
  deleteRange(from: number, to: number): void {
    this.db.prepare('DELETE FROM visits WHERE time >= ? AND time < ?').run(from, to);
    const gone = this.cleanup();
    if (gone.length) this.notify({ type: 'removed', allHistory: false, urls: gone });
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM visits; DELETE FROM urls;');
    this.notify({ type: 'removed', allHistory: true, urls: [] });
  }

  /** Borra lo que tiene más de RETENTION_DAYS días. */
  expire(): void {
    this.db.prepare('DELETE FROM visits WHERE time < ?').run(this.now() - RETENTION_DAYS * DAY);
    this.cleanup();
  }

  /** Quita direcciones sin visitas y recalcula contadores. Devuelve las direcciones que se quitaron. */
  private cleanup(): string[] {
    const gone = (this.db.prepare('SELECT url FROM urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits)').all() as Array<{ url: string }>).map((r) => r.url);
    this.db.exec(`
      DELETE FROM urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits);
      UPDATE urls SET
        visit_count = (SELECT count(*) FROM visits WHERE url_id = urls.id),
        typed_count = (SELECT count(*) FROM visits WHERE url_id = urls.id AND typed = 1),
        last_visit = (SELECT max(time) FROM visits WHERE url_id = urls.id);
    `);
    return gone;
  }

  /** Favicon conocido para una dirección (o, si no hay, para su sitio). */
  iconUrlFor(url: string): string | null {
    const exact = this.db.prepare('SELECT icon_url AS i FROM urls WHERE url = ? AND icon_url IS NOT NULL').get(url) as { i: string } | undefined;
    if (exact) return exact.i;
    const host = hostOf(url);
    if (!host) return null;
    const site = this.db.prepare('SELECT icon_url AS i FROM urls WHERE host = ? AND icon_url IS NOT NULL ORDER BY visit_count DESC LIMIT 1').get(host) as { i: string } | undefined;
    return site?.i ?? null;
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
   * Sitios más visitados de los últimos 30 días, uno por sitio (para la página de nueva pestaña). Cada mosaico lleva a
   * la página principal del sitio. `hidden`: sitios que el usuario quitó.
   */
  topSites(limit = 8, hidden: ReadonlySet<string> = new Set()): Array<{ url: string; host: string; title: string; iconUrl: string | null }> {
    const since = this.now() - 30 * DAY;
    const rows = this.db
      .prepare(`SELECT url, title, host, visit_count AS visitCount, typed_count AS typedCount, last_visit AS lastVisit, icon_url AS iconUrl
        FROM urls WHERE url LIKE 'http%' AND last_visit >= ? ORDER BY visit_count DESC LIMIT 500`)
      .all(since) as unknown as UrlRow[];
    const now = this.now();
    const sites = new Map<string, { score: number; origin: string; host: string; rootTitle: string; anyTitle: string; iconUrl: string | null }>();
    for (const r of rows) {
      const host = bareHost(r.host);
      if (!host || hidden.has(host)) continue;
      let origin: string;
      try {
        origin = new URL(r.url).origin;
      } catch {
        continue;
      }
      const days = Math.max(0, (now - r.lastVisit) / DAY);
      const score = (Math.log2(1 + r.visitCount) + 2 * Math.log2(1 + r.typedCount)) / (1 + days / 7);
      const isRoot = /^https?:\/\/[^/]+\/?$/.test(r.url);
      const s = sites.get(host) ?? { score: 0, origin, host, rootTitle: '', anyTitle: '', iconUrl: null };
      s.score += score;
      if (isRoot && r.title) s.rootTitle = r.title;
      if (!s.anyTitle && r.title) s.anyTitle = r.title;
      s.iconUrl ??= r.iconUrl;
      sites.set(host, s);
    }
    return [...sites.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ url: `${s.origin}/`, host: s.host, title: s.rootTitle || s.host, iconUrl: s.iconUrl }));
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
