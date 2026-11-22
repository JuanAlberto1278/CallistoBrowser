import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, MIGRATIONS, openDatabase } from '../../src/main/db';
import { bareHost, HistoryStore, isRecordable, RETENTION_DAYS } from '../../src/main/history-store';
import { FaviconStore, KeyValueStore, PermissionStore, ZoomStore } from '../../src/main/profile-store';
import { cleanSession, MAX_ENTRIES, trimSnapshot } from '../../src/main/session-store';
import { buildSuggestions } from '../../src/main/suggestions';
import { permissionPhrase, sitePermissionForCheck, sitePermissionsFor, webOrigin } from '../../src/main/permissions';
import { ClosedTabs } from '../../src/main/closed-tabs';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../src/shared/settings';
import { resolveInput } from '../../src/shared/omnibox';
import { internalPageOf } from '../../src/shared/internal-pages';
import { classifyUrl } from '../../src/shared/url-security';

const DAY = 24 * 60 * 60 * 1000;

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Reloj controlable para las pruebas. */
function clock(start = Date.UTC(2026, 10, 21, 12)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('base de datos', () => {
  it('las migraciones corren una sola vez y dejan la versión', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version); // segunda vez: nada que hacer
  });

  it('una migración que falla no deja cambios a medias', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db, [...MIGRATIONS, { version: 99, sql: 'CREATE TABLE x (a); SELECT * FROM tabla_que_no_existe;' }])).toThrow();
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'x'").get()).toBeUndefined();
  });

  it('una base dañada se aparta (sin borrarla) y se empieza una nueva', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callisto-db-'));
    try {
      const file = join(dir, 'callisto.db');
      writeFileSync(file, Buffer.alloc(4096, 0x5a));
      const { db, recoveredFrom } = openDatabase(file);
      expect(recoveredFrom).toMatch(/callisto\.db\.danada-\d+$/);
      expect(readdirSync(dir).filter((f) => f.startsWith('callisto.db.danada-'))).toHaveLength(1);
      new HistoryStore(db).addVisit('https://a.com/');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('historial', () => {
  it('solo registra páginas web y archivos', () => {
    expect(isRecordable('https://a.com/')).toBe(true);
    expect(isRecordable('file:///C:/a.html')).toBe(true);
    for (const u of ['about:blank', 'callisto://history/', 'data:text/html,x', 'javascript:alert(1)', 'chrome://gpu', '']) expect(isRecordable(u)).toBe(false);
  });

  it('cada visita queda registrada; la dirección se cuenta una vez con sus visitas', () => {
    const t = clock();
    const h = new HistoryStore(memoryDb(), t.now);
    h.addVisit('https://a.com/', { title: 'A', typed: true });
    t.advance(1000);
    h.addVisit('https://a.com/', { title: '' });
    t.advance(1000);
    h.addVisit('https://b.com/x', { title: 'B' });
    const list = h.search();
    expect(list.map((v) => v.url)).toEqual(['https://b.com/x', 'https://a.com/', 'https://a.com/']);
    expect(list[1]!.title).toBe('A'); // un título vacío no pisa el anterior
    expect(h.suggest('a.com')[0]).toMatchObject({ url: 'https://a.com/', visitCount: 2, typedCount: 1 });
  });

  it('busca por fragmentos del título o la dirección, sin interpretar el texto como sintaxis', () => {
    const h = new HistoryStore(memoryDb());
    h.addVisit('https://www.wikipedia.org/wiki/Calisto', { title: 'Calisto (satélite) — Wikipedia' });
    h.addVisit('https://ejemplo.com/', { title: 'Ejemplo' });
    expect(h.search({ query: 'satél' }).map((v) => v.url)).toEqual(['https://www.wikipedia.org/wiki/Calisto']);
    expect(h.search({ query: 'kipedia.org/wi' })).toHaveLength(1);
    expect(h.search({ query: 'EJEMPLO' })).toHaveLength(1);
    expect(h.search({ query: 'ej' })).toHaveLength(1); // menos de 3 letras: búsqueda simple
    expect(h.search({ query: '"; DROP TABLE urls; --' })).toHaveLength(0);
    expect(h.search({ query: 'a OR b NEAR(c)' })).toHaveLength(0);
    expect(h.search({ query: '%' })).toHaveLength(0);
  });

  it('pagina de la más reciente a la más antigua', () => {
    const t = clock();
    const h = new HistoryStore(memoryDb(), t.now);
    for (let i = 0; i < 5; i++) {
      h.addVisit(`https://s${i}.com/`);
      t.advance(1000);
    }
    const first = h.search({ limit: 2 });
    expect(first.map((v) => v.host)).toEqual(['s4.com', 's3.com']);
    const next = h.search({ limit: 2, before: { time: first[1]!.time, id: first[1]!.id } });
    expect(next.map((v) => v.host)).toEqual(['s2.com', 's1.com']);
  });

  it('borrar una visita, un período o todo', () => {
    const t = clock();
    const h = new HistoryStore(memoryDb(), t.now);
    h.addVisit('https://viejo.com/');
    t.advance(2 * DAY);
    h.addVisit('https://a.com/');
    h.addVisit('https://a.com/');
    const [latest] = h.search();
    h.deleteVisit(latest!.id);
    expect(h.count()).toBe(2);
    expect(h.suggest('a.com')[0]!.visitCount).toBe(1); // contadores recalculados

    h.deleteRange(t.now() - DAY, t.now() + 1); // último día
    expect(h.search().map((v) => v.host)).toEqual(['viejo.com']);
    expect(h.suggest('a.com')).toEqual([]); // sin visitas, la dirección desaparece

    h.deleteAll();
    expect(h.count()).toBe(0);
  });

  it(`guarda ${RETENTION_DAYS} días`, () => {
    const t = clock();
    const h = new HistoryStore(memoryDb(), t.now);
    h.addVisit('https://viejo.com/');
    t.advance((RETENTION_DAYS + 1) * DAY);
    h.addVisit('https://nuevo.com/');
    h.expire();
    expect(h.search().map((v) => v.host)).toEqual(['nuevo.com']);
  });

  it('sugerencias: primero los sitios que empiezan con lo escrito y los más usados', () => {
    const h = new HistoryStore(memoryDb());
    for (let i = 0; i < 5; i++) h.addVisit('https://www.google.com/', { title: 'Google' });
    h.addVisit('https://news.google.com/', { title: 'Google Noticias' });
    h.addVisit('https://ejemplo.com/goo', { title: 'Algo' });
    const urls = h.suggest('goo').map((r) => r.url);
    expect(urls[0]).toBe('https://www.google.com/');
    expect(urls).toContain('https://news.google.com/');
    expect(h.suggest('')).toEqual([]);
  });

  it('autocompletado en línea: solo nombres de sitio usados o escritos antes', () => {
    const h = new HistoryStore(memoryDb());
    h.addVisit('https://www.google.com/search?q=x');
    expect(h.inlineCandidate('goo')).toBeNull(); // una sola visita, nunca escrito
    h.addVisit('https://www.google.com/');
    expect(h.inlineCandidate('goo')).toEqual({ url: 'https://www.google.com/', display: 'google.com', completion: 'gle.com' });
    expect(h.inlineCandidate('www.goo')).toMatchObject({ completion: 'gle.com' });
    expect(h.inlineCandidate('google.com')).toBeNull(); // ya está completo
    expect(h.inlineCandidate('goo gle')).toBeNull(); // es una búsqueda
    expect(h.inlineCandidate('google.com/se')).toBeNull(); // no completa rutas

    h.addVisit('https://localhost:3000/app', { typed: true });
    expect(h.inlineCandidate('local')).toMatchObject({ url: 'https://localhost:3000/', completion: 'host' });
    expect(bareHost('www.a.com')).toBe('a.com');
  });
});

describe('zoom, permisos, favicons y configuración guardados', () => {
  it('zoom por sitio: el 100 % no se guarda', () => {
    const z = new ZoomStore(memoryDb());
    z.set('a.com', 1.25);
    expect(z.get('a.com')).toBe(1.25);
    z.set('a.com', 1);
    expect(z.get('a.com')).toBeUndefined();
  });

  it('permisos por sitio y por tipo', () => {
    const p = new PermissionStore(memoryDb());
    p.set('https://a.com', 'camera', 'allow');
    p.set('https://a.com', 'microphone', 'block');
    expect(p.get('https://a.com', 'camera')).toBe('allow');
    expect(p.get('https://a.com', 'microphone')).toBe('block');
    expect(p.get('https://b.com', 'camera')).toBeUndefined();
    p.set('https://a.com', 'camera', 'block');
    expect(p.list()).toHaveLength(2);
    p.remove('https://a.com', 'camera');
    expect(p.get('https://a.com', 'camera')).toBeUndefined();
  });

  it('favicons guardados vencen a los 30 días', () => {
    const t = clock();
    const f = new FaviconStore(memoryDb(), t.now);
    f.put('https://a.com/favicon.ico', 'data:image/png;base64,AA==');
    expect(f.get('https://a.com/favicon.ico')).toBe('data:image/png;base64,AA==');
    t.advance(31 * DAY);
    expect(f.get('https://a.com/favicon.ico')).toBeUndefined();
  });

  it('configuración: solo valores conocidos', () => {
    expect(sanitizeSettings({ searchEngine: 'duckduckgo', startup: 'newtab' })).toEqual({ searchEngine: 'duckduckgo', startup: 'newtab', downloadDir: null, bookmarksBar: 'always' });
    expect(sanitizeSettings({ searchEngine: 'malicioso', startup: 'otro' })).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const kv = new KeyValueStore(memoryDb());
    kv.set('x', { a: 1 });
    expect(kv.get('x')).toEqual({ a: 1 });
    expect(kv.get('nada')).toBeUndefined();
  });
});

describe('sesión guardada', () => {
  const entry = (url: string) => ({ url, title: url });

  it('descarta lo que no tiene la forma esperada en vez de fallar', () => {
    expect(cleanSession('basura')).toEqual({ version: 1, windows: [], closed: [] });
    const s = cleanSession({
      windows: [
        { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true, active: 9, tabs: [{ entries: [entry('https://a.com/')], index: 0 }, { entries: [] }, 'x'] },
        { tabs: [] },
        { tabs: [{ entries: [entry('javascript:alert(1)')], index: 0 }] },
      ],
      closed: [{ kind: 'tab', tab: { entries: [entry('https://b.com/')], index: 5 } }, { kind: 'raro' }],
    });
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]).toMatchObject({ maximized: true, active: 0, bounds: { x: 1, y: 2, width: 800, height: 600 } });
    expect(s.windows[0]!.tabs).toHaveLength(1);
    expect(s.windows[0]!.tabs[0]).toMatchObject({ url: 'https://a.com/', index: 0 });
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]).toMatchObject({ kind: 'tab', tab: { index: 0 } });
  });

  it(`guarda como máximo ${MAX_ENTRIES} entradas por pestaña, alrededor de la actual`, () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`https://a.com/${i}`));
    const t = trimSnapshot({ entries, index: 40 });
    expect(t.entries).toHaveLength(MAX_ENTRIES);
    expect(t.entries[t.index]!.url).toBe('https://a.com/40');
    const end = trimSnapshot({ entries, index: 59 });
    expect(end.entries[end.index]!.url).toBe('https://a.com/59');
  });

  it('las pestañas cerradas se guardan y avisan cada cambio', () => {
    let changes = 0;
    const closed = new ClosedTabs([{ kind: 'tab', windowId: 1, index: 0, tab: { entries: [entry('https://a.com/')], index: 0 } }]);
    closed.onChange = () => changes++;
    closed.push({ kind: 'tab', windowId: 1, index: 0, tab: { entries: [entry('https://b.com/')], index: 0 } });
    expect(closed.entries()).toHaveLength(2);
    closed.pop();
    expect(changes).toBe(2);
  });
});

describe('sugerencias de la barra', () => {
  const row = (url: string, title: string) => ({ url, title, host: new URL(url).hostname, visitCount: 3, typedCount: 1, lastVisit: 0, iconUrl: null });
  const base = { engineName: 'Google', icon: () => null };

  it('primero lo que hará Enter: la búsqueda', () => {
    const items = buildSuggestions({ ...base, text: 'hola mundo', resolved: resolveInput('hola mundo'), inline: null, history: [row('https://hola.com/', 'Hola')] });
    expect(items[0]).toMatchObject({ kind: 'search', text: 'hola mundo', detail: 'Buscar en Google' });
    expect(items[1]).toMatchObject({ kind: 'history', url: 'https://hola.com/' });
  });

  it('con autocompletado, primero el sitio; la búsqueda queda al final', () => {
    const items = buildSuggestions({ ...base, text: 'goo', resolved: resolveInput('goo'), inline: { url: 'https://www.google.com/', display: 'google.com' }, history: [row('https://www.google.com/', 'Google')] });
    expect(items[0]).toMatchObject({ kind: 'history', url: 'https://www.google.com/', text: 'Google' });
    expect(items.filter((i) => i.url === 'https://www.google.com/')).toHaveLength(1); // sin repetidos
    expect(items[items.length - 1]!.kind).toBe('search');
  });

  it('una dirección escrita va primero', () => {
    const items = buildSuggestions({ ...base, text: 'a.com', resolved: resolveInput('a.com'), inline: null, history: [] });
    expect(items).toEqual([expect.objectContaining({ kind: 'url', url: 'https://a.com/' })]);
  });
});

describe('permisos: traducción de los pedidos de Chromium', () => {
  it('cámara y micrófono según lo que pide la página', () => {
    expect(sitePermissionsFor('media', ['video', 'audio'])).toEqual(['camera', 'microphone']);
    expect(sitePermissionsFor('media', ['audio'])).toEqual(['microphone']);
    expect(sitePermissionsFor('media', [])).toBeNull();
    expect(sitePermissionsFor('geolocation')).toEqual(['geolocation']);
    expect(sitePermissionsFor('notifications')).toEqual(['notifications']);
  });
  it('lo que Callisto no ofrece se deniega (null)', () => {
    for (const p of ['midiSysex', 'clipboard-read', 'openExternal', 'display-capture', 'hid', 'serial', 'idle-detection']) expect(sitePermissionsFor(p)).toBeNull();
    expect(sitePermissionForCheck('media', 'video')).toBe('camera');
    expect(sitePermissionForCheck('clipboard-read')).toBeNull();
  });
  it('solo sitios web tienen origen para recordar permisos', () => {
    expect(webOrigin('https://a.com:8443/x?y')).toBe('https://a.com:8443');
    expect(webOrigin('file:///C:/a.html')).toBeNull();
    expect(webOrigin('callisto://settings/')).toBeNull();
    expect(webOrigin(undefined)).toBeNull();
  });
  it('texto del aviso', () => {
    expect(permissionPhrase(['camera', 'microphone'])).toBe('usar tu cámara y tu micrófono');
    expect(permissionPhrase(['geolocation'])).toBe('conocer tu ubicación');
    expect(permissionPhrase(['notifications'])).toBe('mostrarte notificaciones');
  });
});

describe('páginas internas', () => {
  it('la barra reconoce solo las páginas internas conocidas', () => {
    expect(resolveInput('callisto://history')).toEqual({ kind: 'internal', url: 'callisto://history/' });
    expect(resolveInput('CALLISTO://SETTINGS/')).toEqual({ kind: 'internal', url: 'callisto://settings/' });
    expect(resolveInput('callisto://ui/index.html')?.kind).toBe('search');
    expect(resolveInput('callisto://history/../ui')?.kind).toBe('search');
    expect(internalPageOf('callisto://history/?q=x')).toBe('history');
    expect(internalPageOf('callisto://historyx/')).toBeNull();
    expect(classifyUrl('callisto://settings/')).toBe('internal');
  });
});
