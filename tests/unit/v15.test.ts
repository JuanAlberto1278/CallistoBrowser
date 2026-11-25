import { describe, expect, it } from 'vitest';
import { cookieAppliesTo, isSiteSettingKind, popupAllowed, USER_ACTIVATION_MS } from '../../src/shared/site-settings';
import { DEFAULT_SETTINGS, hasClearOnExit, normalizePageAddress, sanitizeSettings } from '../../src/shared/settings';
import { MAX_SHORTCUTS, sanitizeShortcuts, saveShortcut, shortcutHost, shortcutTitle, type Shortcut } from '../../src/shared/shortcuts';
import { isContentSettingType, patternOrigins, validContentSetting } from '../../src/main/extensions/api-helpers';

describe('ajustes por sitio (1.5)', () => {
  it('ventanas emergentes: permitidas en el sitio, o con un clic del usuario reciente', () => {
    expect(popupAllowed('allow', 0, 1_000_000)).toBe(true);
    expect(popupAllowed('block', 0, 1_000_000)).toBe(false);
    expect(popupAllowed('block', 1_000_000 - USER_ACTIVATION_MS, 1_000_000)).toBe(true);
    expect(popupAllowed('block', 1_000_000 - USER_ACTIVATION_MS - 1, 1_000_000)).toBe(false);
  });

  it('borrar los datos de un sitio: las cookies que el navegador le envía', () => {
    expect(cookieAppliesTo('ejemplo.com', 'ejemplo.com')).toBe(true);
    expect(cookieAppliesTo('.ejemplo.com', 'www.ejemplo.com')).toBe(true);
    expect(cookieAppliesTo('ejemplo.com', 'otroejemplo.com')).toBe(false);
    expect(cookieAppliesTo('sub.ejemplo.com', 'ejemplo.com')).toBe(false);
    expect(cookieAppliesTo(undefined, 'ejemplo.com')).toBe(false);
  });

  it('tipos de ajuste conocidos', () => {
    for (const k of ['camera', 'microphone', 'geolocation', 'notifications', 'sound', 'popups', 'javascript', 'images']) expect(isSiteSettingKind(k)).toBe(true);
    expect(isSiteSettingKind('cookies')).toBe(false);
  });
});

describe('al abrir y cerrar Callisto (1.5)', () => {
  it('direcciones de páginas: completa https y rechaza lo que no es una dirección', () => {
    expect(normalizePageAddress('ejemplo.com')).toBe('https://ejemplo.com/');
    expect(normalizePageAddress('  https://ejemplo.com/inicio?a=1 ')).toBe('https://ejemplo.com/inicio?a=1');
    expect(normalizePageAddress('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(normalizePageAddress('localhost:3000')).toBe('https://localhost:3000/');
    expect(normalizePageAddress('no es una dirección')).toBeNull();
    expect(normalizePageAddress('palabra')).toBeNull();
    expect(normalizePageAddress('javascript:alert(1)')).toBeNull();
    expect(normalizePageAddress('file:///C:/x.html')).toBeNull();
    expect(normalizePageAddress('')).toBeNull();
  });

  it('configuración: páginas al iniciar y borrar al cerrar (apagado por defecto)', () => {
    expect(DEFAULT_SETTINGS.clearOnExit).toEqual({ history: false, siteData: false, cache: false });
    expect(hasClearOnExit(DEFAULT_SETTINGS)).toBe(false);
    const s = sanitizeSettings({ startup: 'pages', startupPages: ['ejemplo.com', 'ejemplo.com', 'nada', 42], clearOnExit: { cache: true, history: 'sí' } });
    expect(s.startup).toBe('pages');
    expect(s.startupPages).toEqual(['https://ejemplo.com/']);
    expect(s.clearOnExit).toEqual({ history: false, siteData: false, cache: true });
    expect(hasClearOnExit(s)).toBe(true);
    expect(sanitizeSettings({ startup: 'otra' }).startup).toBe('restore');
    expect(sanitizeSettings({ startupPages: Array.from({ length: 30 }, (_, i) => `s${i}.com`) }).startupPages).toHaveLength(20);
  });
});

describe('accesos directos de la nueva pestaña (1.5)', () => {
  let n = 0;
  const id = () => `id-${++n}`;

  it('agregar, editar y los motivos por los que no se puede', () => {
    let list: Shortcut[] = [];
    const added = saveShortcut(list, null, '', 'ejemplo.com', id);
    expect(added).toEqual([{ id: 'id-1', title: 'ejemplo.com', url: 'https://ejemplo.com/' }]);
    list = added as Shortcut[];
    expect(saveShortcut(list, null, 'Otro', 'https://ejemplo.com/', id)).toBe('duplicate');
    expect(saveShortcut(list, null, 'Mal', 'no es', id)).toBe('invalid-url');
    expect(saveShortcut(list, 'no-existe', 'X', 'x.com', id)).toBe('not-found');
    const edited = saveShortcut(list, 'id-1', 'Mi sitio', 'ejemplo.com/inicio', id) as Shortcut[];
    expect(edited).toEqual([{ id: 'id-1', title: 'Mi sitio', url: 'https://ejemplo.com/inicio' }]);
    // Editar sin cambiar la dirección no cuenta como repetida
    expect(saveShortcut(edited, 'id-1', 'Otro nombre', 'https://ejemplo.com/inicio', id)).not.toBe('duplicate');
    const full = Array.from({ length: MAX_SHORTCUTS }, (_, i) => ({ id: `f${i}`, title: `S${i}`, url: `https://s${i}.com/` }));
    expect(saveShortcut(full, null, 'Uno más', 'mas.com', id)).toBe('full');
  });

  it('lista guardada: sin repetidos ni basura', () => {
    expect(
      sanitizeShortcuts([
        { id: 'a', title: ' Correo ', url: 'https://mail.ejemplo.com/' },
        { id: 'a', title: 'Repetido', url: 'https://otro.com/' },
        { id: 'b', title: 'Misma dirección', url: 'https://mail.ejemplo.com/' },
        { id: 'c', title: 'Mala', url: 'javascript:alert(1)' },
        { id: 'd con espacios', title: 'x', url: 'https://x.com/' },
        null,
      ]),
    ).toEqual([{ id: 'a', title: 'Correo', url: 'https://mail.ejemplo.com/' }]);
    expect(sanitizeShortcuts('nada')).toEqual([]);
    expect(shortcutTitle('', 'https://www.ejemplo.com/a')).toBe('ejemplo.com');
    expect(shortcutHost('https://www.Ejemplo.com/a')).toBe('ejemplo.com');
  });
});

describe('chrome.contentSettings (1.5)', () => {
  it('patrones: solo sitios exactos', () => {
    expect(patternOrigins('https://ejemplo.com/*')).toEqual(['https://ejemplo.com']);
    expect(patternOrigins('*://ejemplo.com/*')).toEqual(['https://ejemplo.com', 'http://ejemplo.com']);
    expect(patternOrigins('http://127.0.0.1:8080/*')).toEqual(['http://127.0.0.1:8080']);
    expect(patternOrigins('https://ejemplo.com:*/*')).toEqual(['https://ejemplo.com']);
    expect(patternOrigins('https://*.ejemplo.com/*')).toBeNull();
    expect(patternOrigins('https://[*.]ejemplo.com/*')).toBeNull();
    expect(patternOrigins('<all_urls>')).toBeNull();
    expect(patternOrigins('ftp://ejemplo.com/*')).toBeNull();
    expect(patternOrigins(42)).toBeNull();
  });

  it('tipos y valores', () => {
    expect(isContentSettingType('javascript')).toBe(true);
    expect(isContentSettingType('cookies')).toBe(true);
    expect(isContentSettingType('toString')).toBe(false);
    expect(validContentSetting('camera', 'ask')).toBe(true);
    expect(validContentSetting('javascript', 'ask')).toBe(false);
    expect(validContentSetting('javascript', 'block')).toBe(true);
    expect(validContentSetting('images', 'session_only')).toBe(false);
  });
});
