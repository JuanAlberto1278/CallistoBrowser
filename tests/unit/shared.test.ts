import { describe, expect, it } from 'vitest';
import { classifyUrl } from '../../src/shared/url-security';
import { buildUserAgent } from '../../src/shared/user-agent';
import { describeNetError } from '../../src/shared/net-errors';
import { matchShortcut } from '../../src/main/shortcuts';
import type { Input } from 'electron';

describe('classifyUrl', () => {
  it.each([
    ['https://example.com/', 'secure'],
    ['http://example.com/', 'insecure'],
    ['file:///C:/a.html', 'file'],
    ['about:blank', 'none'],
    ['', 'none'],
  ])('%s -> %s', (u, level) => {
    expect(classifyUrl(u)).toBe(level);
  });
  it('una carga fallida es "error" aunque sea https', () => {
    expect(classifyUrl('https://example.com/', true)).toBe('error');
  });
});

describe('buildUserAgent', () => {
  const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36';
  it('agrega el token Callisto y quita Electron', () => {
    expect(buildUserAgent(electron, '0.2.0')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Callisto/0.2.0 Chrome/156.0.8078.100 Safari/537.36',
    );
  });
  it('nunca produce un user-agent con forma de Chrome puro (Google lo rechaza)', () => {
    expect(buildUserAgent(electron, '0.2.0')).toMatch(/Callisto\/0\.2\.0 Chrome\//);
  });
  it('es idempotente', () => {
    const once = buildUserAgent(electron, '0.2.0');
    expect(buildUserAgent(once, '0.2.0')).toBe(once);
  });
});

describe('describeNetError', () => {
  it('los errores de certificado no permiten continuar', () => {
    expect(describeNetError(-202, 'ERR_CERT_AUTHORITY_INVALID')).toMatchObject({ certificate: true, title: 'La conexión no es privada' });
  });
  it('traduce errores conocidos', () => {
    expect(describeNetError(-105, 'ERR_NAME_NOT_RESOLVED').title).toBe('No se encontró el sitio');
  });
  it('incluye la descripción de Chromium si el error es desconocido', () => {
    expect(describeNetError(-999, 'ERR_RARO').detail).toContain('ERR_RARO');
  });
});

describe('matchShortcut', () => {
  const key = (k: string, mods: Partial<Input> = {}): Input =>
    ({ type: 'keyDown', key: k, code: '', isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [], ...mods }) as Input;
  const page = { fromPage: true, isLoading: false };

  it.each<[Input, string | null]>([
    [key('l', { control: true }), 'focus-address-bar'],
    [key('d', { alt: true }), 'focus-address-bar'],
    [key('F6'), 'focus-address-bar'],
    [key('ArrowLeft', { alt: true }), 'back'],
    [key('ArrowRight', { alt: true }), 'forward'],
    [key('F5'), 'reload'],
    [key('r', { control: true }), 'reload'],
    [key('F5', { control: true }), 'reload-ignore-cache'],
    [key('R', { control: true, shift: true }), 'reload-ignore-cache'],
    [key('F12'), 'devtools'],
    [key('w', { control: true }), 'close-tab'],
    [key('F4', { control: true }), 'close-tab'],
    [key('W', { control: true, shift: true }), 'close-window'],
    [key('t', { control: true }), 'new-tab'],
    [key('T', { control: true, shift: true }), 'reopen-closed-tab'],
    [key('n', { control: true }), 'new-window'],
    [key('K', { control: true, shift: true }), 'duplicate-tab'],
    [key('Tab', { control: true }), 'next-tab'],
    [key('Tab', { control: true, shift: true }), 'prev-tab'],
    [key('PageDown', { control: true }), 'next-tab'],
    [key('PageUp', { control: true }), 'prev-tab'],
    [key('1', { control: true, code: 'Digit1' }), 'select-tab-1'],
    [key('8', { control: true, code: 'Numpad8' }), 'select-tab-8'],
    [key('9', { control: true, code: 'Digit9' }), 'select-last-tab'],
    [key('&', { control: true, code: 'Digit1' }), 'select-tab-1'], // AZERTY: el dígito requiere Shift, vale la tecla física
    [key('f', { control: true }), 'find'],
    [key('F3'), 'find-next'],
    [key('F3', { shift: true }), 'find-prev'],
    [key('g', { control: true }), 'find-next'],
    [key('+', { control: true }), 'zoom-in'],
    [key('=', { control: true }), 'zoom-in'],
    [key('+', { control: true, code: 'NumpadAdd' }), 'zoom-in'],
    [key('-', { control: true }), 'zoom-out'],
    [key('0', { control: true, code: 'Digit0' }), 'zoom-reset'],
    [key('a'), null],
    [key('ArrowLeft'), null],
    [key('t'), null],
  ])('%o', (input, expected) => {
    expect(matchShortcut(input, page)).toBe(expected);
  });

  it('Esc detiene solo si viene de la página y hay una carga en curso', () => {
    expect(matchShortcut(key('Escape'), { fromPage: true, isLoading: true })).toBe('stop');
    expect(matchShortcut(key('Escape'), { fromPage: true, isLoading: false })).toBeNull();
    expect(matchShortcut(key('Escape'), { fromPage: false, isLoading: true })).toBeNull();
  });

  it('AltGr (Ctrl+Alt) nunca dispara atajos de Ctrl: en teclados en español escribe caracteres', () => {
    expect(matchShortcut(key('@', { control: true, alt: true, code: 'Digit2' }), page)).toBeNull();
    expect(matchShortcut(key('#', { control: true, alt: true, code: 'Digit3' }), page)).toBeNull();
    expect(matchShortcut(key('€', { control: true, alt: true, code: 'KeyE' }), page)).toBeNull();
    expect(matchShortcut(key('w', { control: true, alt: true }), page)).toBeNull();
  });

  it('ignora keyUp', () => {
    expect(matchShortcut({ ...key('F5'), type: 'keyUp' }, page)).toBeNull();
  });
});
