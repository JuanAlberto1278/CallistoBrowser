// Actualizaciones de Callisto (V1.0): lógica pura (versiones y el latest.yml que publica electron-builder).

/** Repositorio de GitHub donde se publican las versiones (GitHub Releases). */
export const UPDATE_REPO = 'JuanAlberto1278/CallistoBrowser';

export const isSemver = (v: unknown): v is string => typeof v === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v);

/** -1, 0 o 1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface LatestYml {
  version: string;
  /** Nombre del instalador (asset del release). */
  path: string;
  /** SHA-512 del instalador, en base64 (lo calcula electron-builder). */
  sha512: string;
}

/** Lee el latest.yml de electron-builder (solo los campos que importan), o null si no es válido. */
export function parseLatestYml(text: string): LatestYml | null {
  const field = (name: string) => new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(text)?.[1];
  const version = field('version');
  const path = field('path');
  const sha512 = field('sha512');
  if (!isSemver(version) || !path || !/^Callisto-Setup-[\d.]+\.exe$/.test(path) || !sha512 || !/^[A-Za-z0-9+/]{80,}={0,2}$/.test(sha512)) return null;
  return { version, path, sha512 };
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: number }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };
