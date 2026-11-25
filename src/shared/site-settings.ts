// Ajustes por sitio (1.5, bloque 3 de la 2.0): además de los permisos que se preguntan (cámara, micrófono, ubicación,
// notificaciones), sonido, ventanas emergentes, JavaScript e imágenes. Se guardan por origen (https://sitio:puerto),
// como los permisos, y solo cuando difieren del valor por defecto. Lógica pura (proceso principal, interfaz y pruebas).

export type SiteContentKind = 'sound' | 'popups' | 'javascript' | 'images';
export type SitePromptKind = 'camera' | 'microphone' | 'geolocation' | 'notifications';
export type SiteSettingKind = SitePromptKind | SiteContentKind;

export const SITE_CONTENT_KINDS: readonly SiteContentKind[] = ['sound', 'popups', 'javascript', 'images'];
export const SITE_PROMPT_KINDS: readonly SitePromptKind[] = ['camera', 'microphone', 'geolocation', 'notifications'];

/** Valor por defecto de cada ajuste (sin excepción guardada). Las ventanas emergentes: solo con un clic del usuario. */
export const SITE_CONTENT_DEFAULTS: Record<SiteContentKind, 'allow' | 'block'> = {
  sound: 'allow',
  popups: 'block',
  javascript: 'allow',
  images: 'allow',
};

export const SITE_SETTING_LABELS: Record<SiteSettingKind, string> = {
  camera: 'Cámara',
  microphone: 'Micrófono',
  geolocation: 'Ubicación',
  notifications: 'Notificaciones',
  sound: 'Sonido',
  popups: 'Ventanas emergentes',
  javascript: 'JavaScript',
  images: 'Imágenes',
};

export const isSiteSettingKind = (v: unknown): v is SiteSettingKind => typeof v === 'string' && ((SITE_CONTENT_KINDS as readonly string[]).includes(v) || (SITE_PROMPT_KINDS as readonly string[]).includes(v));

/** ¿El navegador le envía al sitio `host` una cookie del dominio `domain`? (".ejemplo.com" vale para sus subdominios) */
export function cookieAppliesTo(domain: string | undefined, host: string): boolean {
  if (!domain) return false;
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return !!d && (h === d || h.endsWith('.' + d));
}

/** ¿Una ventana que abre la página cuenta como pedida por el usuario? (Chrome: activación de los últimos 5 segundos) */
export const USER_ACTIVATION_MS = 5000;
export function popupAllowed(setting: 'allow' | 'block', lastActivation: number, now: number): boolean {
  return setting === 'allow' || now - lastActivation <= USER_ACTIVATION_MS;
}
