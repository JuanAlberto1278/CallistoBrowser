// Mide la memoria de Callisto y de Edge con las mismas páginas (V1.0).
// Memoria = suma del "working set privado" de todos los procesos del navegador (la columna "Memoria" del Administrador
// de tareas). Uso: node measure-ram.cjs <raíz de Callisto> [callisto|edge|ambos]
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = process.argv[2];
const which = process.argv[3] || 'ambos';
const { _electron } = createRequire(path.join(root, 'package.json'))('@playwright/test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  'https://es.wikipedia.org/wiki/Navegador_web',
  'https://github.com/electron/electron',
  'https://www.youtube.com/',
  'https://www.bbc.com/mundo',
  'https://developer.mozilla.org/es/docs/Web/JavaScript',
];
const SETTLE = 25_000;

/** Procesos del árbol de `rootPid`: [{pid, name, mb}] con su working set privado. */
function treeMemory(rootPid) {
  const ps = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = [double]$_.WorkingSetPrivate }
$ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${rootPid})
do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0}|{1}|{2}", $_.ProcessId, $_.Name, [math]::Round($perf[[int]$_.ProcessId] / 1MB, 1)) }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, name, mb] = l.split('|');
    return { pid: Number(pid), name, mb: Number(mb) };
  });
}

const summary = (label, procs) => {
  const total = procs.reduce((s, p) => s + p.mb, 0);
  console.log(`${label}: ${Math.round(total)} MB en ${procs.length} procesos`);
  return { label, totalMb: Math.round(total), processes: procs.length };
};

async function measureCallisto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callisto-ram-'));
  const app = await _electron.launch({ args: [root, ...(process.env.MEDIR_FLAGS ? process.env.MEDIR_FLAGS.split(' ') : [])], cwd: root, env: { ...process.env, CALLISTO_USER_DATA_DIR: dir, ELECTRON_RENDERER_URL: '', CALLISTO_TEST_INVISIBLE: process.env.MEDIR_INVISIBLE ? '1' : '' } });
  const pid = app.process().pid;
  const isUi = (p) => p.url().startsWith('callisto://ui/index');
  while (!app.windows().some(isUi)) await sleep(100);
  const ui = app.windows().find(isUi);
  await sleep(SETTLE / 2);
  const results = [summary('Callisto, 1 pestaña nueva', treeMemory(pid))];
  for (let i = 0; i < PAGES.length; i++) {
    if (i > 0) await ui.getByTestId('new-tab').click();
    await ui.getByTestId('address').fill(PAGES[i]);
    await ui.getByTestId('address').press('Enter');
    await sleep(3000);
  }
  await sleep(SETTLE);
  const procs = treeMemory(pid);
  results.push(summary(`Callisto, ${PAGES.length} páginas`, procs));
  console.log('  ' + procs.sort((a, b) => b.mb - a.mb).slice(0, 12).map((p) => `${p.name}:${p.mb}`).join(' '));
  // Desglose por tipo de proceso (qué es cada uno), con la URL de las pestañas
  const metrics = await app.evaluate(({ app, webContents }) => {
    const byPid = new Map(webContents.getAllWebContents().map((w) => [w.getOSProcessId(), (w.getURL() || w.getType()).slice(0, 50)]));
    return app.getAppMetrics().map((m) => ({ type: m.type, service: m.serviceName || '', url: byPid.get(m.pid) || '', mb: Math.round(m.memory.privateBytes / 1024) }));
  });
  for (const m of metrics.sort((a, b) => b.mb - a.mb)) console.log(`  ${m.type.padEnd(8)} ${String(m.mb).padStart(4)} MB privados  ${m.service || m.url}`);
  if (process.env.MEDIR_DORMIDAS) {
    // Las 4 pestañas que no se están mirando, dormidas (desde el menú de cada pestaña)
    await app.evaluate(({ Menu }) => { globalThis.__m = []; Menu.prototype.popup = function () { globalThis.__m.push(this); }; });
    for (let i = 0; i < PAGES.length - 1; i++) {
      await ui.getByTestId('tab').nth(i).click({ button: 'right' });
      await sleep(300);
      await app.evaluate(() => { const m = globalThis.__m.at(-1); const it = m.items.find((x) => x.label.startsWith('Dormir')); if (it && it.enabled) it.click(); });
      await sleep(300);
    }
    await sleep(SETTLE);
    const asleep = await ui.locator('[data-asleep="true"]').count();
    results.push(summary(`Callisto, ${PAGES.length} páginas con ${asleep} dormidas`, treeMemory(pid)));
    const after = await app.evaluate(({ app, webContents }) => {
      const byPid = new Map(webContents.getAllWebContents().map((w) => [w.getOSProcessId(), (w.getURL() || w.getType()).slice(0, 50)]));
      return app.getAppMetrics().map((m) => ({ type: m.type, service: m.serviceName || '', url: byPid.get(m.pid) || '', mb: Math.round(m.memory.privateBytes / 1024) }));
    });
    for (const m of after.sort((a, b) => b.mb - a.mb)) console.log(`  después: ${m.type.padEnd(8)} ${String(m.mb).padStart(4)} MB  ${m.service || m.url}`);
    const sw = await app.evaluate(({ session }) => Object.values(session.fromPartition('persist:profile-default').serviceWorkers.getAllRunning()).map((w) => `${w.scope} pid=${w.renderProcessId}`));
    console.log('  service workers corriendo:', JSON.stringify(sw));
    if (process.env.MEDIR_DETENER_SW) {
      const r = await app.evaluate(async ({ session, webContents }) => {
        const ses = session.fromPartition('persist:profile-default');
        const running = ses.serviceWorkers.getAllRunning();
        const host = webContents.getAllWebContents().find((w) => w.session === ses && w.getURL().startsWith('https://developer.mozilla.org'));
        if (!host) return 'sin pestaña';
        host.debugger.attach('1.3');
        try {
          await host.debugger.sendCommand('ServiceWorker.enable');
          const stopped = [];
          for (const [versionId, info] of Object.entries(running)) {
            if (info.scope.startsWith('https://developer.mozilla.org')) continue;
            await host.debugger.sendCommand('ServiceWorker.stopWorker', { versionId: String(versionId) });
            stopped.push(info.scope);
          }
          return stopped;
        } finally {
          host.debugger.detach();
        }
      });
      console.log('  detenidos:', JSON.stringify(r));
      await sleep(8000);
      results.push(summary('Callisto, tras detener los service workers sin pestaña', treeMemory(pid)));
      const sw3 = await app.evaluate(({ session }) => Object.values(session.fromPartition('persist:profile-default').serviceWorkers.getAllRunning()).map((w) => w.scope));
      console.log('  service workers corriendo:', JSON.stringify(sw3));
    }
    if (process.env.MEDIR_ESPERA) {
      await sleep(Number(process.env.MEDIR_ESPERA));
      results.push(summary(`Callisto, tras esperar ${process.env.MEDIR_ESPERA} ms más`, treeMemory(pid)));
      const sw2 = await app.evaluate(({ session }) => Object.values(session.fromPartition('persist:profile-default').serviceWorkers.getAllRunning()).map((w) => w.scope));
      console.log('  service workers corriendo después:', JSON.stringify(sw2));
    }
  }
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return results;
}

async function measureEdge() {
  const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ram-'));
  const common = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync'];
  const results = [];
  const blank = spawn(exe, [...common, 'about:blank'], { stdio: 'ignore' });
  await sleep(SETTLE / 2);
  results.push(summary('Edge, 1 pestaña', treeMemory(blank.pid)));
  execFileSync('taskkill', ['/PID', String(blank.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(3000);
  const full = spawn(exe, [...common, ...PAGES], { stdio: 'ignore' });
  await sleep(SETTLE + PAGES.length * 3000);
  const procs = treeMemory(full.pid);
  results.push(summary(`Edge, ${PAGES.length} páginas`, procs));
  console.log('  ' + procs.sort((a, b) => b.mb - a.mb).slice(0, 12).map((p) => `${p.name}:${p.mb}`).join(' '));
  execFileSync('taskkill', ['/PID', String(full.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(3000);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return results;
}

(async () => {
  const all = [];
  if (which !== 'edge') all.push(...(await measureCallisto()));
  if (which !== 'callisto') all.push(...(await measureEdge()));
  console.log('RESULTADO ' + JSON.stringify(all));
})();
