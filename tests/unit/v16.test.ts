import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/main/db';
import { HistoryStore } from '../../src/main/history-store';
import { bookmarksFromChromium, chromeTimeToMs, isTypedTransition, loginsFromCsv, loginsToCsv, msToChromeTime, parseCsv } from '../../src/shared/import';

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

const DAY = 24 * 60 * 60 * 1000;

describe('fechas de Chrome (1.6)', () => {
  it('microsegundos desde 1601 ↔ ms desde 1970, sin perder precisión', () => {
    const ms = Date.UTC(2026, 10, 25, 12, 30, 15, 123);
    expect(chromeTimeToMs(msToChromeTime(ms))).toBe(ms);
    expect(chromeTimeToMs(String(msToChromeTime(ms)))).toBe(ms);
    expect(chromeTimeToMs(13_000_000_000_000_000n)).toBe(1_355_526_400_000);
    expect(chromeTimeToMs(0)).toBe(0);
    expect(chromeTimeToMs('nada')).toBe(0);
  });

  it('escrita en la barra: el tipo de navegación 1', () => {
    expect(isTypedTransition(0x30000001)).toBe(true);
    expect(isTypedTransition(805306368)).toBe(false); // LINK con calificadores
    expect(isTypedTransition(0n + 1n)).toBe(true);
  });
});

describe('favoritos de Chrome y Edge (1.6)', () => {
  it('la barra en su carpeta, después los otros y los del celular', () => {
    const tree = bookmarksFromChromium(
      {
        roots: {
          bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'A', url: 'https://a.com/' }] },
          other: { type: 'folder', children: [{ type: 'folder', name: 'Carpeta', children: [{ type: 'url', name: 'B', url: 'https://b.com/' }] }, { type: 'url', name: 'C', url: 'https://c.com/' }] },
          synced: { type: 'folder', children: [{ type: 'url', name: 'D', url: 'https://d.com/' }] },
          workspaces_v2: { type: 'folder', children: [{ type: 'url', name: 'Ignorado', url: 'https://x.com/' }] },
        },
      },
      'edge',
    );
    expect(tree).toEqual({
      title: 'Importados de Edge',
      children: [
        { title: 'Barra de favoritos', children: [{ title: 'A', url: 'https://a.com/' }] },
        { title: 'Carpeta', children: [{ title: 'B', url: 'https://b.com/' }] },
        { title: 'C', url: 'https://c.com/' },
        { title: 'Favoritos del celular', children: [{ title: 'D', url: 'https://d.com/' }] },
      ],
    });
    expect(bookmarksFromChromium({ roots: {} }, 'chrome')).toEqual({ title: 'Importados de Chrome', children: [] });
    expect(bookmarksFromChromium('no', 'chrome')).toBeNull();
    expect(bookmarksFromChromium({ otra: 1 }, 'chrome')).toBeNull();
  });
});

describe('contraseñas en CSV (1.6)', () => {
  it('CSV: comillas, comas y saltos de línea dentro de un campo, BOM y CRLF', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","con ""comillas""\ny salto"\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'con "comillas"\ny salto'],
    ]);
  });

  it('de Chrome, Edge o Firefox: por nombre de columna, salteando lo que no sirve', () => {
    const chrome = loginsFromCsv('name,url,username,password,note\nej,https://ej.com/login?a=1,ana,uno,\nand,android://x@com.app/,b,dos,\nvac,https://v.com/,c,,\nej,https://ej.com/otra,ana,tres,');
    expect(chrome).toEqual({ logins: [{ origin: 'https://ej.com', username: 'ana', password: 'tres' }], skipped: 3 });
    const firefox = loginsFromCsv('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://ff.com","eva","clave",,"https://ff.com","{1}","1","1","1"');
    expect(firefox).toEqual({ logins: [{ origin: 'https://ff.com', username: 'eva', password: 'clave' }], skipped: 0 });
    expect(loginsFromCsv('')).toEqual({ error: 'El archivo está vacío.' });
    expect(loginsFromCsv('a,b,c\n1,2,3')).toHaveProperty('error');
  });

  it('exportar con el formato de Chrome, que vuelve a importarse igual', () => {
    const logins = [
      { origin: 'https://www.ejemplo.com', username: 'ana', password: 'con, coma y "comillas"' },
      { origin: 'http://127.0.0.1:8080', username: '', password: 'x\ny' },
    ];
    const csv = loginsToCsv(logins);
    expect(csv.split('\r\n')[0]).toBe('name,url,username,password,note');
    expect(csv).toContain('ejemplo.com,https://www.ejemplo.com/,ana,"con, coma y ""comillas""",');
    expect(loginsFromCsv(csv)).toEqual({ logins, skipped: 0 });
  });
});

describe('historial importado (1.6)', () => {
  it('solo los últimos 90 días, sin duplicar al importar de nuevo, con contadores y título', () => {
    const now = Date.UTC(2026, 10, 25);
    const h = new HistoryStore(memoryDb(), () => now);
    h.addVisit('https://a.com/', { title: '' , time: now - DAY });
    const rows = [
      { url: 'https://a.com/', title: 'A', time: now - 2 * DAY, typed: true },
      { url: 'https://a.com/', title: 'A', time: now - 3 * DAY, typed: false },
      { url: 'https://b.com/', title: 'B', time: now - 200 * DAY, typed: false },
      { url: 'javascript:alert(1)', title: 'X', time: now - DAY, typed: false },
      { url: 'https://c.com/', title: 'C', time: now + DAY, typed: false },
    ];
    expect(h.importVisits(rows)).toBe(2);
    expect(h.importVisits(rows)).toBe(0);
    const a = h.urlRow('https://a.com/')!;
    expect([a.visitCount, a.typedCount, a.lastVisit, a.title]).toEqual([3, 1, now - DAY, 'A']);
    expect(h.urlRow('https://b.com/')).toBeUndefined();
    expect(h.search({ query: 'a.com' }).length).toBe(3);
  });

  it('35 000 visitas (un perfil real de Edge) en poco tiempo', () => {
    const now = Date.UTC(2026, 10, 25);
    const h = new HistoryStore(memoryDb(), () => now);
    const rows = Array.from({ length: 35_000 }, (_, i) => ({ url: `https://sitio${i % 3000}.com/p${i % 7}`, title: `Página ${i}`, time: now - (i % 80) * DAY - i, typed: i % 5 === 0 }));
    const t0 = performance.now();
    expect(h.importVisits(rows)).toBe(35_000);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});
