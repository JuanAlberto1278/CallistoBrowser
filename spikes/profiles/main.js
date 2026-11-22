// Callisto V0.1 — Spike de perfiles y modo privado.
// Fase "write": escribe cookies/localStorage/IndexedDB/Cache API en dos perfiles persistentes y una sesión privada,
//               verifica aislamiento cruzado, limpieza de la privada y que no deja archivos en disco.
// Fase "read":  (proceso nuevo = reinicio del navegador) verifica qué persistió.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('../shared/test-server');

const RUN_DIR = path.join(__dirname, '..', '.runtime', 'profiles');
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=write').slice(8);
if (PHASE === 'write') fs.rmSync(RUN_DIR, { recursive: true, force: true });
fs.mkdirSync(RUN_DIR, { recursive: true });
app.setPath('userData', path.join(RUN_DIR, 'userData'));

const PORT = 47811; // fijo: el origen debe ser el mismo tras el reinicio
const PROFILES = { trabajo: 'persist:profile-trabajo', universidad: 'persist:profile-universidad' };

const WRITE_JS = (tag) => `(async () => {
  await fetch('/set-cookies?tag=${tag}');
  localStorage.setItem('owner', '${tag}');
  sessionStorage.setItem('owner', '${tag}');
  await new Promise((res, rej) => {
    const r = indexedDB.open('callisto-test', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put('${tag}', 'owner'); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = rej; };
    r.onerror = rej;
  });
  const c = await caches.open('callisto-test');
  await c.put('/marker', new Response('${tag}'));
  return true;
})()`;

const READ_JS = `(async () => {
  const idb = await new Promise((res) => {
    const r = indexedDB.open('callisto-test', 1);
    r.onupgradeneeded = () => { r.transaction.abort(); res(null); };
    r.onsuccess = () => {
      if (!r.result.objectStoreNames.contains('kv')) { r.result.close(); return res(null); }
      const g = r.result.transaction('kv').objectStore('kv').get('owner');
      g.onsuccess = () => { r.result.close(); res(g.result ?? null); };
      g.onerror = () => res('error');
    };
    r.onerror = () => res(null);
  });
  let cache = null;
  if (await caches.has('callisto-test')) { const m = await (await caches.open('callisto-test')).match('/marker'); cache = m ? await m.text() : null; }
  return { cookies: document.cookie, localStorage: localStorage.getItem('owner'), idb, cache };
})()`;

async function inPartition(partition, base, js) {
  const win = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true } });
  try {
    for (let attempt = 1; ; attempt++) {
      try { await win.loadURL(`${base}/lab`); break; } catch (e) {
        console.log(`  intento ${attempt} en ${partition} falló: ${e.message}`);
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    return await win.webContents.executeJavaScript(js);
  } catch (e) {
    console.log(`ERROR en ${partition}: ${e.message}`);
    throw e;
  } finally {
    win.destroy();
  }
}

function listFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(root, p)); } };
  if (fs.existsSync(root)) walk(root);
  return out;
}

process.on('unhandledRejection', (e) => { console.log('FATAL', e && e.stack); app.exit(2); });
// Evitar que la app se cierre sola al destruir la última ventana de prueba.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const server = await createServer(PORT);
  server.on('request', (req) => { if (process.argv.includes('--verbose')) console.log('  [srv]', req.method, req.url); });
  const base = `http://127.0.0.1:${PORT}`;
  const result = { phase: PHASE, electron: process.versions.electron, checks: [] };
  const check = (name, ok, detail) => { result.checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

  if (PHASE === 'write') {
    for (const [tag, part] of Object.entries(PROFILES)) await inPartition(part, base, WRITE_JS(tag));
    const priv = 'inprivate-1';
    const filesBeforePrivate = listFiles(app.getPath('userData'));
    await inPartition(priv, base, WRITE_JS('privado'));

    // Aislamiento cruzado
    const seen = {};
    for (const [tag, part] of Object.entries(PROFILES)) seen[tag] = await inPartition(part, base, READ_JS);
    seen.privado = await inPartition(priv, base, READ_JS);
    for (const [tag, r] of Object.entries(seen)) {
      const others = ['trabajo', 'universidad', 'privado'].filter((t) => t !== tag);
      const leaks = others.filter((o) => JSON.stringify(r).includes(o));
      check(`aislamiento: ${tag} solo ve sus datos`, r.localStorage === tag && r.idb === tag && r.cache === tag && r.cookies.includes(`persistent_${tag}`) && leaks.length === 0, r);
    }
    // Cookie jar vía API de sesión (independiente de la página)
    const jarT = await session.fromPartition(PROFILES.trabajo).cookies.get({ url: base });
    const jarU = await session.fromPartition(PROFILES.universidad).cookies.get({ url: base });
    check('cookie jar trabajo sin cookies de universidad', jarT.every((c) => !c.name.includes('universidad')), jarT.map((c) => c.name));
    check('cookie jar universidad sin cookies de trabajo', jarU.every((c) => !c.name.includes('trabajo')), jarU.map((c) => c.name));

    // Privado: nada en disco
    const newFiles = listFiles(app.getPath('userData')).filter((f) => !filesBeforePrivate.includes(f));
    const privateOnDisk = newFiles.filter((f) => /inprivate/i.test(f));
    check('privado: no crea carpeta de partición en disco', privateOnDisk.length === 0, privateOnDisk);
    check('privado: archivos nuevos en userData durante navegación privada', true, newFiles.filter((f) => !/profile-(trabajo|universidad)/.test(f)));

    // Privado: limpieza al cerrar todas las ventanas privadas
    const ps = session.fromPartition(priv);
    await ps.clearStorageData();
    await ps.clearCache();
    await ps.clearAuthCache();
    const afterClear = await inPartition(priv, base, READ_JS);
    check('privado: tras clearStorageData no queda nada', !afterClear.cookies && !afterClear.localStorage && !afterClear.idb && !afterClear.cache, afterClear);
    const fresh = await inPartition('inprivate-2', base, READ_JS);
    check('privado: nueva sesión privada empieza vacía', !fresh.cookies && !fresh.localStorage && !fresh.idb && !fresh.cache, fresh);

    // Extensiones en sesión en memoria
    const extDir = path.join(RUN_DIR, 'dummy-ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({ name: 'dummy', version: '1.0', manifest_version: 3 }));
    let extErr = null;
    try { await ps.extensions.loadExtension(extDir); } catch (e) { extErr = String(e.message || e); }
    check('privado: cargar extensiones en sesión en memoria falla (esperado)', extErr !== null, extErr);
    let extOk = null;
    try { extOk = (await session.fromPartition(PROFILES.trabajo).extensions.loadExtension(extDir)).id; } catch (e) { extOk = 'ERROR ' + e.message; }
    check('perfil persistente: carga de extensión funciona', typeof extOk === 'string' && !extOk.startsWith('ERROR'), extOk);
  } else {
    for (const [tag, part] of Object.entries(PROFILES)) {
      const r = await inPartition(part, base, READ_JS);
      check(`reinicio: ${tag} conserva cookie persistente`, r.cookies.includes(`persistent_${tag}`), r.cookies);
      check(`reinicio: ${tag} pierde cookie de sesión (comportamiento estándar)`, !r.cookies.includes(`session_${tag}`), r.cookies);
      check(`reinicio: ${tag} conserva localStorage/IndexedDB/Cache`, r.localStorage === tag && r.idb === tag && r.cache === tag, r);
    }
    const p = await inPartition('inprivate-1', base, READ_JS);
    check('reinicio: la sesión privada no dejó nada', !p.cookies && !p.localStorage && !p.idb && !p.cache, p);
    const parts = fs.readdirSync(path.join(app.getPath('userData'), 'Partitions'));
    check('Partitions en disco solo contiene los perfiles', parts.every((d) => /profile-/.test(d)), parts);
    // (El cifrado de cookies en disco se inspecciona con la app cerrada: profiles/inspect-disk.py)
  }

  const outDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `profiles-${PHASE}.json`), JSON.stringify(result, null, 2));
  server.close();
  app.exit(result.checks.every((c) => c.ok) ? 0 : 1);
});
