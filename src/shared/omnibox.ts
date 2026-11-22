// Interpretación de lo que el usuario escribe en la barra de direcciones: ¿URL o búsqueda?
// Lógica pura (sin Electron) para poder probarla con tests unitarios.

import { internalPageOf, internalUrl } from './internal-pages';

export const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

export type ResolvedInput =
  | { kind: 'url'; url: string; /** https elegido por Callisto (no escrito): se puede reintentar con http si falla la conexión */ upgradedToHttps: boolean }
  | { kind: 'search'; url: string; query: string }
  /** Página interna de Callisto (historial, configuración): se abre en una pestaña interna, nunca con la sesión web. */
  | { kind: 'internal'; url: string };

const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'file:']);

// Extensiones de archivo habituales que NO son dominios de primer nivel: "informe.pdf" es una búsqueda, no un sitio.
// (".zip" y ".mov" sí son dominios reales, por eso no están.)
const FILE_EXTENSIONS = new Set([
  'html', 'htm', 'pdf', 'txt', 'exe', 'msi', 'js', 'ts', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'md', 'mp3', 'mp4', 'wav', 'avi', 'mkv', 'iso', 'dll', 'bat', 'cmd', 'ps1', 'py', 'java', 'cpp', 'h', 'css',
]);

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

export function searchUrl(query: string, template = DEFAULT_SEARCH_TEMPLATE): string {
  return template.replace('%s', encodeURIComponent(query).replace(/%20/g, '+'));
}

function search(query: string, template: string): ResolvedInput {
  return { kind: 'search', url: searchUrl(query, template), query };
}

function isPlausibleHost(hostname: string): boolean {
  if (hostname === 'localhost' || IPV4.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'))) return true;
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return false;
  const tld = labels[labels.length - 1]!.toLowerCase();
  return TLD.test(tld) && !FILE_EXTENSIONS.has(tld);
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || IPV4.test(hostname) || hostname.startsWith('[');
}

export function resolveInput(raw: string, template = DEFAULT_SEARCH_TEMPLATE): ResolvedInput | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase() === 'about:blank') return { kind: 'url', url: 'about:blank', upgradedToHttps: false };

  // Solo las páginas internas conocidas; cualquier otra dirección callisto:// (p. ej. la interfaz) es una búsqueda
  const page = internalPageOf(text);
  if (page && /^callisto:\/\/[a-z]+\/?$/i.test(text)) return { kind: 'internal', url: internalUrl(page) };

  // Ruta de Windows: C:\carpeta\archivo.html
  if (/^[a-zA-Z]:[\\/]/.test(text)) {
    return { kind: 'url', url: 'file:///' + text.replace(/\\/g, '/').split('/').map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join('/'), upgradedToHttps: false };
  }

  // URL con esquema explícito. Esquemas no navegables (javascript:, data:, chrome:, etc.) se tratan como búsqueda.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) || /^(javascript|data|vbscript|blob|chrome|view-source|about):/i.test(text)) {
    try {
      const u = new URL(text);
      if (NAVIGABLE_SCHEMES.has(u.protocol) && (u.protocol === 'file:' || u.hostname)) return { kind: 'url', url: u.href, upgradedToHttps: false };
    } catch {
      /* no es una URL válida */
    }
    return search(text, template);
  }

  if (/\s/.test(text)) return search(text, template);

  // Sin esquema: "ejemplo.com", "localhost:3000/ruta", "192.168.0.1", "intranet/ruta"
  let u: URL;
  try {
    u = new URL('http://' + text);
  } catch {
    return search(text, template);
  }
  const host = u.hostname;
  // El estándar de URLs normaliza "3.14" a la IP 3.0.0.14: solo se acepta una IP escrita completa.
  const typedHost = text.split(/[/?#]/)[0]!.replace(/:\d*$/, '').toLowerCase();
  if (IPV4.test(host) && !IPV4.test(typedHost)) return search(text, template);
  if (isLocalHost(host)) return { kind: 'url', url: u.href, upgradedToHttps: false };
  if (isPlausibleHost(host)) {
    u.protocol = 'https:';
    return { kind: 'url', url: u.href, upgradedToHttps: true };
  }
  // Nombre de una sola palabra con puerto o ruta explícitos: probablemente un servidor de la red local
  if (!host.includes('.') && LABEL.test(host) && (u.port !== '' || text.includes('/'))) {
    return { kind: 'url', url: u.href, upgradedToHttps: false };
  }
  return search(text, template);
}

/** Texto que se muestra en la barra de direcciones para una URL ya cargada. */
export function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  return url;
}
