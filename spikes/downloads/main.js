// Callisto V0.1 — Spike de descargas.
// Mide, para cada mecanismo de descarga, qué llega a disco ANTES de que el usuario autorice,
// con dos estrategias:
//   A = pausar sincrónicamente en will-download + ruta en cuarentena privada (luego cancelar o aprobar)
//   B = cancelar sincrónicamente (preventDefault) y, si se aprueba, volver a pedir con downloadURL
//   N = línea base: cuarentena SIN pausa (para ver cuánto fluye si no se pausa)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const RUN_DIR = path.join(__dirname, '..', '.runtime', 'downloads');
fs.rmSync(RUN_DIR, { recursive: true, force: true });
const DIRS = {
  fakeUserDownloads: path.join(RUN_DIR, 'fake-user-downloads'),
  quarantine: path.join(RUN_DIR, 'quarantine'),
  approved: path.join(RUN_DIR, 'approved'),
  temp: path.join(RUN_DIR, 'temp'),
  userData: path.join(RUN_DIR, 'userData'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
// Redirigir TEMP/TMP antes de que arranque Chromium para observar archivos temporales.
process.env.TEMP = DIRS.temp;
process.env.TMP = DIRS.temp;

const { app, BrowserWindow, session } = require('electron');
const { createServer, MB } = require('../shared/test-server');

app.setPath('userData', DIRS.userData);
// Por defecto, la carpeta de descargas de la APP apunta a la cuarentena privada, para que el marcador
// temporal que Chromium crea antes de will-download nunca toque la carpeta del usuario.
// Con --placeholder-in-downloads se observa el comportamiento por defecto ("Descargas" simulada).
const PLACEHOLDER_IN_DOWNLOADS = process.argv.includes('--placeholder-in-downloads');
app.setPath('downloads', PLACEHOLDER_IN_DOWNLOADS ? DIRS.fakeUserDownloads : DIRS.quarantine);
app.setPath('temp', DIRS.temp);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DL_PATTERN = /crdownload|unconfirmed|\.tmp$|download|\.bin$|\.txt$|\.pdf$/i;

function walk(root, out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, out);
    else {
      try { out.set(p, fs.statSync(p).size); } catch { /* archivo efímero */ }
    }
  }
  return out;
}

// Archivos nuevos o modificados respecto de `base`, en las carpetas observadas.
function diskDiff(base) {
  const now = new Map();
  for (const key of ['fakeUserDownloads', 'quarantine', 'temp']) walk(DIRS[key], now);
  for (const [p, s] of walk(DIRS.userData)) if (DL_PATTERN.test(path.basename(p))) now.set(p, s);
  const diff = [];
  for (const [p, s] of now) {
    if (!base.has(p) || base.get(p) !== s) diff.push({ file: path.relative(RUN_DIR, p), bytes: s });
  }
  return diff;
}
function baseSnapshot() {
  const m = new Map();
  for (const key of ['fakeUserDownloads', 'quarantine', 'temp']) walk(DIRS[key], m);
  for (const [p, s] of walk(DIRS.userData)) if (DL_PATTERN.test(path.basename(p))) m.set(p, s);
  return m;
}
const sumBytes = (d) => d.reduce((a, f) => a + f.bytes, 0);

// ---------------------------------------------------------------- casos de prueba
const SZ = 1 * MB;
const CASES = [
  { id: 'link-attachment', expect: SZ, js: (b) => `clickLink('${b}/file/attach?size=${SZ}&name=attach.bin')` },
  { id: 'link-octet-stream', expect: SZ, js: (b) => `clickLink('${b}/file/octet?size=${SZ}')` },
  { id: 'a-download-attr', expect: 2048, js: (b) => `clickLink('${b}/file/text?size=2048', 'texto.txt')` },
  { id: 'js-location', expect: SZ, js: (b) => `location.href='${b}/file/attach?size=${SZ}&name=jsloc.bin'` },
  { id: 'window-open', expect: SZ, js: (b) => `window.open('${b}/file/attach?size=${SZ}&name=popup.bin'); 0` },
  { id: 'redirect-302', expect: SZ, js: (b) => `clickLink('${b}/redirect?size=${SZ}')` },
  { id: 'post-form', expect: SZ, js: () => `document.getElementById('postform').submit()` },
  { id: 'iframe', expect: SZ, js: (b) => `document.getElementById('frame').src='${b}/file/attach?size=${SZ}&name=iframe.bin'` },
  { id: 'blob-url', expect: SZ, js: () => `clickLink(makeBlobUrl(${SZ}), 'blob.bin')` },
  { id: 'blob-url-revoked', expect: SZ, js: () => `(() => { const u = makeBlobUrl(${SZ}); clickLink(u, 'blob-revoked.bin'); URL.revokeObjectURL(u); })()` },
  { id: 'data-url', expect: 13, js: () => `clickLink('data:application/octet-stream;base64,' + btoa('hola callisto'), 'data.txt')` },
  { id: 'pdf-attachment', expect: null, js: (b) => `clickLink('${b}/file/pdf-attach')` },
  { id: 'one-time-url', expect: SZ, js: (b) => `clickLink('${b}/one-time?size=${SZ}&t=' + Math.random())` },
  { id: 'multiple-3-a-download', expect: SZ, count: 3, js: (b) => `[1,2,3].forEach(i => clickLink('${b}/file/attach?size=${SZ}&name=multi' + i + '.bin', 'multi' + i + '.bin'))` },
  { id: 'multiple-3-iframes', expect: SZ, count: 3, js: (b) => `[1,2,3].forEach(i => { const f = document.createElement('iframe'); f.src = '${b}/file/attach?size=${SZ}&name=ifr' + i + '.bin'; document.body.appendChild(f); })` },
  { id: 'large-fast-300MB', expect: 300 * MB, js: (b) => `clickLink('${b}/file/attach?size=${300 * MB}&name=large.bin')` },
  { id: 'slow-3MB', expect: 3 * MB, js: (b) => `clickLink('${b}/file/attach?size=${3 * MB}&mode=slow&name=slow.bin')` },
];
// Estrategias adicionales por caso:
//   B2      = cancelar + pedir al usuario que vuelva a hacer clic (pre-aprobación de un solo uso por nombre de archivo)
//   B-guard = cancelar + re-descargar, con preload que retrasa URL.revokeObjectURL
const EXTRA = {
  'post-form': ['B2'],
  'one-time-url': ['B2'],
  'blob-url-revoked': ['B-guard', 'B2'],
};

// ---------------------------------------------------------------- motor de ensayos
let trial = null;
const preApproved = new Set();
const preApprovedNames = new Set();

function attachHandler(ses) {
  ses.on('will-download', (event, item, wc) => {
    const t = trial;
    const url = item.getURL();
    const rec = {
      url: url.length > 120 ? url.slice(0, 120) + '…' : url,
      urlChain: item.getURLChain().length,
      filename: item.getFilename(),
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      hasUserGesture: item.hasUserGesture(),
      receivedAtEvent: item.getReceivedBytes(),
      diskAtEvent: t ? diskDiff(t.base) : [],
    };
    if (!t) { event.preventDefault(); return; }

    if (preApproved.has(url) || preApprovedNames.delete(item.getFilename())) {
      // Re-descarga aprobada (estrategia B)
      const final = path.join(DIRS.approved, `${t.id}-${item.getFilename()}`);
      item.setSavePath(final);
      rec.kind = 'redownload';
      t.redownloads.push(rec);
      item.once('done', (_e, state) => {
        rec.state = state;
        rec.finalBytes = fs.existsSync(final) ? fs.statSync(final).size : 0;
        t.pending--;
      });
      t.pending++;
      return;
    }

    if (t.strategy.startsWith('B')) {
      event.preventDefault();
      rec.kind = 'intercepted';
      rec.cancelledImmediately = true;
      t.items.push({ rec, url, wc });
      return;
    }

    // Estrategias A y N: ruta en cuarentena privada; A además pausa
    const qPath = path.join(DIRS.quarantine, `${crypto.randomUUID()}.part`);
    item.setSavePath(qPath);
    if (t.strategy !== 'N') item.pause();
    rec.kind = 'intercepted';
    rec.pausedOk = item.isPaused();
    rec.receivedRightAfterPause = item.getReceivedBytes();
    t.items.push({ rec, item, qPath });
    t.pending++;
    item.once('done', (_e, state) => {
      rec.state = state;
      rec.receivedAtDone = item.getReceivedBytes();
      t.pending--;
    });
  });
}

async function waitFor(cond, timeout) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) return false;
    await sleep(50);
  }
  return true;
}

async function runTrial(wins, base, c, strategy) {
  const win = strategy === 'B-guard' ? wins.guard : wins.plain;
  await win.loadURL(`${base}/lab`);
  trial = { id: `${c.id}/${strategy}`, strategy, base: baseSnapshot(), items: [], redownloads: [], pending: 0 };
  const t = trial;
  await win.webContents.executeJavaScript(c.js(base), true).catch((e) => { t.triggerError = String(e); });
  const expectedCount = c.count || 1;
  const fired = await waitFor(() => t.items.length >= expectedCount, 6000);
  if (!fired) t.timeoutWaitingEvent = true;

  // "Deliberación" del usuario: 1,5 s
  await sleep(1500);
  for (const it of t.items) {
    it.rec.diskAtDecision = diskDiff(t.base);
    if (it.item) it.rec.receivedAtDecision = it.item.getReceivedBytes();
  }

  if (strategy === 'A-reject' || strategy === 'N') {
    for (const it of t.items) it.item.cancel();
    await waitFor(() => t.pending <= 0, 8000);
    await sleep(400);
    t.leftoversAfterCancel = diskDiff(t.base);
  } else if (strategy === 'A-approve') {
    for (const it of t.items) it.item.resume();
    const ok = await waitFor(() => t.pending <= 0, 60000);
    if (!ok) t.timeoutCompleting = true;
    for (const it of t.items) {
      if (it.rec.state === 'completed') {
        const final = path.join(DIRS.approved, `${c.id}-${it.rec.filename}`);
        fs.renameSync(it.qPath, final);
        it.rec.finalBytes = fs.statSync(final).size;
      }
    }
  } else if (strategy === 'B' || strategy === 'B-guard') {
    t.afterCancel = diskDiff(t.base);
    for (const it of t.items) {
      preApproved.add(it.url);
      const target = it.wc && !it.wc.isDestroyed() ? it.wc : win.webContents;
      try { target.downloadURL(it.url); } catch (e) { it.rec.redownloadError = String(e); }
    }
    const ok = await waitFor(() => t.redownloads.length >= t.items.length && t.pending <= 0, c.id.startsWith('slow') ? 45000 : 15000);
    if (!ok) t.timeoutRedownload = true;
    for (const it of t.items) preApproved.delete(it.url);
  } else if (strategy === 'B2') {
    // El usuario aprueba y vuelve a hacer clic en el sitio: se repite el disparador original.
    t.afterCancel = diskDiff(t.base);
    for (const it of t.items) preApprovedNames.add(it.rec.filename);
    await win.webContents.executeJavaScript(c.js(base), true).catch(() => {});
    const ok = await waitFor(() => t.redownloads.length >= t.items.length && t.pending <= 0, 15000);
    if (!ok) t.timeoutRedownload = true;
    preApprovedNames.clear();
  }

  // Limpieza: cancelar lo que siga en curso y cerrar popups
  for (const it of t.items) if (it.item && it.item.getState() === 'progressing') it.item.cancel();
  await waitFor(() => t.pending <= 0, 3000);
  for (const w of BrowserWindow.getAllWindows()) if (w !== wins.plain && w !== wins.guard) w.destroy();
  if (strategy !== 'B' && strategy !== 'B-guard' && strategy !== 'B2') {
    for (const f of fs.readdirSync(DIRS.quarantine)) fs.rmSync(path.join(DIRS.quarantine, f), { force: true });
  }
  t.quarantineAtEnd = fs.readdirSync(DIRS.quarantine);
  trial = null;
  return summarize(c, t);
}

function summarize(c, t) {
  const items = t.items.map((i) => i.rec);
  const s = {
    trial: t.id,
    events: items.length,
    triggerError: t.triggerError,
    timeoutWaitingEvent: t.timeoutWaitingEvent || undefined,
    mime: items[0] && items[0].mime,
    userGesture: items[0] && items[0].hasUserGesture,
    receivedAtEvent: items.map((r) => r.receivedAtEvent),
    bytesOnDiskAtEvent: items.length ? sumBytes(items[0].diskAtEvent) : 0,
    filesAtEvent: items.length ? items[0].diskAtEvent : [],
    bytesOnDiskAtDecision: items.length ? sumBytes(items[items.length - 1].diskAtDecision || []) : 0,
    filesAtDecision: items.length ? items[items.length - 1].diskAtDecision : [],
    receivedAtDecision: items.map((r) => r.receivedAtDecision),
    pausedOk: items.map((r) => r.pausedOk),
  };
  if (t.leftoversAfterCancel) s.leftoversAfterCancel = t.leftoversAfterCancel;
  if (t.afterCancel) s.filesAfterImmediateCancel = t.afterCancel;
  s.quarantineAtEnd = t.quarantineAtEnd;
  if (t.strategy === 'A-approve') s.final = items.map((r) => ({ state: r.state, bytes: r.finalBytes, ok: c.expect == null ? r.state === 'completed' : r.finalBytes === c.expect }));
  if (t.strategy.startsWith('B')) {
    s.redownload = t.redownloads.map((r) => ({ state: r.state, bytes: r.finalBytes, ok: c.expect == null ? r.state === 'completed' : r.finalBytes === c.expect }));
    if (t.timeoutRedownload) s.redownloadTimeout = true;
    if (t.redownloads.length < items.length) s.redownloadMissing = items.length - t.redownloads.length;
  }
  return s;
}

app.whenReady().then(async () => {
  const server = await createServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const ses = session.fromPartition('persist:dl-lab');
  // --placeholder-in-downloads: dejar la carpeta de descargas por defecto (para observar el marcador .tmp)
  if (!process.argv.includes('--placeholder-in-downloads')) ses.setDownloadPath(DIRS.quarantine);
  attachHandler(ses);
  const mk = (preload) => {
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, preload } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { session: ses } } }));
    return w;
  };
  const wins = { plain: mk(undefined), guard: mk(path.join(__dirname, 'blob-guard-preload.js')) };

  const only = process.argv.find((a) => a.startsWith('--only='));
  const cases = only ? CASES.filter((c) => only.slice(7).split(',').includes(c.id)) : CASES;
  const results = [];
  for (const c of cases) {
    let strategies = ['A-reject', 'A-approve', 'B', ...(EXTRA[c.id] || [])];
    if (c.id.startsWith('large') || c.id.startsWith('slow')) strategies.push('N');
    const stArg = process.argv.find((a) => a.startsWith('--strategies='));
    if (stArg) strategies = stArg.slice(13).split(',');
    const rep = process.argv.find((a) => a.startsWith('--repeat='));
    if (rep) strategies = Array(Number(rep.slice(9))).fill(strategies).flat();
    for (const st of strategies) {
      process.stdout.write(`> ${c.id} / ${st} ... `);
      const r = await runTrial(wins, base, c, st);
      results.push(r);
      const where = [...new Set((r.filesAtEvent || []).map((f) => f.file.split(path.sep)[0]))].join('+') || '-';
      console.log(`events=${r.events} atEvent=${where}:${r.bytesOnDiskAtEvent}B diskAtDecision=${r.bytesOnDiskAtDecision} qEnd=${(r.quarantineAtEnd || []).length}` +
        (r.leftoversAfterCancel ? ` leftovers=${r.leftoversAfterCancel.length}` : '') +
        (r.final ? ` final=${JSON.stringify(r.final)}` : '') +
        (r.redownload ? ` redownload=${JSON.stringify(r.redownload)}` : '') +
        (r.triggerError ? ` ERROR=${r.triggerError}` : '') + (r.timeoutWaitingEvent ? ' NO-EVENT' : ''));
    }
  }
  const outDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outName = process.argv.includes('--placeholder-in-downloads') ? 'downloads-default-path.json' : 'downloads.json';
  fs.writeFileSync(path.join(outDir, outName), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, date: new Date().toISOString(), results }, null, 2));
  console.log('\nResultados en spikes/results/downloads.json');
  server.close();
  app.exit(0);
});
