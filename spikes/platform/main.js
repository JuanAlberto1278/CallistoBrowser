// Callisto V0.1 — Spike de plataforma:
//  1. node:sqlite dentro de Electron (WAL, transacciones, FTS5 para búsqueda de historial)
//  2. safeStorage asíncrono (DPAPI) + AES-256-GCM para la futura bóveda de contraseñas
//  3. User-agent y Client Hints que Electron envía por defecto vs. limpiados
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow, session, safeStorage } = require('electron');
const { createServer } = require('../shared/test-server');

const RUN_DIR = path.join(__dirname, '..', '.runtime', 'platform');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
fs.mkdirSync(RUN_DIR, { recursive: true });
app.setPath('userData', path.join(RUN_DIR, 'userData'));
app.on('window-all-closed', () => {});

const out = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); };

function sqliteSpike() {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (e) { return check('node:sqlite disponible', false, String(e)); }
  check('node:sqlite disponible', true, `sqlite ${new sqlite.DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v}`);
  const db = new sqlite.DatabaseSync(path.join(RUN_DIR, 'callisto.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE history (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, visited_at INTEGER NOT NULL)');
  const ins = db.prepare('INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)');
  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < 50000; i++) ins.run(`https://example${i % 500}.com/page/${i}`, `Página de prueba número ${i}`, Date.now() - i * 1000);
  db.exec('COMMIT');
  check('50.000 inserciones en una transacción', true, `${Math.round(performance.now() - t0)} ms`);
  let fts = false;
  try {
    db.exec("CREATE VIRTUAL TABLE history_fts USING fts5(title, url, content='history', content_rowid='id')");
    db.exec("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
    const t1 = performance.now();
    const rows = db.prepare("SELECT count(*) n FROM history_fts WHERE history_fts MATCH 'número AND example42'").get();
    fts = true;
    check('FTS5 (búsqueda de texto completo) disponible', true, `${rows.n} resultados en ${Math.round(performance.now() - t1)} ms`);
  } catch (e) { check('FTS5 (búsqueda de texto completo) disponible', fts, String(e)); }
  db.close();
}

async function vaultSpike() {
  check('safeStorage.isAsyncEncryptionAvailable/isEncryptionAvailable', true, {
    asyncApi: typeof safeStorage.encryptStringAsync === 'function',
    available: typeof safeStorage.isAsyncEncryptionAvailable === 'function' ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable(),
  });
  // Clave de datos del perfil (256 bits) envuelta con DPAPI vía safeStorage
  const dataKey = crypto.randomBytes(32);
  const wrapped = await safeStorage.encryptStringAsync(dataKey.toString('base64'));
  const unwrapped = Buffer.from(await safeStorage.decryptStringAsync(wrapped).then((r) => (typeof r === 'string' ? r : r.result)), 'base64');
  check('clave de perfil envuelta/desenvuelta con DPAPI', unwrapped.equals(dataKey), { wrappedBytes: wrapped.length });
  // Cifrado de una credencial con AES-256-GCM, con el origen como dato autenticado
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('https://accounts.example.com');
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv); c.setAAD(aad);
  const ct = Buffer.concat([c.update('contraseña-de-prueba', 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const d = crypto.createDecipheriv('aes-256-gcm', unwrapped, iv); d.setAAD(aad); d.setAuthTag(tag);
  const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  check('AES-256-GCM ida y vuelta', pt === 'contraseña-de-prueba');
  let tamperDetected = false;
  try { const d2 = crypto.createDecipheriv('aes-256-gcm', unwrapped, iv); d2.setAAD(Buffer.from('https://evil.example')); d2.setAuthTag(tag); d2.update(ct); d2.final(); } catch { tamperDetected = true; }
  check('AES-GCM rechaza credencial usada con otro origen', tamperDetected);
}

async function uaSpike(base) {
  const probe = async (ses) => {
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
    await w.loadURL(`${base}/echo-headers`);
    const headers = JSON.parse(await w.webContents.executeJavaScript('document.body.innerText'));
    const brands = await w.webContents.executeJavaScript('navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + " " + b.version).join(", ") : null');
    w.destroy();
    return { userAgent: headers['user-agent'], secChUa: headers['sec-ch-ua'], jsBrands: brands };
  };
  const def = session.fromPartition('persist:ua-default');
  check('user-agent por defecto', true, await probe(def));
  const clean = session.fromPartition('persist:ua-clean');
  const cleaned = def.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?callisto-spikes\/\S+/i, '');
  clean.setUserAgent(cleaned);
  check('user-agent limpio', !/Electron|callisto-spikes/i.test(cleaned), await probe(clean));
}

app.whenReady().then(async () => {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  sqliteSpike();
  await vaultSpike();
  await uaSpike(base);
  fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'platform.json'), JSON.stringify(out, null, 2));
  server.close();
  app.exit(out.checks.every((c) => c.ok) ? 0 : 1);
});
