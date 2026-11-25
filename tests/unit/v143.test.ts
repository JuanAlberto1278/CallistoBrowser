import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  encodeNativeMessage,
  isValidHostName,
  MAX_HOST_MESSAGE,
  NativeMessageReader,
  needsShell,
  parseHostManifest,
  parseRegDefault,
  registryKeys,
} from '../../src/main/extensions/native-messaging-core';
import { cssSelectorsOf, matchesPageState, matchesUrlFilter } from '../../src/main/extensions/api-helpers';
import { CALLISTO_APIS, UNSUPPORTED_APIS, unsupportedPermissions } from '../../src/shared/extensions';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

describe('programas instalados: manifiesto y nombre', () => {
  it('nombres válidos como en Chrome', () => {
    expect(isValidHostName('com.bitwarden.desktop')).toBe(true);
    expect(isValidHostName('org.keepassxc.keepassxc_browser')).toBe(true);
    expect(isValidHostName('Com.Mayusculas')).toBe(false);
    expect(isValidHostName('a..b')).toBe(false);
    expect(isValidHostName('a b')).toBe(false);
    expect(isValidHostName('..\\..\\x')).toBe(false);
    expect(isValidHostName(42)).toBe(false);
  });

  it('el manifiesto: ruta relativa a su carpeta, orígenes válidos, nombre y tipo correctos', () => {
    const file = join('C:\\', 'Programas', 'Host', 'host.json');
    const m = parseHostManifest({ name: 'com.x.y', description: 'Host', path: 'bin\\host.exe', type: 'stdio', allowed_origins: [ORIGIN, 'https://malo.com/', 'chrome-extension://corto/'] }, file, 'com.x.y');
    expect(m).toEqual({ name: 'com.x.y', description: 'Host', path: join('C:\\', 'Programas', 'Host', 'bin', 'host.exe'), allowedOrigins: [ORIGIN] });
    expect(parseHostManifest({ name: 'com.x.y', path: 'C:\\h.exe', type: 'stdio', allowed_origins: [] }, file, 'com.x.y')!.path).toBe('C:\\h.exe');
    expect(parseHostManifest({ name: 'otro', path: 'h.exe', type: 'stdio', allowed_origins: [] }, file, 'com.x.y')).toBeNull();
    expect(parseHostManifest({ name: 'com.x.y', path: 'h.exe', type: 'socket', allowed_origins: [] }, file, 'com.x.y')).toBeNull();
    expect(parseHostManifest({ name: 'com.x.y', path: 'h.exe', type: 'stdio' }, file, 'com.x.y')).toBeNull();
    expect(parseHostManifest(null, file, 'com.x.y')).toBeNull();
  });

  it('dónde se busca en el registro (Chrome y Edge, usuario y equipo) y cómo se lee', () => {
    expect(registryKeys('com.x')).toEqual([
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.x',
      'HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.x',
      'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.x',
      'HKLM\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.x',
    ]);
    expect(parseRegDefault('\r\nHKEY_CURRENT_USER\\Software\\X\r\n    (Predeterminado)    REG_SZ    C:\\Archivos de programa\\X\\host.json\r\n')).toBe('C:\\Archivos de programa\\X\\host.json');
    expect(parseRegDefault('    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\x.json')).toBe('%LOCALAPPDATA%\\x.json');
    expect(parseRegDefault('ERROR: no se encuentra')).toBeNull();
    expect(needsShell('C:\\x\\host.BAT')).toBe(true);
    expect(needsShell('C:\\x\\host.exe')).toBe(false);
  });
});

describe('programas instalados: mensajes', () => {
  it('el largo es en bytes UTF-8, no en caracteres', () => {
    const buf = encodeNativeMessage({ t: 'ñ🌎' });
    const json = '{"t":"ñ🌎"}';
    expect(buf.readUInt32LE(0)).toBe(Buffer.byteLength(json));
    expect(buf.readUInt32LE(0)).toBeGreaterThan(json.length);
    expect(buf.subarray(4).toString('utf8')).toBe(json);
  });

  it('lee mensajes partidos y varios juntos', () => {
    const r = new NativeMessageReader();
    const a = encodeNativeMessage({ n: 1, s: 'ñandú' });
    const b = encodeNativeMessage({ n: 2 });
    const all = Buffer.concat([a, b]);
    expect(r.feed(all.subarray(0, 3))).toEqual([]); // ni el largo completo
    expect(r.feed(all.subarray(3, a.length - 2))).toEqual([]);
    expect(r.feed(all.subarray(a.length - 2))).toEqual([{ n: 1, s: 'ñandú' }, { n: 2 }]);
    expect(r.error).toBeNull();
  });

  it('un mensaje de más de 1 MB o que no es JSON corta la comunicación', () => {
    const big = new NativeMessageReader();
    const head = Buffer.alloc(4);
    head.writeUInt32LE(MAX_HOST_MESSAGE + 1, 0);
    expect(big.feed(head)).toEqual([]);
    expect(big.error).toMatch(/native messaging host/);
    const bad = new NativeMessageReader();
    const body = Buffer.from('{no es json');
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length, 0);
    bad.feed(Buffer.concat([h, body]));
    expect(bad.error).not.toBeNull();
    expect(bad.feed(encodeNativeMessage({ x: 1 }))).toEqual([]); // ya no se lee más
  });
});

describe('reglas según el contenido de la página', () => {
  const url = 'https://www.ejemplo.com:8443/compras/carrito?item=3&ok=1';
  it('filtros de dirección (todas las condiciones juntas)', () => {
    expect(matchesUrlFilter(url, { hostEquals: 'www.ejemplo.com' })).toBe(true);
    expect(matchesUrlFilter(url, { hostSuffix: 'ejemplo.com', pathPrefix: '/compras' })).toBe(true);
    expect(matchesUrlFilter(url, { hostSuffix: 'ejemplo.com', pathPrefix: '/ventas' })).toBe(false);
    expect(matchesUrlFilter(url, { hostContains: '.ejemplo.' })).toBe(true);
    expect(matchesUrlFilter(url, { queryContains: 'item=3' })).toBe(true);
    expect(matchesUrlFilter(url, { urlMatches: 'carrito\\?item=\\d' })).toBe(true);
    expect(matchesUrlFilter(url, { urlMatches: '(' })).toBe(false);
    expect(matchesUrlFilter(url, { schemes: ['https'], ports: [[8000, 9000]] })).toBe(true);
    expect(matchesUrlFilter(url, { ports: [443] })).toBe(false);
    expect(matchesUrlFilter('https://a.com/', { ports: [443] })).toBe(true);
    expect(matchesUrlFilter('no es una url', { hostEquals: 'a' })).toBe(false);
    expect(matchesUrlFilter(url, {})).toBe(true);
  });

  it('PageStateMatcher: dirección, CSS encontrado y favorito', () => {
    const page = { url, css: new Set(['input[type=password]']), bookmarked: false };
    const m = (props: object) => ({ instanceType: 'declarativeContent.PageStateMatcher', ...props });
    expect(matchesPageState(m({ pageUrl: { hostSuffix: 'ejemplo.com' }, css: ['input[type=password]'] }), page)).toBe(true);
    expect(matchesPageState(m({ css: ['video'] }), page)).toBe(false);
    expect(matchesPageState(m({ isBookmarked: true }), page)).toBe(false);
    expect(matchesPageState(m({ isBookmarked: false }), page)).toBe(true);
    expect(matchesPageState({ pageUrl: {} }, page)).toBe(false); // sin su tipo
    expect(cssSelectorsOf([{ conditions: [m({ css: ['a', 'b'] }), m({ css: ['a'] })] }, { conditions: [] }])).toEqual(['a', 'b']);
  });
});

describe('APIs que faltan (1.4.3)', () => {
  it('panel lateral, programas instalados y reglas según el contenido ya no faltan', () => {
    for (const p of ['sidePanel', 'nativeMessaging', 'declarativeContent']) {
      expect(UNSUPPORTED_APIS[p], p).toBeUndefined();
      expect(CALLISTO_APIS).toContain(p);
    }
    expect(unsupportedPermissions({ permissions: ['sidePanel', 'nativeMessaging', 'declarativeContent', 'debugger'] })).toEqual([{ permission: 'debugger', what: 'depurar páginas', optional: false }]);
  });
});
