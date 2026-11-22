import type { SitePermission } from './profile-store';

// Traducción de los permisos que pide Chromium a los permisos que Callisto le pregunta al usuario.

/** Se conceden sin preguntar (no exponen datos ni dispositivos del usuario). */
export const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

/**
 * Permisos que Callisto pregunta y recuerda por sitio, a partir del nombre de Electron y los detalles del pedido.
 * Devuelve null si es un permiso que Callisto no ofrece (se deniega).
 */
export function sitePermissionsFor(permission: string, mediaTypes?: ReadonlyArray<string>): SitePermission[] | null {
  switch (permission) {
    case 'media': {
      const kinds: SitePermission[] = [];
      if (mediaTypes?.includes('video')) kinds.push('camera');
      if (mediaTypes?.includes('audio')) kinds.push('microphone');
      return kinds.length ? kinds : null;
    }
    case 'geolocation':
      return ['geolocation'];
    case 'notifications':
      return ['notifications'];
    default:
      return null;
  }
}

/** Permiso para las consultas síncronas de Chromium (navigator.permissions.query, Notification.permission…). */
export function sitePermissionForCheck(permission: string, mediaType?: string): SitePermission | null {
  if (permission === 'media') return mediaType === 'video' ? 'camera' : mediaType === 'audio' ? 'microphone' : null;
  if (permission === 'geolocation' || permission === 'notifications') return permission;
  return null;
}

/** Origen web (https://sitio:puerto) de una URL; null si no es http(s). */
export function webOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

const PHRASES: Record<SitePermission, string> = {
  camera: 'usar tu cámara',
  microphone: 'usar tu micrófono',
  geolocation: 'conocer tu ubicación',
  notifications: 'mostrarte notificaciones',
};

/** "quiere usar tu cámara y usar tu micrófono" → "quiere usar tu cámara y tu micrófono". */
export function permissionPhrase(kinds: readonly SitePermission[]): string {
  if (kinds.includes('camera') && kinds.includes('microphone') && kinds.length === 2) return 'usar tu cámara y tu micrófono';
  const parts = kinds.map((k) => PHRASES[k]);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

export const PERMISSION_LABELS: Record<SitePermission, string> = {
  camera: 'Cámara',
  microphone: 'Micrófono',
  geolocation: 'Ubicación',
  notifications: 'Notificaciones',
};
