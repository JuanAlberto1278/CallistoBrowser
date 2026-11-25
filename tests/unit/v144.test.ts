import { describe, expect, it } from 'vitest';
import { matchesGlob, matchesPattern, scriptMatches, validateUserScript, type RegisteredUserScript } from '../../src/main/extensions/user-scripts-core';
import { CALLISTO_APIS, UNSUPPORTED_APIS } from '../../src/shared/extensions';

describe('patrones de coincidencia de Chrome', () => {
  it('esquema, host (con subdominios) y ruta', () => {
    expect(matchesPattern('*://*.ejemplo.com/*', 'https://www.ejemplo.com/a')).toBe(true);
    expect(matchesPattern('*://*.ejemplo.com/*', 'https://ejemplo.com/')).toBe(true);
    expect(matchesPattern('*://*.ejemplo.com/*', 'https://noejemplo.com/')).toBe(false);
    expect(matchesPattern('*://ejemplo.com/*', 'ftp://ejemplo.com/')).toBe(false); // * = http o https
    expect(matchesPattern('https://ejemplo.com/compras/*', 'https://ejemplo.com/compras/x?y=1')).toBe(true);
    expect(matchesPattern('https://ejemplo.com/compras/*', 'https://ejemplo.com/ventas/')).toBe(false);
    expect(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:8080/page')).toBe(true); // sin puerto: cualquiera
    expect(matchesPattern('<all_urls>', 'https://a.com/')).toBe(true);
    expect(matchesPattern('<all_urls>', 'chrome-extension://abc/x.html')).toBe(false);
    expect(matchesPattern('file:///*', 'file:///C:/x.html')).toBe(true);
    expect(matchesPattern('no es un patrón', 'https://a.com/')).toBe(false);
    expect(matchesPattern('*://*/*', 'no es una url')).toBe(false);
  });

  it('comodines de los scripts (* y ?) sobre la dirección completa', () => {
    expect(matchesGlob('https://*.ejemplo.com/*', 'https://www.ejemplo.com/a')).toBe(true);
    expect(matchesGlob('*/foto?.jpg', 'https://a.com/foto1.jpg')).toBe(true);
    expect(matchesGlob('*/foto?.jpg', 'https://a.com/foto12.jpg')).toBe(false);
    expect(matchesGlob('https://a.com/(x)', 'https://a.com/(x)')).toBe(true); // los caracteres especiales son literales
  });
});

describe('qué scripts corren en una página', () => {
  const base: RegisteredUserScript = { id: 's', matches: ['*://*.ejemplo.com/*'], js: [{ code: '1' }] };
  it('matches, excludeMatches, includeGlobs, excludeGlobs y allFrames', () => {
    expect(scriptMatches(base, 'https://ejemplo.com/', true)).toBe(true);
    expect(scriptMatches(base, 'https://ejemplo.com/', false)).toBe(false); // un iframe, sin allFrames
    expect(scriptMatches({ ...base, allFrames: true }, 'https://ejemplo.com/', false)).toBe(true);
    expect(scriptMatches({ ...base, excludeMatches: ['*://*/privado*'] }, 'https://ejemplo.com/privado/1', true)).toBe(false);
    expect(scriptMatches({ ...base, includeGlobs: ['*/tienda/*'] }, 'https://ejemplo.com/blog/1', true)).toBe(false);
    expect(scriptMatches({ ...base, includeGlobs: ['*/tienda/*'] }, 'https://ejemplo.com/tienda/1', true)).toBe(true);
    expect(scriptMatches({ ...base, excludeGlobs: ['*?debug*'] }, 'https://ejemplo.com/?debug=1', true)).toBe(false);
    expect(scriptMatches(base, 'https://otro.com/', true)).toBe(false);
  });
});

describe('validación de chrome.userScripts.register / update', () => {
  it('lo válido, normalizado', () => {
    expect(validateUserScript({ id: 'a', matches: ['<all_urls>'], js: [{ code: 'x' }, { file: '/scripts/b.js' }], runAt: 'document_start', world: 'MAIN', allFrames: 1 })).toEqual({
      id: 'a',
      matches: ['<all_urls>'],
      js: [{ code: 'x' }, { file: 'scripts/b.js' }],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
    });
    expect(validateUserScript({ id: 'a', runAt: 'document_end' }, true)).toEqual({ id: 'a', runAt: 'document_end' }); // update: solo lo que trae
  });

  it('lo que no es válido, con los errores de Chrome', () => {
    expect(() => validateUserScript({ id: '_x', matches: ['<all_urls>'], js: [{ code: '1' }] })).toThrow('Invalid script id.');
    expect(() => validateUserScript({ id: 'x', js: [{ code: '1' }] })).toThrow("must specify 'matches'");
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'] })).toThrow('at least one js source');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [] })).toThrow('at least one js source');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [{ code: '1', file: 'a.js' }] })).toThrow('exactly one of "code" or "file"');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [{ file: '../fuera.js' }] })).toThrow('exactly one of "code" or "file"');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }], runAt: 'nunca' })).toThrow('Invalid runAt.');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }], world: 'ISOLATED' })).toThrow('Invalid world.');
    expect(() => validateUserScript({ id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }], worldId: '_reservado' })).toThrow('Invalid worldId.');
    expect(() => validateUserScript({ id: 'x', matches: 'no es lista', js: [{ code: '1' }] })).toThrow('Invalid matches.');
  });

  it('userScripts ya no falta', () => {
    expect(UNSUPPORTED_APIS.userScripts).toBeUndefined();
    expect(CALLISTO_APIS).toContain('userScripts');
  });
});
