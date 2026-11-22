import { describe, expect, it } from 'vitest';
import { displayUrl, resolveInput, searchUrl } from '../../src/shared/omnibox';

const url = (input: string) => {
  const r = resolveInput(input);
  return r && r.kind === 'url' ? r.url : null;
};
const isSearch = (input: string) => resolveInput(input)?.kind === 'search';

describe('resolveInput: URLs', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/path?q=1', 'http://example.com/path?q=1'],
    ['example.com', 'https://example.com/'],
    ['www.example.com/a/b', 'https://www.example.com/a/b'],
    ['sub.dominio.com.ar', 'https://sub.dominio.com.ar/'],
    ['  example.com  ', 'https://example.com/'],
    ['localhost', 'http://localhost/'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['192.168.0.1', 'http://192.168.0.1/'],
    ['[::1]:5000', 'http://[::1]:5000/'],
    ['intranet/wiki', 'http://intranet/wiki'],
    ['servidor:8080', 'http://servidor:8080/'],
    ['about:blank', 'about:blank'],
    ['C:\\Users\\ana\\doc.html', 'file:///C:/Users/ana/doc.html'],
    ['file:///C:/temp/a.html', 'file:///C:/temp/a.html'],
    ['xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
    ['archivo.zip', 'https://archivo.zip/'],
  ])('%s -> %s', (input, expected) => {
    expect(url(input)).toBe(expected);
  });

  it('marca como "https elegido por Callisto" solo los dominios sin esquema', () => {
    expect(resolveInput('example.com')).toMatchObject({ kind: 'url', upgradedToHttps: true });
    expect(resolveInput('https://example.com')).toMatchObject({ kind: 'url', upgradedToHttps: false });
    expect(resolveInput('http://example.com')).toMatchObject({ kind: 'url', upgradedToHttps: false });
    expect(resolveInput('localhost:3000')).toMatchObject({ kind: 'url', upgradedToHttps: false });
  });
});

describe('resolveInput: búsquedas', () => {
  it.each([
    'hola mundo',
    'clima',
    'informe.pdf',
    'index.html',
    'qué es callisto',
    '¿cómo hacer pan?',
    'example .com',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'chrome://settings',
    'view-source:https://example.com',
    'vbscript:msgbox',
    '3.14',
  ])('%s es búsqueda', (input) => {
    expect(isSearch(input)).toBe(true);
  });

  it('codifica la consulta', () => {
    expect(resolveInput('hola mundo & más')).toEqual({
      kind: 'search',
      query: 'hola mundo & más',
      url: 'https://www.google.com/search?q=hola+mundo+%26+m%C3%A1s',
    });
  });

  it('usa la plantilla indicada', () => {
    expect(searchUrl('a b', 'https://www.bing.com/search?q=%s')).toBe('https://www.bing.com/search?q=a+b');
  });

  it('entrada vacía no hace nada', () => {
    expect(resolveInput('   ')).toBeNull();
  });
});

describe('displayUrl', () => {
  it('oculta about:blank', () => {
    expect(displayUrl('about:blank')).toBe('');
    expect(displayUrl('')).toBe('');
  });
  it('muestra la URL completa (incluido el esquema)', () => {
    expect(displayUrl('http://example.com/')).toBe('http://example.com/');
  });
});
