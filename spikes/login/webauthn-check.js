// Callisto V0.1 — Qué capacidades de WebAuthn/passkeys anuncia Electron a las páginas (sin disparar ningún diálogo).
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../shared/test-server');

app.setPath('userData', path.join(__dirname, '..', '.runtime', 'webauthn-check'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const server = await createServer();
  const withPatch = process.argv.includes('--patched');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, preload: withPatch ? path.join(__dirname, 'webauthn-preload.js') : undefined } });
  await w.loadURL(`http://127.0.0.1:${server.address().port}/lab`); // 127.0.0.1 es contexto seguro
  const r = await w.webContents.executeJavaScript(`(async () => ({
    publicKeyCredential: typeof PublicKeyCredential,
    conditionalMediation: PublicKeyCredential.isConditionalMediationAvailable ? await PublicKeyCredential.isConditionalMediationAvailable() : 'no existe',
    platformAuthenticator: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    clientCapabilities: PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : 'no existe',
    // Con el parche, una petición condicional debe quedar pendiente (sin diálogo) y abortarse limpiamente
    conditionalGetBehavior: ${withPatch} ? await (async () => {
      const ac = new AbortController();
      const p = navigator.credentials.get({ mediation: 'conditional', signal: ac.signal, publicKey: { challenge: new Uint8Array(32), rpId: location.hostname } });
      const state = await Promise.race([p.then(() => 'resuelta', (e) => 'rechazada ' + e.name), new Promise((r) => setTimeout(() => r('pendiente tras 1,5 s'), 1500))]);
      ac.abort();
      const afterAbort = await p.then(() => 'resuelta', (e) => 'rechazada ' + e.name);
      const immediate = await navigator.credentials.get({ mediation: 'immediate', publicKey: { challenge: new Uint8Array(32), rpId: location.hostname } }).then(() => 'resuelta', (e) => 'rechazada ' + e.name);
      return { state, afterAbort, immediate };
    })() : 'no probado (sin parche no se dispara para no abrir diálogos)',
  }))()`);
  const subset = { conditionalMediation: r.conditionalMediation, conditionalGet: r.clientCapabilities.conditionalGet, immediateGet: r.clientCapabilities.immediateGet, platformAuthenticator: r.platformAuthenticator, conditionalGetBehavior: r.conditionalGetBehavior };
  console.log(JSON.stringify({ electron: process.versions.electron, patched: withPatch, ...subset }, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'results', withPatch ? 'webauthn-patched.json' : 'webauthn.json'), JSON.stringify(r, null, 2));
  server.close();
  app.exit(0);
});
