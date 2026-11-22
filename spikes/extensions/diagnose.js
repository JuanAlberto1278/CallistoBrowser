// Callisto V0.1 — Diagnóstico de extensiones que no funcionaron en el spike principal.
// Reutiliza las extensiones ya descargadas por extensions/main.js. Cada extensión corre sola en su sesión.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

const SRC = path.join(__dirname, '..', '.runtime', 'extensions', 'userData', 'Extensions');
const RUN_DIR = path.join(__dirname, '..', '.runtime', 'extensions-diag');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
app.setPath('userData', path.join(RUN_DIR, 'userData'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_TARGETS = {
  'uBlock Origin Lite': 'ddkjiahejlhfcafbddmgiahcphecmpfh',
  'AdGuard AdBlocker': 'bgnkhhnnamicmpeenaelnjfhikgbkllg',
  'Dark Reader': 'eimadpbcbfnmbkopoojfekhnkhdbieeh',
  '1Password': 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
};
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const TARGETS = onlyArg ? Object.fromEntries(Object.entries(ALL_TARGETS).filter(([n]) => onlyArg.slice(7).split(',').includes(n))) : ALL_TARGETS;
// Varias URLs publicitarias/rastreadoras; "bloqueado" = la petición falla (no cuenta redirecciones a sustitutos)
const adProbe = `Promise.all([
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  'https://www.google-analytics.com/analytics.js',
  'https://googleads.g.doubleclick.net/pagead/id',
  'https://connect.facebook.net/en_US/fbevents.js',
].map((u) => fetch(u + '?c=' + Math.random(), { mode: 'no-cors', cache: 'no-store' }).then((r) => u.split('/')[2] + ':' + (r.type === 'opaque' ? 'cargado' : r.type + '/' + r.url.slice(0, 40))).catch(() => u.split('/')[2] + ':BLOQUEADO'))).then((a) => a.join(' | '))`;

app.whenReady().then(async () => {
  const report = {};
  for (const [name, id] of Object.entries(TARGETS)) {
    const dir = path.join(SRC, id, fs.readdirSync(path.join(SRC, id))[0]);
    const s = session.fromPartition(`persist:diag-${id}`);
    s.setUserAgent(s.getUserAgent().replace(/\s?Electron\/\S+/, ''));
    const msgs = [];
    s.serviceWorkers.on('console-message', (_e, d) => msgs.push(`[${d.level}] ${String(d.message).slice(0, 250)}`));
    s.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => msgs.push(`[sw ${versionId}] ${runningStatus}`));
    const tab = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: s, sandbox: true } });
    const ece = new ElectronChromeExtensions({ session: s, createTab: async (d) => { const w = new BrowserWindow({ show: false, webPreferences: { session: s } }); ece.addTab(w.webContents, w); if (d.url) w.loadURL(d.url).catch(() => {}); msgs.push(`[tabs.create] ${d.url}`); return [w.webContents, w]; } });
    ece.addTab(tab.webContents, tab);
    if (process.argv.includes('--alias')) {
      const alias = path.join(__dirname, 'browser-alias-preload.js');
      s.registerPreloadScript({ id: 'callisto-browser-alias-sw', type: 'service-worker', filePath: alias });
      s.registerPreloadScript({ id: 'callisto-browser-alias-frame', type: 'frame', filePath: alias });
    }
    const r = { name };
    try {
      const ext = await s.extensions.loadExtension(dir);
      r.loaded = ext.id === id;
      await sleep(12000);
      r.swRunning = Object.values(s.serviceWorkers.getAllRunning()).some((w) => w.scope.includes(id));
      // Estado DNR desde una página de la extensión
      const page = (ext.manifest.action && ext.manifest.action.default_popup) || (ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page;
      if (page) {
        const pw = new BrowserWindow({ show: false, webPreferences: { session: s, sandbox: true } });
        await pw.loadURL(`chrome-extension://${id}/${page}`).catch(() => {});
        await sleep(2000);
        r.dnr = await pw.webContents.executeJavaScript(`(async () => {
          if (!chrome.declarativeNetRequest) return 'API ausente';
          const out = {};
          try { out.enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets(); } catch (e) { out.enabledRulesets = 'ERROR ' + e.message; }
          try { out.dynamicRules = (await chrome.declarativeNetRequest.getDynamicRules()).length; } catch (e) { out.dynamicRules = 'ERROR ' + e.message; }
          try { out.sessionRules = (await chrome.declarativeNetRequest.getSessionRules()).length; } catch (e) { out.sessionRules = 'ERROR ' + e.message; }
          return out; })()`).catch((e) => 'ERROR ' + e.message);
        pw.destroy();
      }
      tab.webContents.on('console-message', (e) => msgs.push(`[tab ${e.level}] ${String(e.message).slice(0, 200)}`));
      await tab.loadURL('https://example.com/').catch(() => {});
      ece.selectTab(tab.webContents);
      await sleep(6000);
      r.adProbe = await tab.webContents.executeJavaScript(adProbe).catch((e) => 'ERROR ' + e.message);
      r.darkReader = await tab.webContents.executeJavaScript(`({ marker: !!document.querySelector('style.darkreader, meta[name="darkreader"]'), bg: getComputedStyle(document.documentElement).backgroundColor })`).catch(() => null);
    } catch (e) {
      r.error = String(e.message || e);
    }
    r.swLog = msgs.slice(0, 80);
    report[name] = r;
    tab.destroy();
    console.log(`${name}: loaded=${r.loaded} sw=${r.swRunning} dnr=${JSON.stringify(r.dnr)} ad=${r.adProbe}`);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'results', process.argv.includes('--alias') ? 'extensions-diagnose-alias.json' : 'extensions-diagnose.json'), JSON.stringify(report, null, 2));
  app.exit(0);
});
