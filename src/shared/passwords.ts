// Contraseñas (V0.9): tipos y lógica pura compartidos por el proceso principal, el preload de las páginas web y la
// interfaz. Ver docs/09-v0.9-contrasenas.md.

export const MAX_USERNAME_LENGTH = 1024;
export const MAX_PASSWORD_LENGTH = 4096;

/** 'ready': lista; 'unavailable': Windows no ofrece cifrado; 'unreadable': la clave guardada no se puede descifrar. */
export type VaultStatus = 'ready' | 'unavailable' | 'unreadable';

export interface LoginSummary {
  id: number;
  /** Sitio exacto: esquema, dominio y puerto (https://cuenta.ejemplo.com). */
  origin: string;
  username: string;
  created: number;
  updated: number;
  lastUsed: number | null;
  timesUsed: number;
}

/** Sitio de una credencial: solo orígenes http(s) completos, sin ruta. */
export function isLoginOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length > 2048) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin;
  } catch {
    return false;
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Oferta de guardar (o actualizar) lo que el usuario acaba de enviar en un formulario. Sin la contraseña. */
export interface PasswordOffer {
  id: number;
  mode: 'save' | 'update';
  origin: string;
  username: string;
  /** Cantidad de caracteres (para mostrar puntos), nunca la contraseña. */
  passwordLength: number;
}

/** Sugerencia del menú de autocompletar. */
export interface AutofillItem {
  id: number;
  username: string;
  host: string;
}

export interface AutofillPopupState {
  items: AutofillItem[];
  selected: number;
  /** Colores de la interfaz según el tema (null = los de la hoja de estilos). */
  theme: { vars: Record<string, string> | null; mode: 'light' | 'dark' };
}

/** Canales entre el preload de las páginas web y el proceso principal. El sitio lo decide el principal, no la página. */
export const PW_IPC = {
  // página -> principal
  focus: 'callisto-pw:focus',
  blur: 'callisto-pw:blur',
  select: 'callisto-pw:select',
  choose: 'callisto-pw:choose',
  submit: 'callisto-pw:submit',
  username: 'callisto-pw:username',
  gone: 'callisto-pw:gone',
  page: 'callisto-pw:page',
  // principal -> página
  popup: 'callisto-pw:popup',
  fill: 'callisto-pw:fill',
} as const;

/** Rectángulo de un campo, en píxeles CSS relativos a la ventana visible de la página. */
export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- heurísticas de formularios

/** Lo que el preload sabe de cada campo (sin depender del DOM, para probarlo). */
export interface FieldInfo {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  value: string;
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel']);

export function isTextLike(f: FieldInfo): boolean {
  const ac = f.autocomplete.toLowerCase();
  return TEXT_TYPES.has(f.type.toLowerCase()) && !ac.includes('one-time-code');
}

const USERNAME_HINT = /user|e-?mail|login|correo|usuario|account|cuenta|identifier|signin/i;

/** Campo de usuario por sí solo (p. ej. el primer paso de un inicio de sesión en dos pasos). */
export function isUsernameLike(f: FieldInfo): boolean {
  if (!isTextLike(f)) return false;
  const ac = f.autocomplete.toLowerCase();
  if (ac.includes('username') || ac.split(/\s+/).includes('email') || ac.includes('webauthn')) return true;
  if (f.type.toLowerCase() === 'email') return true;
  return USERNAME_HINT.test(f.name) || USERNAME_HINT.test(f.id);
}

/**
 * Qué contraseña guardar entre los campos de contraseña de un formulario (índices de `passwords`), o -1:
 * la marcada como nueva; en un cambio de contraseña (actual, nueva, repetida) la nueva; si no, la primera con valor.
 */
export function pickPasswordIndex(passwords: FieldInfo[]): number {
  const filled = passwords.map((p, i) => (p.value ? i : -1)).filter((i) => i >= 0);
  if (!filled.length) return -1;
  const fresh = filled.filter((i) => passwords[i]!.autocomplete.toLowerCase().includes('new-password'));
  if (fresh.length) return fresh[0]!;
  if (filled.length === 3 && passwords[filled[1]!]!.value === passwords[filled[2]!]!.value) return filled[1]!;
  return filled[0]!;
}

/**
 * Campo de usuario para la contraseña en la posición `passwordAt` de `fields` (todos los campos visibles del
 * formulario, en orden): el marcado como "username" si hay; si no, el último campo de texto antes de la contraseña.
 */
export function pickUsernameIndex(fields: FieldInfo[], passwordAt: number): number {
  const marked = fields.findIndex((f) => isTextLike(f) && f.autocomplete.toLowerCase().includes('username'));
  if (marked >= 0) return marked;
  for (let i = passwordAt - 1; i >= 0; i--) {
    const f = fields[i]!;
    if (f.type.toLowerCase() === 'password') continue;
    if (isTextLike(f)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- menú de sugerencias

export const AUTOFILL_ITEM_HEIGHT = 44;
export const AUTOFILL_FOOTER_HEIGHT = 36;
/** Margen transparente alrededor del menú (para la sombra). */
export const AUTOFILL_MARGIN = 6;
const AUTOFILL_MAX_VISIBLE = 5;
const AUTOFILL_MIN_WIDTH = 260;
const AUTOFILL_MAX_WIDTH = 420;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Dónde va el menú de sugerencias, en coordenadas de la ventana: debajo del campo (o arriba si no entra), dentro de la
 * ventana. `field` en píxeles CSS de la página; `zoom`, el de la página; `page`, el lugar de la página en la ventana.
 * null si el campo no está a la vista.
 */
export function autofillBounds(field: FieldRect, zoom: number, page: Box, window: { width: number; height: number }, count: number): Box | null {
  const fx = page.x + field.x * zoom;
  const fy = page.y + field.y * zoom;
  const fw = field.width * zoom;
  const fh = field.height * zoom;
  if (fy + fh <= page.y || fy >= page.y + page.height || fx + fw <= page.x || fx >= page.x + page.width) return null;
  const height = Math.min(count, AUTOFILL_MAX_VISIBLE) * AUTOFILL_ITEM_HEIGHT + AUTOFILL_FOOTER_HEIGHT + 2 * AUTOFILL_MARGIN + 2;
  const width = Math.min(Math.max(fw, AUTOFILL_MIN_WIDTH), AUTOFILL_MAX_WIDTH) + 2 * AUTOFILL_MARGIN;
  const below = fy + fh + 2 - AUTOFILL_MARGIN;
  const above = fy - 2 - height + AUTOFILL_MARGIN;
  const y = below + height <= window.height || above < page.y ? below : above;
  const x = Math.max(0, Math.min(fx - AUTOFILL_MARGIN, window.width - width));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
