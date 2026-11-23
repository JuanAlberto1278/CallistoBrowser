import { net, protocol, type Session } from 'electron';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INTERNAL_PAGES } from '../shared/internal-pages';

export const INTERNAL_SCHEME = 'callisto';
export const UI_ORIGIN = `${INTERNAL_SCHEME}://ui`;

/** Debe llamarse antes de `app.whenReady()`. */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: INTERNAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // crx: íconos de las extensiones (los sirve electron-chrome-extensions en la sesión de la interfaz)
  "img-src 'self' data: crx:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Sirve la interfaz del navegador desde callisto://ui/ SOLO en la sesión interna de la interfaz.
 * Las sesiones de perfil (páginas web) no tienen este protocolo: una página no puede navegar a la interfaz.
 */
export function serveInternalUi(uiSession: Session, rendererDir: string): void {
  const root = resolve(rendererDir);
  uiSession.protocol.handle(INTERNAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'ui') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', UI_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
}

/**
 * Sirve las páginas internas (callisto://history/, callisto://settings/) SOLO en la sesión de las pestañas internas.
 * Cada página es su propio origen; solo se sirven su HTML y los recursos compilados (assets/).
 * En desarrollo (`devUrl`) se reenvía al servidor de Vite para tener recarga en caliente.
 */
export function serveInternalPages(internalSession: Session, rendererDir: string, devUrl?: string): void {
  const root = resolve(rendererDir);
  internalSession.protocol.handle(INTERNAL_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (!(INTERNAL_PAGES as readonly string[]).includes(url.host)) return new Response('Not found', { status: 404 });
    const path = decodeURIComponent(url.pathname);
    const relative = path === '/' || path === '' ? `${url.host}.html` : path.replace(/^\/+/, '');

    if (devUrl) {
      // Solo en desarrollo (no empaquetado): sin CSP estricta para que funcione el cliente de Vite
      return net.fetch(new URL(relative + url.search, devUrl.endsWith('/') ? devUrl : devUrl + '/').toString());
    }

    if (relative !== `${url.host}.html` && !relative.startsWith('assets/')) return new Response('Not found', { status: 404 });
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', UI_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
}
