// Carga la extensión de sondeo con electron-chrome-extensions y muestra qué APIs ve el service worker y cuándo.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, session } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

const RUN_DIR = path.join(__dirname, '..', '..', '.runtime', 'race-test');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
app.setPath('userData', RUN_DIR);
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:race');
  new ElectronChromeExtensions({ session: ses });
  ses.serviceWorkers.on('console-message', (_e, d) => { if (String(d.message).startsWith('PROBE')) console.log(d.message); });
  await ses.extensions.loadExtension(__dirname);
  setTimeout(() => app.exit(0), 4000);
});
