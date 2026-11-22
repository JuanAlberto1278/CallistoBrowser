// Callisto V0.1 — Prueba MANUAL de inicio de sesión (la hace el usuario; nadie más ingresa credenciales).
//
// Variantes de identidad (cada una con su propio perfil persistente, para no mezclar resultados):
//   --ua=callisto  (por defecto) user-agent de Chromium + token de producto "Callisto/0.1.0", sin "Electron/"
//                  -> identidad honesta propuesta para el producto
//   --ua=electron  user-agent de Electron sin modificar + "Callisto/0.1.0"
//   --ua=chrome    user-agent "limpio" con forma de Chrome (la variante que Google rechazó en la primera prueba)
//
// Uso:  npm run login                      (variante callisto)
//       npm run login -- --ua=electron
//       npm run login -- --reset           (borra los perfiles de prueba)
//       npm run login -- --no-webauthn-fix (sin la corrección de passkeys, para comparar)
// El menú "Identidad" reinicia la app con otra variante.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, session, dialog } = require('electron');

const DATA = path.join(__dirname, '..', '.runtime', 'login');
if (process.argv.includes('--reset')) fs.rmSync(DATA, { recursive: true, force: true });
app.setPath('userData', DATA);

const VARIANT = ((process.argv.find((a) => a.startsWith('--ua=')) || '--ua=callisto').slice(5));
const PRODUCT = 'Callisto/0.1.0';

function userAgentFor(variant, electronUA) {
  const chromeShaped = electronUA.replace(/\s?Electron\/\S+/, '').replace(/\s?callisto-spikes\/\S+/i, '');
  if (variant === 'chrome') return chromeShaped;
  if (variant === 'electron') return electronUA.replace(/Chrome\//, `${PRODUCT} Chrome/`);
  // callisto: "... (KHTML, like Gecko) Callisto/0.1.0 Chrome/156.x Safari/537.36"
  return chromeShaped.replace(/Chrome\//, `${PRODUCT} Chrome/`);
}

const SITES = [
  ['Google (Gmail)', 'https://mail.google.com/'],
  ['Microsoft (Outlook)', 'https://outlook.live.com/mail/'],
  ['GitHub', 'https://github.com/login'],
  ['YouTube', 'https://www.youtube.com/'],
  ['Iniciar sesión con Google (OAuth en otro sitio)', 'https://stackoverflow.com/users/login'],
];
const LABELS = { callisto: 'Callisto (honesta, sin Electron)', electron: 'Electron sin modificar + Callisto', chrome: 'Forma de Chrome (la que falló)' };

app.whenReady().then(() => {
  const ses = session.fromPartition(`persist:login-${VARIANT}`);
  const ua = userAgentFor(VARIANT, ses.getUserAgent());
  ses.setUserAgent(ua);
  app.userAgentFallback = ua; // también para service workers y peticiones sin webContents
  ses.on('will-download', (e) => e.preventDefault()); // las descargas no son parte de esta prueba
  // Evita que las páginas abran solas el diálogo de llave de seguridad (ver webauthn-preload.js)
  if (!process.argv.includes('--no-webauthn-fix')) {
    ses.registerPreloadScript({ id: 'callisto-webauthn', type: 'frame', filePath: path.join(__dirname, 'webauthn-preload.js') });
  }
  const webPreferences = { session: ses, sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: true };

  const win = new BrowserWindow({ width: 1200, height: 850, webPreferences });
  const setTitle = () => win.setTitle(`Callisto V0.1 — login [${LABELS[VARIANT] || VARIANT}] — ${win.webContents.getTitle()}`);
  // Popups OAuth: ventanas hijas con window.opener (necesario para "Iniciar sesión con Google/Microsoft")
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 700, parent: win, webPreferences } }));
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); setTitle(); });

  const wc = win.webContents;
  const relaunchWith = (v) => { app.relaunch({ args: [process.argv[1], `--ua=${v}`] }); app.exit(0); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Sitios', submenu: SITES.map(([label, url]) => ({ label, click: () => wc.loadURL(url) })) },
    { label: 'Navegación', submenu: [
      { label: 'Atrás', accelerator: 'Alt+Left', click: () => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack() },
      { label: 'Adelante', accelerator: 'Alt+Right', click: () => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward() },
      { label: 'Recargar', accelerator: 'F5', click: () => wc.reload() },
    ] },
    { label: 'Identidad', submenu: [
      ...Object.entries(LABELS).map(([v, label]) => ({ label, type: 'radio', checked: v === VARIANT, click: () => v !== VARIANT && relaunchWith(v) })),
      { type: 'separator' },
      { label: 'Ver user-agent actual', click: () => dialog.showMessageBox(win, { title: 'User-agent', message: ua }) },
    ] },
  ]));
  wc.loadURL(SITES[0][1]);
  setTitle();
});
