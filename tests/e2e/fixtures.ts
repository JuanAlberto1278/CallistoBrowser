import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------- servidor de pruebas local
export interface TestServer {
  base: string;
  close(): Promise<void>;
  releaseSlow(): void;
  /** Vuelve a habilitar las URL de un solo uso. */
  resetTokens(): void;
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

/** Contenido determinista de los archivos de prueba (para verificar que se guardó completo y sin alterar). */
export function fileBytes(size: number, seed = 1): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
}

/**
 * Laboratorio de descargas: un botón por mecanismo (la matriz medida en V0.1, docs/01-v0.1-resultados.md §1.1).
 * Cada uno descarga un archivo con nombre propio.
 */
const DOWNLOAD_LAB = `
  <a id="m-attach" href="/dl/attach?name=adjunto.bin&size=4096">Enlace con Content-Disposition</a>
  <a id="m-octet" href="/dl/octet/octeto.bin">application/octet-stream</a>
  <a id="m-a-download" href="/dl/text" download="texto.txt">a download</a>
  <button id="m-js" onclick="location.href='/dl/attach?name=por-js.bin&size=3000'">JavaScript</button>
  <button id="m-window-open" onclick="window.open('/dl/attach?name=ventana.bin&size=2000')">window.open</button>
  <a id="m-redirect" href="/dl/redirect">Redirección 302</a>
  <form id="f" method="post" action="/dl/form"><input name="x" value="1"><button id="m-post">Formulario POST</button></form>
  <button id="m-iframe" onclick="const f=document.createElement('iframe');f.src='/dl/attach?name=iframe.bin&size=1500';document.body.append(f)">iframe</button>
  <button id="m-blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['contenido blob vigente'],{type:'application/octet-stream'}));a.download='blob.txt';a.click()">blob vigente</button>
  <button id="m-blob-revoked" onclick="const u=window.URL.createObjectURL(new Blob(['contenido blob revocado'],{type:'text/csv'}));const a=document.createElement('a');a.href=u;a.download='exportado.csv';a.click();window.URL.revokeObjectURL(u)">blob revocado</button>
  <a id="m-data" href="data:application/octet-stream;base64,ZGF0b3MgZW4gdW5hIFVSTCBkYXRh" download="datos.bin">data:</a>
  <a id="m-pdf" href="/dl/pdf">PDF adjunto</a>
  <a id="m-one-time" href="/dl/one-time" onclick="this.href='/dl/one-time?t='+Math.random()">Un solo uso (enlace firmado nuevo en cada clic, como en V0.1)</a>
  <button id="m-multiple" onclick="for (const n of ['uno','dos','tres']) { const a=document.createElement('a'); a.href='/dl/attach?name='+n+'.bin&size=1000'; a.download=n+'.bin'; a.click(); }">Múltiples</button>
  <a id="m-large" href="/dl/attach?name=grande.bin&size=20971520">Grande (20 MB)</a>
  <a id="m-slow" href="/dl/slow?name=lento.bin&size=1048576">Lento</a>
  <a id="m-exe" href="/dl/attach?name=instalador.exe&size=1000">Ejecutable</a>
  <a id="m-blank" href="/dl/attach?name=pestana.bin&size=1000" target="_blank">target=_blank</a>
  <img id="img" src="/dl/image.png" width="20" height="20">`;

const PNG_RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function startServer(): Promise<TestServer> {
  let count = 0;
  const usedTokens = new Set<string>();
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
      case '/datos/guardar': {
        // Guarda el mismo valor en una cookie persistente y en localStorage
        const v = (url.searchParams.get('v') ?? 'x').replace(/[^a-z0-9-]/gi, '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `dato=${v}; Max-Age=86400; Path=/; SameSite=Lax` });
        return res.end(page(`Guardado ${v}`, `<script>localStorage.setItem('dato', '${v}')</script>`));
      }
      case '/datos/leer':
        return html(page('Lectura', `<script>document.title = 'Lectura: cookie=' + (document.cookie.match(/dato=([^;]*)/)?.[1] ?? 'ninguna') + ' almacenamiento=' + (localStorage.getItem('dato') ?? 'ninguno')</script>`));
      case '/dl/lab':
        return html(page('Laboratorio de descargas', DOWNLOAD_LAB));
      case '/dl/attach': {
        const name = url.searchParams.get('name') ?? 'archivo.bin';
        const size = Number(url.searchParams.get('size') ?? 1024);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(size) });
        return res.end(fileBytes(size));
      }
      case '/dl/octet/octeto.bin':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '2500' });
        return res.end(fileBytes(2500));
      case '/dl/text':
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('texto plano para descargar');
      case '/dl/pdf': {
        const body = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="documento.pdf"', 'Content-Length': String(body.length) });
        return res.end(body);
      }
      case '/dl/redirect':
        res.writeHead(302, { Location: '/dl/attach?name=redirigido.bin&size=1234' });
        return res.end();
      case '/dl/form':
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          return res.end('solo POST');
        }
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="resultado-post.bin"', 'Content-Length': '1800' });
          res.end(fileBytes(1800));
        });
        return;
      case '/dl/one-time': {
        const token = url.searchParams.get('t') ?? '';
        if (usedTokens.has(token)) {
          res.writeHead(410, { 'Content-Type': 'text/plain' });
          return res.end('vencido');
        }
        usedTokens.add(token);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="un-solo-uso.bin"', 'Content-Length': '1600' });
        return res.end(fileBytes(1600));
      }
      case '/dl/slow': {
        // 1 MB en trozos de 16 KB cada 100 ms (unos 6 s): da tiempo a pausar, reanudar y cancelar
        const size = Number(url.searchParams.get('size') ?? 1048576);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${url.searchParams.get('name') ?? 'lento.bin'}"`, 'Content-Length': String(size) });
        const data = fileBytes(size);
        let sent = 0;
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          const chunk = data.subarray(sent, sent + 16384);
          sent += chunk.length;
          res.write(chunk);
          if (sent >= size) {
            clearInterval(t);
            res.end();
          }
        }, 100);
        req.on('close', () => clearInterval(t));
        return;
      }
      case '/dl/image.png':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(PNG_RED);
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
    resetTokens: () => usedTokens.clear(),
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
  const output: string[] = [];
  proc.stdout?.on('data', (d) => output.push(String(d)));
  proc.stderr?.on('data', (d) => output.push(String(d)));
  // Toda excepción no capturada del proceso principal se registra (en uso real sería un diálogo de error que además
  // traba el cierre) y hace fallar la prueba al cerrar.
  await app.evaluate(() => {
    process.on('uncaughtException', (e) => console.log(`CALLISTO-EXCEPCION: ${e?.stack ?? e}`));
  });
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
        const lines = output.join('').split('\n').filter((l) => l.trim() && !/^\[\d+:/.test(l));
        console.warn(`[pruebas] Callisto no cerró en 15 s; se termina con todos sus procesos. Salida:\n${lines.slice(-25).join('\n')}`);
        // El árbol completo: terminar solo el proceso principal dejaba vivos los demás (y sus diálogos)
        if (proc.pid) {
          try {
            execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            proc.kill();
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!userData) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // Cada excepción con su stack (las líneas siguientes que empiezan con "at ")
      const all = output.join('').split('\n');
      const exceptions = all.flatMap((l, i) => {
        if (!l.includes('CALLISTO-EXCEPCION')) return [];
        const stack: string[] = [];
        for (let j = i + 1; j < all.length && /^\s+at /.test(all[j]!) && stack.length < 8; j++) stack.push(all[j]!);
        return [l, ...stack];
      });
      if (exceptions.length) throw new Error(`Excepción en el proceso principal de Callisto:\n${exceptions.join('\n')}`);
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
