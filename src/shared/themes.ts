// Temas (V1.0): los predeterminados, los propios del usuario y cómo se traducen a las variables CSS de la interfaz y de
// las páginas internas. Lógica pura, compartida por el proceso principal, la interfaz y la configuración.
//
// Un tema son 6 colores base y un modo (claro u oscuro). El resto (hover, bordes de pestañas, texto secundario…) se
// deriva. "Sistema" no define colores: la interfaz usa los de su hoja de estilos y sigue el modo de Windows.

export type ThemeMode = 'light' | 'dark';

export interface ThemeColors {
  /** Fondo de la franja de pestañas. */
  strip: string;
  /** Barra de herramientas y pestaña activa. */
  toolbar: string;
  /** Texto e íconos. */
  text: string;
  /** Acento: foco, enlaces, botones principales. */
  accent: string;
  /** Barra de direcciones, campos y menús. */
  field: string;
  /** Bordes y separadores. */
  border: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  /** null = "Sistema" (colores de la hoja de estilos, modo de Windows). */
  colors: ThemeColors | null;
}

export const SYSTEM_THEME_ID = 'system';

export const PRESET_THEMES: Theme[] = [
  { id: SYSTEM_THEME_ID, name: 'Sistema', mode: 'light', colors: null },
  { id: 'light', name: 'Claro', mode: 'light', colors: { strip: '#e6e6e6', toolbar: '#f7f7f7', text: '#1b1b1b', accent: '#0067c0', field: '#ffffff', border: '#e3e3e3' } },
  { id: 'dark', name: 'Oscuro', mode: 'dark', colors: { strip: '#1f1f1f', toolbar: '#2b2b2b', text: '#f1f1f1', accent: '#4cc2ff', field: '#1f1f1f', border: '#3a3a3a' } },
  { id: 'midnight', name: 'Medianoche', mode: 'dark', colors: { strip: '#0f1626', toolbar: '#172036', text: '#e6ecff', accent: '#7aa2ff', field: '#0c1220', border: '#26314d' } },
  { id: 'graphite', name: 'Grafito', mode: 'dark', colors: { strip: '#18181b', toolbar: '#232326', text: '#ececec', accent: '#ffb454', field: '#141416', border: '#34343a' } },
  { id: 'night-forest', name: 'Bosque nocturno', mode: 'dark', colors: { strip: '#10201a', toolbar: '#16291f', text: '#e3f2e8', accent: '#4caf7a', field: '#0c1813', border: '#234233' } },
  { id: 'forest', name: 'Bosque', mode: 'light', colors: { strip: '#d7e8d5', toolbar: '#eef6ec', text: '#1e2e1c', accent: '#2e7d32', field: '#ffffff', border: '#cfe0cc' } },
  { id: 'ocean', name: 'Océano', mode: 'light', colors: { strip: '#d3e6f5', toolbar: '#edf5fc', text: '#0f2233', accent: '#0277bd', field: '#ffffff', border: '#c9dcec' } },
  { id: 'sunset', name: 'Atardecer', mode: 'light', colors: { strip: '#f7d9c4', toolbar: '#fdf0e6', text: '#3a2216', accent: '#d84b1f', field: '#ffffff', border: '#efd6c4' } },
  { id: 'lavender', name: 'Lavanda', mode: 'light', colors: { strip: '#e2d9f3', toolbar: '#f4effb', text: '#2a2140', accent: '#6f42e0', field: '#ffffff', border: '#ddd2ef' } },
  { id: 'rose', name: 'Rosa', mode: 'light', colors: { strip: '#f6d5e1', toolbar: '#fdeef3', text: '#3b1a27', accent: '#c2185b', field: '#ffffff', border: '#f0d3de' } },
];

export const MAX_CUSTOM_THEMES = 20;
export const MAX_THEME_NAME = 30;

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

const COLOR_KEYS: Array<keyof ThemeColors> = ['strip', 'toolbar', 'text', 'accent', 'field', 'border'];

/** Tema propio válido, o null. */
export function sanitizeCustomTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^custom-[a-z0-9]{1,24}$/.test(r.id)) return null;
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_THEME_NAME) : '';
  if (!name) return null;
  const mode: ThemeMode = r.mode === 'dark' ? 'dark' : 'light';
  const c = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  if (!COLOR_KEYS.every((k) => isHexColor(c[k]))) return null;
  const colors = Object.fromEntries(COLOR_KEYS.map((k) => [k, (c[k] as string).toLowerCase()])) as unknown as ThemeColors;
  return { id: r.id, name, mode, colors };
}

/** El tema con ese id entre los predeterminados y los propios (si no existe, "Sistema"). */
export function findTheme(id: string, custom: Theme[]): Theme {
  return PRESET_THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? PRESET_THEMES[0]!;
}

// ---------------------------------------------------------------- colores derivados

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** Mezcla `a` con `b` (t = cuánto de `b`). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
}

const alpha = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Luminancia relativa (WCAG). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** Texto legible sobre un color (blanco o casi negro). */
export const readableOn = (bg: string) => (contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111');

export interface ThemeVars {
  mode: ThemeMode;
  /** null = sin variables propias (tema "Sistema"). */
  ui: Record<string, string> | null;
  pages: Record<string, string> | null;
}

/** Variables CSS de la interfaz (styles.css) y de las páginas internas (pages.css) para un tema. */
export function themeVars(theme: Theme): ThemeVars {
  const c = theme.colors;
  if (!c) return { mode: theme.mode, ui: null, pages: null };
  const dark = theme.mode === 'dark';
  const muted = mix(c.text, c.toolbar, dark ? 0.32 : 0.4);
  const ui: Record<string, string> = {
    '--bg': c.toolbar,
    '--fg': c.text,
    '--muted': muted,
    '--hover': alpha(c.text, dark ? 0.08 : 0.06),
    '--active': alpha(c.text, dark ? 0.14 : 0.1),
    '--field': c.field,
    '--field-border': mix(c.border, c.text, dark ? 0.15 : 0.12),
    '--focus': c.accent,
    '--border': c.border,
    '--strip': c.strip,
    '--tab-hover': alpha(c.text, dark ? 0.06 : 0.05),
    '--tab-border': alpha(c.text, dark ? 0.14 : 0.12),
    '--ntp-bg': mix(c.toolbar, c.strip, 0.25),
    '--ntp-glow': mix(c.toolbar, c.accent, dark ? 0.18 : 0.12),
  };
  const pages: Record<string, string> = {
    '--bg': mix(c.toolbar, c.strip, 0.35),
    '--surface': c.field === c.toolbar ? mix(c.field, c.text, 0.04) : c.field,
    '--fg': c.text,
    '--muted': muted,
    '--border': c.border,
    '--hover': alpha(c.text, dark ? 0.06 : 0.05),
    '--active': alpha(c.text, dark ? 0.12 : 0.09),
    '--accent': c.accent,
    '--accent-fg': readableOn(c.accent),
    '--field-border': mix(c.border, c.text, dark ? 0.15 : 0.12),
  };
  return { mode: theme.mode, ui, pages };
}

/** Aplica las variables al documento (interfaz, páginas internas, menú de sugerencias). */
export function applyThemeVars(root: HTMLElement, vars: Record<string, string> | null, mode: ThemeMode | null): void {
  const prev = (root.dataset.themeVars ?? '').split(',').filter(Boolean);
  for (const k of prev) root.style.removeProperty(k);
  if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.themeVars = vars ? Object.keys(vars).join(',') : '';
  if (mode) root.style.colorScheme = mode;
  else root.style.removeProperty('color-scheme');
}

/** Botones de ventana de Windows (minimizar, maximizar, cerrar) sobre la franja de pestañas: fondo y símbolos. */
export function titleBarColors(theme: Theme, opts: { private: boolean; systemDark: boolean }): { color: string; symbolColor: string } {
  if (opts.private) return { color: '#1b1726', symbolColor: '#f1eefb' }; // los de las ventanas privadas (styles.css)
  if (theme.colors) return { color: theme.colors.strip, symbolColor: theme.colors.text };
  return opts.systemDark ? { color: '#1f1f1f', symbolColor: '#f1f1f1' } : { color: '#e6e6e6', symbolColor: '#1b1b1b' };
}
