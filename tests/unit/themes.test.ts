import { describe, expect, it } from 'vitest';
import { PRESET_THEMES, SYSTEM_THEME_ID, contrast, findTheme, mix, readableOn, sanitizeCustomTheme, themeVars } from '../../src/shared/themes';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/shared/settings';

const custom = { id: 'custom-abc', name: 'Mío', mode: 'dark', colors: { strip: '#101010', toolbar: '#202020', text: '#F0F0F0', accent: '#ff0080', field: '#151515', border: '#333333' } };

describe('temas', () => {
  it('"Sistema" y 10 temas predeterminados, con ids únicos y texto legible', () => {
    expect(PRESET_THEMES[0]!.id).toBe(SYSTEM_THEME_ID);
    expect(PRESET_THEMES.filter((t) => t.colors)).toHaveLength(10);
    expect(new Set(PRESET_THEMES.map((t) => t.id)).size).toBe(PRESET_THEMES.length);
    for (const t of PRESET_THEMES.filter((t) => t.colors)) {
      expect(contrast(t.colors!.text, t.colors!.toolbar), t.name).toBeGreaterThanOrEqual(7);
      expect(contrast(t.colors!.text, t.colors!.field), t.name).toBeGreaterThanOrEqual(7);
      expect(contrast(t.colors!.accent, t.colors!.toolbar), t.name).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('temas propios: válidos, normalizados, o descartados', () => {
    expect(sanitizeCustomTheme(custom)).toEqual({ ...custom, colors: { ...custom.colors, text: '#f0f0f0' } });
    expect(sanitizeCustomTheme({ ...custom, id: 'light' })).toBeNull(); // no puede pisar uno predeterminado
    expect(sanitizeCustomTheme({ ...custom, name: '   ' })).toBeNull();
    expect(sanitizeCustomTheme({ ...custom, colors: { ...custom.colors, accent: 'red' } })).toBeNull();
    expect(sanitizeCustomTheme({ ...custom, colors: { ...custom.colors, text: 'url(javascript:x)' } })).toBeNull();
    expect(sanitizeCustomTheme({ ...custom, name: 'x'.repeat(100) })!.name).toHaveLength(30);
  });

  it('en la configuración: el elegido tiene que existir; sin repetidos ni de más', () => {
    expect(DEFAULT_SETTINGS.theme).toBe(SYSTEM_THEME_ID);
    const s = sanitizeSettings({ theme: 'custom-abc', customThemes: [custom, custom, { basura: true }] });
    expect(s.theme).toBe('custom-abc');
    expect(s.customThemes).toHaveLength(1);
    expect(sanitizeSettings({ theme: 'custom-borrado', customThemes: [] }).theme).toBe(SYSTEM_THEME_ID);
    expect(sanitizeSettings({ theme: 'midnight' }).theme).toBe('midnight');
    const many = Array.from({ length: 30 }, (_, i) => ({ ...custom, id: `custom-${i}` }));
    expect(sanitizeSettings({ customThemes: many }).customThemes).toHaveLength(20);
    expect(findTheme('no-existe', []).id).toBe(SYSTEM_THEME_ID);
  });

  it('variables de la interfaz y de las páginas', () => {
    expect(themeVars(findTheme(SYSTEM_THEME_ID, [])).ui).toBeNull();
    const v = themeVars(sanitizeCustomTheme(custom)!);
    expect(v.mode).toBe('dark');
    expect(v.ui!['--strip']).toBe('#101010');
    expect(v.ui!['--focus']).toBe('#ff0080');
    expect(v.pages!['--accent']).toBe('#ff0080');
    expect(v.pages!['--accent-fg']).toBe(readableOn('#ff0080'));
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(readableOn('#ffffff')).toBe('#111111');
    expect(readableOn('#000000')).toBe('#ffffff');
  });
});
