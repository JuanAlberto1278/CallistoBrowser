// Genera build/icon.png (256 px, fondo transparente) a partir de build/icon.svg, con el propio Electron.
// Uso: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  writeFileSync(join(root, 'build', 'icon.png'), img.resize({ width: 256, height: 256 }).toPNG());
  console.log('build/icon.png', img.getSize());
  app.quit();
});
