import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/main/db';
import { DownloadStore } from '../../src/main/download-store';
import { HistoryStore } from '../../src/main/history-store';
import { formatBytes, formatRemaining, isDangerousFile, sanitizeFileName, siteOf, uniqueFileName } from '../../src/shared/downloads';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/shared/settings';

// looksWrong y markOfTheWeb viven en downloads.ts, que importa Electron: se prueban de punta a punta (e2e).

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

describe('nombres de archivo', () => {
  it('quita caracteres prohibidos en Windows', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.txt')).toBe('a_b_c_d_e_f_g_h_i_j.txt');
    expect(sanitizeFileName('informe.pdf   ')).toBe('informe.pdf');
    expect(sanitizeFileName('archivo...')).toBe('archivo');
  });
  it('nombres reservados de Windows y vacíos', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt');
    expect(sanitizeFileName('')).toBe('descarga');
    expect(sanitizeFileName('...')).toBe('descarga');
  });
  it('quita las marcas de dirección de texto que disfrazan la extensión ("factura\u202Efdp.exe")', () => {
    const name = sanitizeFileName('factura\u202Efdp.exe');
    expect(name).toBe('facturafdp.exe');
    expect(isDangerousFile(name)).toBe(true);
  });
  it('acorta los nombres muy largos conservando la extensión', () => {
    const name = sanitizeFileName('a'.repeat(300) + '.pdf');
    expect(name.length).toBeLessThanOrEqual(180);
    expect(name.endsWith('.pdf')).toBe(true);
  });
  it('nombre libre: "informe (1).pdf", "(2)"…', () => {
    const taken = new Set(['informe.pdf', 'informe (1).pdf']);
    expect(uniqueFileName('informe.pdf', (n) => taken.has(n))).toBe('informe (2).pdf');
    expect(uniqueFileName('nuevo.pdf', (n) => taken.has(n))).toBe('nuevo.pdf');
    expect(uniqueFileName('LEEME', (n) => n === 'LEEME')).toBe('LEEME (1)');
  });
});

describe('tipos peligrosos', () => {
  it.each(['setup.exe', 'x.MSI', 'script.ps1', 'a.bat', 'atajo.lnk', 'macro.docm', 'disco.iso', 'app.js'])('%s', (n) => {
    expect(isDangerousFile(n)).toBe(true);
  });
  it.each(['foto.jpg', 'informe.pdf', 'datos.csv', 'exe', 'archivo.zip'])('%s no', (n) => {
    expect(isDangerousFile(n)).toBe(false);
  });
});

describe('formato', () => {
  it('tamaños con coma decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2,4 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
  it('tiempo restante', () => {
    expect(formatRemaining(42)).toBe('42 s');
    expect(formatRemaining(150)).toBe('3 min');
    expect(formatRemaining(0)).toBe('');
  });
  it('sitio de origen (blob: y data: usan la página)', () => {
    expect(siteOf('https://cdn.ejemplo.com/a.zip')).toBe('cdn.ejemplo.com');
    expect(siteOf('blob:https://app.ejemplo.com/uuid')).toBe('app.ejemplo.com');
    expect(siteOf('data:text/plain,hola', 'https://pagina.com/x')).toBe('pagina.com');
    expect(siteOf('data:text/plain,hola')).toBe('esta página');
  });
});

describe('lista de descargas', () => {
  const base = { url: 'https://a.com/x.zip', pageUrl: 'https://a.com/', filename: 'x.zip', path: 'C:\\D\\x.zip', mime: 'application/zip', totalBytes: 10, receivedBytes: 0, state: 'starting' as const, error: null };

  it('guarda, actualiza y marca el fin', () => {
    let t = 1000;
    const s = new DownloadStore(memoryDb(), () => t);
    const id = s.insert(base);
    t = 2000;
    s.update(id, { state: 'completed', receivedBytes: 10 });
    expect(s.get(id)).toMatchObject({ state: 'completed', receivedBytes: 10, startTime: 1000, endTime: 2000 });
  });

  it('lo que quedó a medias al cerrar Callisto se marca como interrumpido', () => {
    const s = new DownloadStore(memoryDb());
    const a = s.insert({ ...base, state: 'in_progress' });
    const b = s.insert({ ...base, state: 'waiting_click' });
    const done = s.insert({ ...base, state: 'completed' });
    s.markUnfinishedAsInterrupted('cerrado');
    expect(s.get(a)).toMatchObject({ state: 'interrupted', error: 'cerrado' });
    expect(s.get(b)?.state).toBe('interrupted');
    expect(s.get(done)?.state).toBe('completed');
  });

  it('busca, quita una y borra las terminadas (no las que siguen en curso)', () => {
    let t = 0;
    const s = new DownloadStore(memoryDb(), () => ++t);
    s.insert({ ...base, filename: 'informe.pdf', state: 'completed' });
    const live = s.insert({ ...base, filename: 'pelicula.mkv', state: 'in_progress' });
    s.insert({ ...base, filename: 'fallo.bin', state: 'interrupted' });
    expect(s.list().map((r) => r.filename)).toEqual(['fallo.bin', 'pelicula.mkv', 'informe.pdf']);
    expect(s.list({ query: 'inform' }).map((r) => r.filename)).toEqual(['informe.pdf']);
    expect(s.list({ query: '%' })).toEqual([]); // el comodín de SQL no se interpreta
    s.clearFinished();
    expect(s.list().map((r) => r.id)).toEqual([live]);
  });
});

describe('sitios más visitados (nueva pestaña)', () => {
  it('uno por sitio, ordenados por uso, sin los que se quitaron', () => {
    const h = new HistoryStore(memoryDb());
    for (let i = 0; i < 5; i++) h.addVisit('https://www.google.com/search?q=' + i);
    h.addVisit('https://www.google.com/', { title: 'Google' });
    for (let i = 0; i < 3; i++) h.addVisit('https://wikipedia.org/wiki/' + i, { title: 'Artículo' });
    h.addVisit('https://poco.com/', { title: 'Poco' });
    const sites = h.topSites(8);
    expect(sites.map((s) => s.host)).toEqual(['google.com', 'wikipedia.org', 'poco.com']);
    expect(sites[0]).toMatchObject({ url: 'https://www.google.com/', title: 'Google' });
    expect(sites[1]).toMatchObject({ url: 'https://wikipedia.org/', title: 'wikipedia.org' }); // sin la portada visitada
    expect(h.topSites(8, new Set(['google.com'])).map((s) => s.host)).toEqual(['wikipedia.org', 'poco.com']);
    expect(h.topSites(1)).toHaveLength(1);
  });
});

describe('configuración: carpeta de descargas', () => {
  it('solo rutas absolutas de Windows; si no, la carpeta Descargas', () => {
    expect(sanitizeSettings({ downloadDir: 'D:\\Bajadas' }).downloadDir).toBe('D:\\Bajadas');
    expect(sanitizeSettings({ downloadDir: '\\\\servidor\\compartida' }).downloadDir).toBe('\\\\servidor\\compartida');
    for (const bad of ['relativa\\carpeta', '..\\..\\Windows', '', 42, 'C:', 'file:///C:/x']) {
      expect(sanitizeSettings({ downloadDir: bad }).downloadDir).toBeNull();
    }
    expect(DEFAULT_SETTINGS.downloadDir).toBeNull();
  });
});
