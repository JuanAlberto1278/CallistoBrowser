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

const page = (title: string, body = '', head = '') =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function icoWithPng(): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: ícono
  header.writeUInt16LE(1, 4); // una imagen
  header.writeUInt8(1, 6); // ancho
  header.writeUInt8(1, 7); // alto
  header.writeUInt16LE(1, 10); // planos
  header.writeUInt16LE(32, 12); // bits por píxel
  header.writeUInt32LE(PNG_1X1.length, 14);
  header.writeUInt32LE(22, 18); // posición de la imagen
  return Buffer.concat([header, PNG_1X1]);
}

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
          <button id="popup" onclick="window.open('/page2', 'popup', 'width=500,height=400')">Popup</button>
          <button id="opentab" onclick="window.open('/self-close')">Pestaña que se cierra sola</button>
          <input id="field" value="texto de prueba">`));
      case '/':
        return html(page('Inicio'));
      case '/page2':
        return html(page('Página 2'));
      case '/sw-page':
        // Página con un service worker que consulta permisos sin parar (como hacen sitios como Google)
        return html(page('Con service worker', `<script>navigator.serviceWorker.register('/sw.js'); setInterval(() => navigator.permissions.query({ name: 'geolocation' }), 5);</script>`));
      case '/sw.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end("self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); setInterval(() => navigator.permissions.query({ name: 'notifications' }), 5);");
      case '/page3':
        return html(page('Página 3'));
      case '/self-close':
        return html(page('Se cierra sola', '<button id="close" onclick="window.close()">Cerrar</button>'));
      case '/find':
        return html(page('Buscar', '<p>Callisto es un navegador.</p><p>Probando callisto.</p><p>CALLISTO al final.</p>'));
      case '/icon-page':
        return html(page('Con ícono', '', '<link rel="icon" href="/icon.svg">'));
      case '/icon.svg':
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#0067c0"/></svg>');
      case '/favicon.ico':
        // ICO con una imagen PNG de 1x1 adentro (el formato que usan la mayoría de los favicons modernos)
        res.writeHead(200, { 'Content-Type': 'image/x-icon' });
        return res.end(icoWithPng());
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
    // Ventanas invisibles y sin robar el foco (CALLISTO_TEST_VISIBLE=1 para verlas mientras se depura)
    env: { ...process.env, CALLISTO_USER_DATA_DIR: dir, ELECTRON_RENDERER_URL: '', CALLISTO_TEST_INVISIBLE: process.env.CALLISTO_TEST_VISIBLE ? '' : '1' },
  });
  const proc = app.process(); // referencia propia: Playwright ya no la da si la app salió sola
  const { ui, tab } = await firstWindowPages(app);
  await ui.waitForLoadState('domcontentloaded');
  return {
    app,
    userData: dir,
    ui,
    tab,
    close: async () => {
      // Red de seguridad de las pruebas: si el cierre se traba más de 15 s, se termina el proceso en vez de bloquear
      // la corrida. (No reemplaza la prueba del cierre real: ver "cerrar Callisto con un sitio que usa service workers".)
      const closed = app.close().then(() => true, () => true);
      const ok = await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
      if (!ok) {
        console.warn('[pruebas] Callisto no cerró en 15 s; se termina el proceso');
        proc.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!userData) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * Pulsa una tecla en la pestaña activa o en la interfaz de la ventana enfocada (o la primera) con
 * `webContents.sendInputEvent`. (Las teclas simuladas por Playwright vía CDP no pasan por 'before-input-event', que es
 * donde Callisto implementa sus atajos; `sendInputEvent` recorre el mismo camino que una tecla real.)
 */
export async function pressKey(app: ElectronApplication, target: 'tab' | 'ui', keyCode: string, modifiers: Array<'control' | 'alt' | 'shift'> = [], which: 'focused' | 'newest' = 'focused'): Promise<void> {
  await app.evaluate(({ BaseWindow }, { target, keyCode, modifiers, which }) => {
    const all = BaseWindow.getAllWindows();
    const newest = all.reduce((a, b) => (b.id > a.id ? b : a));
    const win = which === 'newest' ? newest : (BaseWindow.getFocusedWindow() ?? all.reduce((a, b) => (b.id < a.id ? b : a)));
    const views = win.contentView.children as Electron.WebContentsView[];
    const ui = views.find((v) => v.webContents.getURL().startsWith('callisto://ui/'))!;
    const tab = views.find((v) => v !== ui && v.getVisible())!;
    const wc = (target === 'tab' ? tab : ui).webContents;
    wc.focus();
    // Fuera de este evaluate: un atajo como Ctrl+Shift+W cierra la ventana en el acto, y eso corta la respuesta a
    // Playwright si ocurre durante la llamada. La tecla soltada se omite si el contenido ya no existe.
    setTimeout(() => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, 0);
  }, { target, keyCode, modifiers, which });
  await new Promise((r) => setTimeout(r, 50));
}

/** URL de la pestaña activa (visible) de la ventana enfocada o la primera. */
export function activeTabUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows()[0]!;
    const views = win.contentView.children as Electron.WebContentsView[];
    const tab = views.find((v) => !v.webContents.getURL().startsWith('callisto://ui/') && v.getVisible());
    return tab ? tab.webContents.getURL() : '';
  });
}

/** Zoom real (factor de Chromium) de la pestaña activa. */
export function activeTabZoom(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows()[0]!;
    const views = win.contentView.children as Electron.WebContentsView[];
    const tab = views.find((v) => !v.webContents.getURL().startsWith('callisto://ui/') && v.getVisible())!;
    return tab.webContents.getZoomFactor();
  });
}

/**
 * Captura el próximo menú contextual nativo en lugar de mostrarlo, para poder elegir una opción desde la prueba.
 * (Los menús nativos de Windows no son accesibles para Playwright.)
 */
export async function captureMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __menus: Electron.Menu[] };
    g.__menus = [];
    Menu.prototype.popup = function (this: Electron.Menu) { g.__menus.push(this); };
  });
}

/** Etiquetas (habilitadas) del último menú capturado. */
export async function lastMenuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __menus: Electron.Menu[] };
    const m = g.__menus[g.__menus.length - 1];
    return m ? m.items.filter((i) => i.type !== 'separator' && i.enabled).map((i) => i.label) : [];
  });
}

/** Elige una opción del último menú capturado. */
export async function clickMenuItem(app: ElectronApplication, label: string): Promise<void> {
  await expectEventually(async () => (await lastMenuLabels(app)).includes(label));
  await app.evaluate((_e, label) => {
    const g = globalThis as unknown as { __menus: Electron.Menu[] };
    const m = g.__menus[g.__menus.length - 1]!;
    const item = m.items.find((i) => i.label === label)!;
    (item.click as unknown as () => void)();
  }, label);
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
