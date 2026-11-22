import type { NetErrorInfo } from '../shared/net-errors';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Script que reemplaza el contenido de la página de error que Chromium ya cometió para la URL fallida.
 * Así la URL y el historial quedan como en un navegador convencional (no se agrega una entrada extra).
 */
export function errorPageScript(info: NetErrorInfo, failedUrl: string, code: number): string {
  const html = `
<style>
  :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { max-width: 560px; padding: 32px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  p { line-height: 1.5; margin: 0 0 12px; opacity: .85; }
  .url { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; opacity: .7; }
  .code { font-family: Consolas, monospace; font-size: 12px; opacity: .55; }
  button { margin-top: 12px; padding: 8px 18px; border-radius: 6px; border: 1px solid #0067c0; background: #0067c0; color: white; font: inherit; cursor: pointer; }
  .cert h1 { color: #c42b1c; }
</style>
<main class="${info.certificate ? 'cert' : ''}">
  <h1>${escapeHtml(info.title)}</h1>
  <p>${escapeHtml(info.detail)}</p>
  <p class="url">${escapeHtml(failedUrl)}</p>
  <p class="code">Código de error: ${code}</p>
  <button id="callisto-retry">Volver a intentar</button>
</main>`;
  return `(() => {
    document.title = ${JSON.stringify(info.title)};
    document.documentElement.innerHTML = ${JSON.stringify(html)};
    document.getElementById('callisto-retry').addEventListener('click', () => { location.href = ${JSON.stringify(failedUrl)}; });
  })();`;
}
