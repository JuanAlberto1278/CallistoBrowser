// Callisto V0.1 — Spike de extensiones.
// Instala extensiones reales desde la Chrome Web Store (electron-chrome-web-store) con soporte de APIs
// adicional (electron-chrome-extensions), y mide para cada una:
//   - instalación y carga (MV3), service worker en ejecución, errores de consola del service worker
//   - APIs chrome.* que pide en su manifiesto y que NO existen en Callisto/Electron
//   - render del popup (captura PNG)
//   - pruebas funcionales específicas en páginas reales o locales
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension } = require('electron-chrome-web-store');
const { createServer } = require('../shared/test-server');

const RUN_DIR = path.join(__dirname, '..', '.runtime', 'extensions');
const RESULTS = path.join(__dirname, '..', 'results');
const SHOTS = path.join(RESULTS, 'extension-popups');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
app.setPath('userData', path.join(RUN_DIR, 'userData'));
app.on('window-all-closed', () => {});

const EXTENSIONS = [
  ['uBlock Origin Lite', 'ddkjiahejlhfcafbddmgiahcphecmpfh'],
  ['AdGuard AdBlocker', 'bgnkhhnnamicmpeenaelnjfhikgbkllg'],
  ['Privacy Badger', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp'],
  ['Dark Reader', 'eimadpbcbfnmbkopoojfekhnkhdbieeh'],
  ['Bitwarden', 'nngceckbapebfimnlniiiahkandclblb'],
  ['1Password', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'],
  ['Google Translate', 'aapbdbdomjkkjkaonfhkkikfgjllcleb'],
  ['Grammarly', 'kbfnbcaeplbcioakkpcpgfkobkghlhen'],
  ['React Developer Tools', 'fmkadmapgofadopljbjfkapdkoienihi'],
  ['Tampermonkey', 'dhdgffkkebhmkfjojejmpbldmpobfkfo'],
  ['Video Speed Controller', 'nffaoalbilbmmfgbnbgppjihopabppdk'],
  ['JSON Formatter', 'bcjindcccaagfpapjjmafapmmgkkhgoa'],
  ['Return YouTube Dislike', 'gebbhagfogifgggkldgodflihgfeippi'],
  ['OneTab', 'chphlpgkkbolifaimnlloiipkdnihall'],
  ['Wappalyzer', 'gppongmhjkpfnbhagpmjfkannfbllamg'],
  ['Google Docs Offline', 'ghbmnnjooekpmoecnnnilnnbdlolhkhi'],
];

// Permiso del manifiesto -> expresión que debe existir en una página de la extensión
const PERMISSION_PROBES = {
  alarms: 'chrome.alarms', storage: 'chrome.storage && chrome.storage.local', unlimitedStorage: 'true',
  tabs: 'chrome.tabs', activeTab: 'chrome.tabs', scripting: 'chrome.scripting', contextMenus: 'chrome.contextMenus',
  notifications: 'chrome.notifications', webRequest: 'chrome.webRequest', webRequestBlocking: 'chrome.webRequest',
  declarativeNetRequest: 'chrome.declarativeNetRequest', declarativeNetRequestWithHostAccess: 'chrome.declarativeNetRequest',
  declarativeNetRequestFeedback: 'chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug',
  cookies: 'chrome.cookies', identity: 'chrome.identity', downloads: 'chrome.downloads', offscreen: 'chrome.offscreen',
  sidePanel: 'chrome.sidePanel', userScripts: 'chrome.userScripts', nativeMessaging: 'chrome.runtime.connectNative',
  webNavigation: 'chrome.webNavigation', management: 'chrome.management', history: 'chrome.history', bookmarks: 'chrome.bookmarks',
  tabGroups: 'chrome.tabGroups', idle: 'chrome.idle', privacy: 'chrome.privacy', proxy: 'chrome.proxy', search: 'chrome.search',
  topSites: 'chrome.topSites', commands: 'chrome.commands', windows: 'chrome.windows', clipboardWrite: 'true', clipboardRead: 'true',
  i18n: 'chrome.i18n', power: 'chrome.power', system: 'chrome.system', 'system.display': 'chrome.system && chrome.system.display',
  contentSettings: 'chrome.contentSettings', webNavigationFrames: 'chrome.webNavigation', favicon: 'true', tts: 'chrome.tts',
  debugger: 'chrome.debugger', browsingData: 'chrome.browsingData', sessions: 'chrome.sessions', declarativeContent: 'chrome.declarativeContent',
  ttsEngine: 'chrome.ttsEngine', fontSettings: 'chrome.fontSettings', 'webAuthenticationProxy': 'chrome.webAuthenticationProxy',
  privacyPolicy: 'true', background: 'true', geolocation: 'true', unlimitedstorage: 'true',
};
const ALWAYS_PROBE = ['chrome.runtime', 'chrome.runtime.sendMessage', 'chrome.storage.sync', 'chrome.storage.session', 'chrome.i18n', 'chrome.action', 'chrome.permissions'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))]);

app.whenReady().then(async () => {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition('persist:ext-lab');
  const ua = ses.getUserAgent().replace(/\s?Electron\/\S+/, '');
  ses.setUserAgent(ua);

  const tabWindow = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  const extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: async (details) => {
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
      extensions.addTab(w.webContents, w);
      if (details.url) w.loadURL(details.url).catch(() => {});
      return [w.webContents, w];
    },
    selectTab: () => {},
    removeTab: (wc, w) => { if (w && !w.isDestroyed()) w.destroy(); },
    createWindow: async (details) => {
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
      if (details.url) w.loadURL(Array.isArray(details.url) ? details.url[0] : details.url).catch(() => {});
      return w;
    },
    removeWindow: (w) => { if (w && !w.isDestroyed()) w.destroy(); },
    requestPermissions: async () => true,
  });
  extensions.addTab(tabWindow.webContents, tabWindow);
  // Corrección descubierta en V0.1: igualar el `browser` nativo incompleto a `chrome` (ver browser-alias-preload.js)
  const USE_ALIAS = !process.argv.includes('--no-alias');
  const registerAlias = (s) => {
    if (!USE_ALIAS) return;
    const alias = path.join(__dirname, 'browser-alias-preload.js');
    s.registerPreloadScript({ id: 'callisto-browser-alias-sw', type: 'service-worker', filePath: alias });
    s.registerPreloadScript({ id: 'callisto-browser-alias-frame', type: 'frame', filePath: alias });
  };
  registerAlias(ses);
  await installChromeWebStore({ session: ses, autoUpdate: false, loadExtensions: true });

  // Errores de consola de service workers de extensiones
  const swErrors = {};
  ses.serviceWorkers.on('console-message', (_e, d) => {
    const m = /chrome-extension:\/\/([a-p]{32})/.exec(d.source || d.sourceUrl || '') || /chrome-extension:\/\/([a-p]{32})/.exec(d.message || '');
    if (d.level >= 3 || d.level === 'error') {
      const id = m ? m[1] : 'unknown';
      (swErrors[id] ||= []).push(String(d.message).slice(0, 300));
    }
  });

  const results = [];
  for (const [name, id] of EXTENSIONS) {
    const r = { name, id, installed: false };
    results.push(r);
    process.stdout.write(`> ${name} ... `);
    try {
      const ext = await withTimeout(installExtension(id, { session: ses }), 90000, 'install');
      r.installed = true;
      r.version = ext.version;
      r.manifestVersion = ext.manifest.manifest_version;
      r.permissions = ext.manifest.permissions || [];
      r.optionalPermissions = ext.manifest.optional_permissions || [];
      r.hostPermissions = (ext.manifest.host_permissions || []).length;
      r.contentScripts = (ext.manifest.content_scripts || []).length;
      r.popup = ext.manifest.action && ext.manifest.action.default_popup;
      r.options = (ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page;
      r.backgroundType = ext.manifest.background ? (ext.manifest.background.service_worker ? 'service_worker' : 'page/scripts') : 'none';
      console.log(`instalada v${ext.version} MV${r.manifestVersion}`);
    } catch (e) {
      r.installError = String(e.message || e).slice(0, 300);
      console.log(`ERROR ${r.installError}`);
    }
  }

  await sleep(5000); // dejar arrancar service workers
  const running = Object.values(ses.serviceWorkers.getAllRunning()).map((w) => w.scope);

  for (const r of results.filter((x) => x.installed)) {
    r.serviceWorkerRunning = r.backgroundType === 'service_worker' ? running.some((s) => s.includes(r.id)) : null;
    // Sondeo de APIs desde una página de la propia extensión (popup, opciones o manifest como último recurso)
    const page = r.popup || r.options;
    const probeWin = new BrowserWindow({ show: false, width: 420, height: 620, webPreferences: { session: ses, sandbox: true } });
    const pageErrors = [];
    probeWin.webContents.on('console-message', (e) => { if (e.level === 'error') pageErrors.push(String(e.message).slice(0, 200)); });
    try {
      await withTimeout(probeWin.loadURL(`chrome-extension://${r.id}/${page || 'manifest.json'}`), 15000, 'page');
      await sleep(2500);
      const wanted = [...new Set([...r.permissions, ...r.optionalPermissions])].filter((p) => typeof p === 'string');
      const exprs = {};
      for (const p of wanted) exprs[`perm:${p}`] = PERMISSION_PROBES[p] || (/^[a-zA-Z]+$/.test(p.split('.')[0]) ? `chrome.${p.split('.')[0]}` : 'true');
      for (const a of ALWAYS_PROBE) exprs[`api:${a}`] = a;
      // Sin eval (la CSP de MV3 lo prohíbe): cada expresión es "a.b.c" o "a.b && a.b.c" o "true"
      const js = `(() => {
        const get = (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), globalThis);
        const ok = (expr) => expr.split('&&').map(s => s.trim()).every(s => s === 'true' || get(s) !== undefined);
        const out = {}; const ex = ${JSON.stringify(exprs)};
        for (const k in ex) { try { out[k] = ok(ex[k]); } catch { out[k] = false; } }
        return out; })()`;
      const avail = page ? await probeWin.webContents.executeJavaScript(js) : null;
      if (avail) {
        r.missingPermissionApis = Object.entries(avail).filter(([k, v]) => k.startsWith('perm:') && !v).map(([k]) => k.slice(5));
        r.missingCommonApis = Object.entries(avail).filter(([k, v]) => k.startsWith('api:') && !v).map(([k]) => k.slice(4));
      } else {
        r.missingPermissionApis = 'sin página para sondear';
      }
      if (page) {
        r.pageTextLength = await probeWin.webContents.executeJavaScript('document.body ? document.body.innerText.trim().length : 0');
        r.pageElements = await probeWin.webContents.executeJavaScript('document.querySelectorAll("body *").length');
        const img = await probeWin.webContents.capturePage();
        fs.writeFileSync(path.join(SHOTS, `${r.name.replace(/\W+/g, '_')}.png`), img.toPNG());
      }
    } catch (e) {
      r.probeError = String(e.message || e).slice(0, 200);
    }
    r.pageConsoleErrors = pageErrors.slice(0, 5);
    probeWin.destroy();
  }

  // ---------------------------------------------------------------- pruebas funcionales
  const functional = {};
  const loadInTab = async (url, wait = 4000) => {
    await withTimeout(tabWindow.loadURL(url), 30000, url).catch((e) => { functional.loadErrors = [...(functional.loadErrors || []), `${url}: ${e.message}`]; });
    extensions.selectTab(tabWindow.webContents);
    await sleep(wait);
  };
  const ev = (js) => tabWindow.webContents.executeJavaScript(js).catch((e) => `ERROR ${e.message}`);

  // Bloqueo de anuncios: ¿se carga un script de un dominio publicitario conocido?
  // Varias URLs publicitarias/rastreadoras: BLOQUEADO = la petición falla; "sustituto" = redirigida a un recurso inofensivo de la extensión
  const adProbe = `Promise.all([
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://www.google-analytics.com/analytics.js',
    'https://googleads.g.doubleclick.net/pagead/id',
    'https://connect.facebook.net/en_US/fbevents.js',
  ].map((u) => fetch(u + '?c=' + Math.random(), { mode: 'no-cors', cache: 'no-store' }).then((r) => u.split('/')[2] + ':' + (r.type === 'opaque' ? 'cargado' : (r.url.startsWith('chrome-extension://') ? 'sustituto' : r.type))).catch(() => u.split('/')[2] + ':BLOQUEADO'))).then((a) => a.join(' | '))`;
  await loadInTab('https://example.com/');
  functional.adblockOnHttps = await ev(adProbe);
  // Control: misma prueba en una sesión SIN extensiones
  const ctl = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:ext-control', sandbox: true } });
  await ctl.loadURL('https://example.com/').catch(() => {});
  functional.adblockControlNoExtensions = await ctl.webContents.executeJavaScript(adProbe).catch((e) => String(e));
  ctl.destroy();

  // Pruebas aisladas: cada extensión sola en su propia sesión (para atribuir resultados)
  const extDir = (id) => {
    const d = path.join(app.getPath('userData'), 'Extensions', id);
    return path.join(d, fs.readdirSync(d)[0]);
  };
  const isolated = async (id, url, js, wait) => {
    const s = session.fromPartition(`persist:iso-${id}`);
    s.setUserAgent(ua);
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: s, sandbox: true } });
    const ece = new ElectronChromeExtensions({ session: s, createTab: async () => { throw new Error('n/a'); } });
    ece.addTab(w.webContents, w);
    registerAlias(s);
    try {
      await s.extensions.loadExtension(extDir(id));
      await sleep(6000); // arranque del service worker y aplicación de reglas
      await withTimeout(w.loadURL(url), 30000, url).catch(() => {});
      ece.selectTab(w.webContents);
      await sleep(wait);
      return await w.webContents.executeJavaScript(js).catch((e) => `ERROR ${e.message}`);
    } catch (e) {
      return `ERROR ${e.message}`;
    } finally { w.destroy(); }
  };
  functional.adblockIsolated = {};
  for (const [name, id] of EXTENSIONS.slice(0, 3)) functional.adblockIsolated[name] = await isolated(id, 'https://example.com/', adProbe, 1000);
  const drJs = `(() => ({ htmlBackground: getComputedStyle(document.documentElement).backgroundColor, textColor: getComputedStyle(document.body).color }))()`;
  functional.darkReaderIsolated = await isolated('eimadpbcbfnmbkopoojfekhnkhdbieeh', 'https://example.com/', drJs, 5000);

  // Dark Reader en la sesión con todas las extensiones
  await loadInTab('https://example.com/', 5000);
  functional.darkReader = await ev(drJs);
  functional.contentScriptMarkers = await ev(`(() => { const b = document.body, h = document.documentElement; return { grammarly: b.hasAttribute('data-gr-ext-installed') || h.hasAttribute('data-gr-ext-installed') || !!document.querySelector('grammarly-desktop-integration'), bodyAttrs: [...b.attributes].map(a => a.name), htmlAttrs: [...h.attributes].map(a => a.name), customElements: [...new Set([...document.querySelectorAll('*')].map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))] }; })()`);

  // Video Speed Controller: ¿agrega su controlador sobre un <video>?
  await loadInTab('https://www.w3schools.com/html/html5_video.asp', 6000);
  functional.videoSpeedController = await ev(`document.querySelector('.vsc-controller, vsc-controller') ? 'controlador presente' : 'sin controlador'`);

  // JSON Formatter: ¿formatea una respuesta JSON?
  await loadInTab(`${base}/echo-headers`, 3000);
  functional.jsonFormatter = await ev(`(() => { const pre = document.body.firstElementChild; return pre && pre.tagName === 'PRE' && document.body.children.length === 1 ? 'sin formatear' : 'formateado (' + [...document.body.children].map(e => e.tagName + (e.id ? '#' + e.id : '')).join(',') + ')'; })()`);

  // Páginas reales con mucho JS y login (solo carga, sin credenciales)
  for (const url of ['https://www.youtube.com/', 'https://github.com/login', 'https://accounts.google.com/']) {
    await loadInTab(url, 4000);
    functional[`carga ${url}`] = await ev('document.title');
  }

  // Errores de service workers por extensión
  for (const r of results) r.serviceWorkerErrors = (swErrors[r.id] || []).slice(0, 5);
  const loaded = ses.extensions.getAllExtensions().map((e) => `${e.name} (${e.id})`);

  fs.writeFileSync(path.join(RESULTS, 'extensions.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, date: new Date().toISOString(), loaded, results, functional, unattributedSwErrors: (swErrors.unknown || []).slice(0, 20) }, null, 2));
  console.log('\nResultados en spikes/results/extensions.json, capturas en spikes/results/extension-popups/');
  server.close();
  app.exit(0);
});
