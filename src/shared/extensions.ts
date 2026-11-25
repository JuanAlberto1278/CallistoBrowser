// Extensiones (V0.10): tipos, APIs que faltan y textos de permisos. Lógica pura, compartida por el proceso
// principal, la interfaz y callisto://extensions. Ver docs/10-v0.10-extensiones.md.

export const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com';

export const isExtensionId = (v: unknown): v is string => typeof v === 'string' && /^[a-p]{32}$/.test(v);

/** Manifiesto (lo que Callisto usa de él). */
export interface ExtensionManifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  permissions?: unknown[];
  optional_permissions?: unknown[];
  host_permissions?: unknown[];
  content_scripts?: Array<{ matches?: unknown[] }>;
  action?: unknown;
  options_page?: string;
  options_ui?: { page?: string };
  homepage_url?: string;
  default_locale?: string;
  icons?: Record<string, string>;
}

// ---------------------------------------------------------------- compatibilidad

/**
 * APIs que una extensión puede pedir y que en Callisto NO están disponibles, con el motivo. Medido con la extensión
 * sonda (tests/fixtures/extensions/probe): el espacio de nombres no existe, o existe pero la llamada falla. Una prueba
 * end-to-end vuelve a medirlo y avisa si cambia. (1.4.2: historial, sesiones, búsqueda, borrar datos, identidad, MHTML,
 * proxy y pantallas pasaron a funcionar; 1.4.3: programas instalados, panel lateral y reglas según el contenido; ver
 * CALLISTO_APIS.)
 */
export const UNSUPPORTED_APIS: Record<string, string> = {
  contentSettings: 'cambiar permisos de sitios',
  debugger: 'depurar páginas',
  desktopCapture: 'capturar la pantalla',
  fontSettings: 'configuración de fuentes',
  gcm: 'mensajes push de Google (GCM)',
  readingList: 'lista de lectura',
  tabCapture: 'capturar pestañas',
  tts: 'texto a voz',
  ttsEngine: 'motor de texto a voz',
  webAuthenticationProxy: 'proxy de autenticación web',
};

/**
 * APIs que Chrome tampoco tiene en Windows (solo ChromeOS) o solo en sus versiones de prueba: una extensión para Windows
 * no las necesita, así que no se avisan ni cuentan como faltantes.
 */
export const NOT_ON_WINDOWS_APIS = [
  'certificateProvider',
  'documentScan',
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys',
  'fileBrowserHandler',
  'fileSystemProvider',
  'loginState',
  'platformKeys',
  'printing',
  'printingMetrics',
  'processes',
  'vpnProvider',
  'wallpaper',
] as const;

/** APIs que Callisto agrega sobre sus propios sistemas (no las trae Electron ni la librería). */
export const CALLISTO_APIS = ['bookmarks', 'tabGroups', 'history', 'sessions', 'search', 'browsingData', 'identity', 'identity.email', 'pageCapture', 'proxy', 'system.display', 'downloads', 'topSites', 'omnibox', 'nativeMessaging', 'sidePanel', 'declarativeContent', 'userScripts'] as const;

/** Permisos pedidos por la extensión que no están disponibles (los opcionales también cuentan). */
export function unsupportedPermissions(manifest: ExtensionManifest): Array<{ permission: string; what: string; optional: boolean }> {
  const list = (v: unknown[] | undefined) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  const out: Array<{ permission: string; what: string; optional: boolean }> = [];
  const seen = new Set<string>();
  for (const [perms, optional] of [
    [list(manifest.permissions), false],
    [list(manifest.optional_permissions), true],
  ] as const) {
    for (const p of perms) {
      const what = UNSUPPORTED_APIS[p];
      if (what && !seen.has(p)) {
        seen.add(p);
        out.push({ permission: p, what, optional });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- permisos en palabras

const ALL_SITES = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\/|https?:\/\/\*\/)$/;

/** Sitios a los que accede la extensión (permisos de host y scripts de contenido): 'all' o la lista de dominios. */
export function siteAccess(manifest: ExtensionManifest): 'all' | string[] {
  const patterns: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') patterns.push(v);
  };
  (manifest.host_permissions ?? []).forEach(push);
  for (const cs of manifest.content_scripts ?? []) (cs.matches ?? []).forEach(push);
  // MV2: los hosts iban en "permissions"
  for (const p of manifest.permissions ?? []) if (typeof p === 'string' && (p.includes('://') || p === '<all_urls>')) push(p);
  if (patterns.some((p) => ALL_SITES.test(p))) return 'all';
  const hosts = new Set<string>();
  for (const p of patterns) {
    const m = /^[a-z*]+:\/\/([^/]+)\//i.exec(p);
    if (m) hosts.add(m[1]!.replace(/^\*\./, ''));
  }
  return [...hosts].sort();
}

const PERMISSION_TEXT: Record<string, string> = {
  bookmarks: 'Leer y cambiar tus favoritos',
  clipboardRead: 'Leer lo que copiás y pegás',
  clipboardWrite: 'Modificar lo que copiás y pegás',
  contentSettings: 'Cambiar los permisos de los sitios (cookies, JavaScript, cámara, micrófono…)',
  debugger: 'Acceder al depurador de páginas',
  declarativeNetRequest: 'Bloquear contenido en cualquier página',
  declarativeNetRequestFeedback: 'Leer tu historial de navegación',
  desktopCapture: 'Capturar el contenido de tu pantalla',
  downloads: 'Administrar tus descargas',
  'downloads.open': 'Abrir archivos descargados',
  geolocation: 'Conocer tu ubicación',
  history: 'Leer y cambiar tu historial de navegación',
  'identity.email': 'Conocer tu dirección de correo',
  management: 'Administrar tus extensiones',
  nativeMessaging: 'Comunicarse con programas instalados en el equipo',
  notifications: 'Mostrar notificaciones',
  pageCapture: 'Leer y cambiar todos tus datos en los sitios que visitás',
  privacy: 'Cambiar tu configuración de privacidad',
  proxy: 'Leer y cambiar la configuración de red',
  sessions: 'Leer tu historial de navegación',
  'system.storage': 'Ver y quitar unidades de almacenamiento',
  tabCapture: 'Capturar el contenido de tus pestañas',
  tabGroups: 'Ver y administrar tus grupos de pestañas',
  tabs: 'Leer tu historial de navegación',
  topSites: 'Leer la lista de los sitios que más visitás',
  ttsEngine: 'Leer todo lo que se dice con voz sintetizada',
  webNavigation: 'Leer tu historial de navegación',
  webAuthenticationProxy: 'Leer y cambiar tus inicios de sesión con llaves de acceso',
};

/** Lo que la extensión va a poder hacer, en palabras (como las advertencias de Chrome), sin repetir. */
export function permissionWarnings(manifest: ExtensionManifest): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (!out.includes(t)) out.push(t);
  };
  const sites = siteAccess(manifest);
  if (sites === 'all') add('Leer y cambiar todos tus datos en todos los sitios web');
  else if (sites.length === 1) add(`Leer y cambiar tus datos en ${sites[0]}`);
  else if (sites.length > 1 && sites.length <= 4) add(`Leer y cambiar tus datos en ${sites.slice(0, -1).join(', ')} y ${sites[sites.length - 1]}`);
  else if (sites.length > 4) add(`Leer y cambiar tus datos en ${sites.length} sitios`);
  // Con acceso a todos los sitios, "historial" ya está incluido (Chrome tampoco lo repite)
  for (const p of manifest.permissions ?? []) {
    if (typeof p !== 'string') continue;
    const t = PERMISSION_TEXT[p];
    if (!t) continue;
    if (sites === 'all' && t === 'Leer tu historial de navegación') continue;
    add(t);
  }
  return out;
}

// ---------------------------------------------------------------- estado para la interfaz y la página

/** Pedido de confirmación antes de instalar (lo muestra la interfaz de la ventana desde la que se pidió). */
export interface ExtensionInstallPrompt {
  id: number;
  extensionId: string;
  name: string;
  /** Ícono como URL data: (o null). */
  icon: string | null;
  warnings: string[];
  unsupported: Array<{ permission: string; what: string; optional: boolean }>;
  /** Ya estaba instalada pero desactivada: se vuelve a activar. */
  reenable: boolean;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** Cargada en este momento (activada y sin error). */
  loaded: boolean;
  /** Error al cargarla (si lo hubo). */
  error: string | null;
  icon: string | null;
  warnings: string[];
  unsupported: Array<{ permission: string; what: string; optional: boolean }>;
  /** Scripts de usuario (1.4.4): null si la extensión no los pide; si los pide, si el usuario los permitió. */
  userScripts: { allowed: boolean } | null;
  hasOptions: boolean;
  storeUrl: string;
  installed: number;
  updated: number;
}

/** Nombre traducido "__MSG_clave__" con los mensajes de la extensión (_locales). */
export function localizedText(text: string | undefined, messages: Record<string, { message?: string }> | null): string {
  if (!text) return '';
  const m = /^__MSG_(\w+)__$/.exec(text);
  if (!m || !messages) return text;
  const key = m[1]!.toLowerCase();
  for (const [k, v] of Object.entries(messages)) if (k.toLowerCase() === key && typeof v?.message === 'string') return v.message;
  return text;
}
