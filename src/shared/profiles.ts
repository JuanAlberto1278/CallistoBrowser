// Perfiles: tipos y lógica pura compartidos.

/** Colores para identificar cada perfil (avatar y franja de la ventana). */
export const PROFILE_COLORS = {
  blue: { name: 'Azul', hex: '#2f6fd6' },
  green: { name: 'Verde', hex: '#2e8b57' },
  purple: { name: 'Violeta', hex: '#7b4fc9' },
  orange: { name: 'Naranja', hex: '#d9731f' },
  pink: { name: 'Rosa', hex: '#c74b8f' },
  teal: { name: 'Turquesa', hex: '#1f8f9a' },
  red: { name: 'Rojo', hex: '#c8413a' },
  gray: { name: 'Gris', hex: '#6b7280' },
} as const;

export type ProfileColor = keyof typeof PROFILE_COLORS;
export const PROFILE_COLOR_IDS = Object.keys(PROFILE_COLORS) as ProfileColor[];

export interface ProfileInfo {
  id: string;
  name: string;
  color: ProfileColor;
  created: number;
}

/** Lo que la interfaz necesita saber del perfil de su ventana. */
export interface WindowProfile {
  id: string;
  name: string;
  color: ProfileColor;
  /** Ventana privada (efímera). */
  private: boolean;
  /** Hay más de un perfil (para mostrar el nombre en la ventana). */
  several: boolean;
}

export const MAX_PROFILE_NAME = 40;

/** Nombre de perfil: sin espacios de más, sin caracteres de control, acotado. */
export function sanitizeProfileName(raw: unknown, fallback = 'Perfil'): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  return (name || fallback).slice(0, MAX_PROFILE_NAME);
}

export function isProfileColor(v: unknown): v is ProfileColor {
  return typeof v === 'string' && v in PROFILE_COLORS;
}

/** Id de perfil válido (se usa en nombres de carpetas y particiones: solo letras, números y guiones). */
export function isProfileId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v);
}
