import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------- servidor de pruebas local
export interface TestServer {
  base: string;
  close(): Promise<void>;
  releaseSlow(): void;
}

const page = (title: string, body = '') =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

export async function startServer(): Promise<TestServer> {
  let count = 0;
  const slowResponses: Array<() => void> = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const html = (s: string) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
    switch (url.pathname) {
      case '/page1':
        return html(page('Página 1', `
          <a id="to2" href="/page2">Ir a la página 2</a>
          <a id="blank" href="/page2" target="_blank">Página 2 en ventana nueva</a>
          <a id="download" href="/download">Descargar</a>
          <button id="popup" onclick="window.open('/page2', 'popup', 'width=500,height=400')">Popup</button>`));
      case '/page2':
        return html(page('Página 2'));
      case '/count':
        count += 1;
        return html(page(`Carga ${count}`));
      case '/slow':
        // No responde hasta que la prueba lo libere
        slowResponses.push(() => html(page('Lenta')));
        return;
      case '/download':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="callisto-prueba.bin"' });
        return res.end(Buffer.alloc(4096, 7));
      case '/echo-headers':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      default:
        res.writeHead(404);
        return res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    releaseSlow: () => slowResponses.splice(0).forEach((f) => f()),
    close: () => new Promise<void>((r) => { slowResponses.splice(0).forEach((f) => f()); server.closeAllConnections(); server.close(() => r()); }),
  };
}

// ---------------------------------------------------------------- arranque de Callisto
export interface Callisto {
  app: ElectronApplication;
  userData: string;
  ui: Page;
  tab: Page;
  close(): Promise<void>;
}

const isUi = (p: Page) => p.url().startsWith('callisto://ui/');

/** Interfaz y pestaña de la primera ventana (se crean en ese orden). */
async function firstWindowPages(app: ElectronApplication): Promise<{ ui: Page; tab: Page }> {
  await expectEventually(() => app.windows().some(isUi) && app.windows().some((p) => !isUi(p)));
  return { ui: app.windows().find(isUi)!, tab: app.windows().find((p) => !isUi(p))! };
}

/** Páginas web (no interfaz) cuya URL cumple la condición. */
export function webPages(app: ElectronApplication, match: (url: string) => boolean): Page[] {
  return app.windows().filter((p) => !isUi(p) && match(p.url()));
}

/** Cantidad de ventanas de Callisto abiertas. */
export function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
}

export async function expectEventually(cond: () => Promise<boolean> | boolean, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('condición no cumplida a tiempo');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function launchCallisto(extraArgs: string[] = [], userData?: string): Promise<Callisto> {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'callisto-e2e-'));
  const app = await electron.launch({
    args: [ROOT, ...extraArgs],
    cwd: ROOT,
    env: { ...process.env, CALLISTO_USER_DATA_DIR: dir, ELECTRON_RENDERER_URL: '' },
  });
  const { ui, tab } = await firstWindowPages(app);
  await ui.waitForLoadState('domcontentloaded');
  return {
    app,
    userData: dir,
    ui,
    tab,
    close: async () => {
      await app.close().catch(() => {});
      if (!userData) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Pulsa una tecla en la pestaña o en la interfaz de la primera ventana con `webContents.sendInputEvent`.
 * (Las teclas simuladas por Playwright vía CDP no pasan por 'before-input-event', que es donde Callisto
 * implementa sus atajos; `sendInputEvent` recorre el mismo camino que una tecla real.)
 */
export async function pressKey(app: ElectronApplication, target: 'tab' | 'ui', keyCode: string, modifiers: Array<'control' | 'alt' | 'shift'> = []): Promise<void> {
  await app.evaluate(({ BaseWindow }, { target, keyCode, modifiers }) => {
    const [tabView, uiView] = BaseWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
    const wc = (target === 'tab' ? tabView : uiView)!.webContents;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { target, keyCode, modifiers });
}

/** Puerto local sin ningún servidor escuchando (y que Chromium no bloquea). */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Escribe en la barra de direcciones y presiona Enter. */
export async function typeAddress(ui: Page, text: string): Promise<void> {
  const address = ui.getByTestId('address');
  await address.click();
  await address.fill(text);
  await address.press('Enter');
}

/** ¿Hay conexión a Internet? (para las pruebas que dependen de sitios reales) */
export async function online(): Promise<boolean> {
  try {
    const r = await fetch('https://example.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}
