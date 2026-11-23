// Extensiones (V0.10): tipos, compatibilidad medida y textos de permisos. Lógica pura, compartida por el proceso
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
 * sonda (tests/fixtures/extensions/probe) en Electron 45.4.1 + electron-chrome-extensions 4.10.0: el espacio de nombres
 * no existe, o existe pero la llamada falla. Una prueba end-to-end vuelve a medirlo y avisa si cambia.
 */
export const UNSUPPORTED_APIS: Record<string, string> = {
  browsingData: 'borrar datos de navegación',
  certificateProvider: 'certificados de cliente',
  contentSettings: 'cambiar permisos de sitios',
  debugger: 'depurar páginas',
  declarativeContent: 'reglas según el contenido de la página',
  desktopCapture: 'capturar la pantalla',
  documentScan: 'escáneres',
  'enterprise.deviceAttributes': 'equipos administrados (ChromeOS)',
  'enterprise.hardwarePlatform': 'equipos administrados (ChromeOS)',
  'enterprise.networkingAttributes': 'equipos administrados (ChromeOS)',
  'enterprise.platformKeys': 'equipos administrados (ChromeOS)',
  fileBrowserHandler: 'archivos (ChromeOS)',
  fileSystemProvider: 'sistemas de archivos (ChromeOS)',
  fontSettings: 'configuración de fuentes',
  gcm: 'mensajes push de Google (GCM)',
  history: 'historial',
  identity: 'iniciar sesión con Google desde la extensión',
  'identity.email': 'iniciar sesión con Google desde la extensión',
  loginState: 'estado de sesión (ChromeOS)',
  nativeMessaging: 'comunicarse con programas instalados en Windows',
  pageCapture: 'guardar páginas como MHTML',
  platformKeys: 'certificados (ChromeOS)',
  printing: 'imprimir',
  printingMetrics: 'impresión (ChromeOS)',
  processes: 'procesos del navegador',
  proxy: 'configuración de proxy',
  readingList: 'lista de lectura',
  search: 'buscar con el buscador del navegador',
  sessions: 'pestañas cerradas recientemente',
  sidePanel: 'panel lateral',
  'system.display': 'información de pantallas',
  tabCapture: 'capturar pestañas',
  tts: 'texto a voz',
  ttsEngine: 'motor de texto a voz',
  userScripts: 'scripts de usuario',
  vpnProvider: 'VPN (ChromeOS)',
  wallpaper: 'fondo de pantalla (ChromeOS)',
  webAuthenticationProxy: 'proxy de autenticación web',
};

/** APIs que Callisto agrega sobre sus propios sistemas (no las trae Electron ni la librería). */
export const CALLISTO_APIS = ['bookmarks', 'tabGroups'] as const;

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

/**
 * Extensiones probadas de verdad en la V0.1 (instaladas desde la tienda, con pruebas funcionales), para mostrar en
 * callisto://extensions. Grammarly y OneTab cambian con la V0.10: OneTab ya tiene bookmarks y tabGroups.
 */
export const TESTED_EXTENSIONS: Array<{ id: string; name: string; status: 'ok' | 'partial' | 'broken'; note: string }> = [
  { id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite', status: 'ok', note: 'Bloquea anuncios y rastreadores.' },
  { id: 'bgnkhhnnamicmpeenaelnjfhikgbkllg', name: 'AdGuard AdBlocker', status: 'ok', note: 'Bloquea anuncios.' },
  { id: 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp', name: 'Privacy Badger', status: 'ok', note: 'Bloqueó 4 de 4 rastreadores de prueba.' },
  { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', status: 'ok', note: 'Aplica el tema oscuro (sin la opción de fuentes).' },
  { id: 'nffaoalbilbmmfgbnbgppjihopabppdk', name: 'Video Speed Controller', status: 'ok', note: 'Controlador sobre los videos.' },
  { id: 'bcjindcccaagfpapjjmafapmmgkkhgoa', name: 'JSON Formatter', status: 'ok', note: 'Formatea respuestas JSON.' },
  { id: 'fmkadmapgofadopljbjfkapdkoienihi', name: 'React Developer Tools', status: 'ok', note: 'Instala y abre; no se probó dentro de las herramientas de desarrollo.' },
  { id: 'aapbdbdomjkkjkaonfhkkikfgjllcleb', name: 'Google Translate', status: 'ok', note: 'Instala y abre su ventana.' },
  { id: 'gppongmhjkpfnbhagpmjfkannfbllamg', name: 'Wappalyzer', status: 'ok', note: 'Instala y abre su ventana.' },
  { id: 'gebbhagfogifgggkldgodflihgfeippi', name: 'Return YouTube Dislike', status: 'ok', note: 'Sin el inicio de sesión con Patreon/GitHub.' },
  { id: 'chphlpgkkbolifaimnlloiipkdnihall', name: 'OneTab', status: 'partial', note: 'Sin lista de lectura.' },
  { id: 'kbfnbcaeplbcioakkpcpgfkobkghlhen', name: 'Grammarly', status: 'partial', note: 'Se inyecta en las páginas; sin panel lateral ni inicio de sesión con Google.' },
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden', status: 'partial', note: 'Su ventana funciona; sin panel lateral.' },
  { id: 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', name: 'Google Docs Offline', status: 'partial', note: 'Instala; no se pudo comprobar el modo sin conexión.' },
  { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', name: '1Password', status: 'partial', note: 'Solo con cuenta en la nube: no se conecta con la app de escritorio.' },
  { id: 'dhdgffkkebhmkfjojejmpbldmpobfkfo', name: 'Tampermonkey', status: 'broken', note: 'No ejecuta scripts (requiere la API de scripts de usuario).' },
];

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
  /** Probada en la V0.1, si corresponde. */
  tested: { status: 'ok' | 'partial' | 'broken'; note: string } | null;
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
