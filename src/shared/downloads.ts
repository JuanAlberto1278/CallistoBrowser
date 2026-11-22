// Descargas: tipos compartidos y lógica pura (nombres de archivo, tipos peligrosos, formato de tamaños).

export type DownloadState =
  /** Autorizada: Callisto la está volviendo a pedir al sitio. */
  | 'starting'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'cancelled'
  /** Falló (red, servidor, disco…). */
  | 'interrupted'
  /** El sitio no permite volver a pedir el archivo (formulario, enlace de un solo uso): hay que volver a hacer clic. */
  | 'waiting_click';

export interface DownloadEntry {
  id: number;
  url: string;
  /** Sitio de origen para mostrar (ejemplo.com). */
  site: string;
  filename: string;
  path: string;
  state: DownloadState;
  receivedBytes: number;
  /** 0 = tamaño desconocido. */
  totalBytes: number;
  bytesPerSecond: number;
  canResume: boolean;
  error: string | null;
  startTime: number;
  /** El archivo sigue en disco (para "Abrir" / "Mostrar en la carpeta"). */
  exists: boolean;
}

/** Pedido de autorización: la descarga ya se canceló; nada se guarda hasta que el usuario decida. */
export interface DownloadPrompt {
  id: number;
  filename: string;
  site: string;
  totalBytes: number;
  mime: string;
  /** Tipo de archivo que puede ejecutar código. */
  dangerous: boolean;
  /** Carpeta donde se guardará con "Guardar". */
  folderName: string;
}

// ---------------------------------------------------------------- nombres de archivo

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Nombre de archivo válido en Windows a partir del que propone el sitio. */
export function sanitizeFileName(raw: string): string {
  let name = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '') // marcas de dirección de texto (ocultan la extensión real)
    .trim()
    .replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) name = 'descarga';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** "informe.pdf" → "informe (1).pdf", "informe (2).pdf"… hasta encontrar uno libre. */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

// Tipos que ejecutan código al abrirlos (Windows) — se muestran con advertencia, como en Chrome y Edge.
const DANGEROUS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'jar',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'lnk', 'url', 'reg', 'dll', 'sys', 'inf', 'application',
  'gadget', 'msp', 'mst', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'docm', 'xlsm', 'pptm', 'library-ms', 'search-ms', 'settingcontent-ms',
]);

export function isDangerousFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return name.includes('.') && DANGEROUS.has(ext);
}

// ---------------------------------------------------------------- formato

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 2 400 000 → "2,3 MB" (separador decimal en español). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 || v >= 100 ? 0 : 1;
  return `${v.toFixed(digits).replace('.', ',')} ${UNITS[u]}`;
}

/** Segundos restantes → "3 min", "45 s". */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

/** Sitio para mostrar a partir de la URL del archivo o de la página (blob: y data: usan la página). */
export function siteOf(url: string, pageUrl = ''): string {
  for (const u of [url, pageUrl]) {
    try {
      const parsed = new URL(u.startsWith('blob:') ? u.slice(5) : u);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.host;
      if (parsed.protocol === 'file:') return 'archivo local';
    } catch {
      /* siguiente */
    }
  }
  return 'esta página';
}
