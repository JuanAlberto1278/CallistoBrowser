// "Usa mucha CPU" (1.4.0): una pestaña en segundo plano que usa mucha CPU desde hace un rato se marca con un ícono; un
// clic en el ícono la duerme. Callisto nunca la duerme sola por esto.
//
// Para no culpar a quien no corresponde: se mide el proceso de la pestaña, y solo cuenta si en ese proceso no hay nada a
// la vista (la pestaña activa de una ventana, la interfaz, una extensión). Las pestañas que suenan (música, video) nunca
// se marcan.
import { webContents } from 'electron';
import { availableParallelism } from 'node:os';
import { resources } from './resource-monitor';
import { SLEEP_MINUTE_MS } from './test-mode';
import { BrowserWindowController } from './window';

/** CPU sostenida durante un minuto, en % de UN núcleo, a partir de la cual se marca. */
export const HIGH_CPU = 30;
/** Por debajo de esto (promedio del último minuto, en % de un núcleo) deja de marcarse. */
export const CALM_CPU = 10;

/** Chromium mide en % del total del equipo: en % de un núcleo es eso por la cantidad de núcleos lógicos. */
const CORES = Math.max(1, availableParallelism());

export function startCpuWatch(): void {
  // Cada 15 s (un minuto de pruebas / 4): el promedio necesita varias muestras dentro del minuto
  const timer = setInterval(check, Math.max(250, Math.round(SLEEP_MINUTE_MS / 4)));
  timer.unref();
}

function check(): void {
  const windows = [...BrowserWindowController.all].filter((w) => !w.closing);
  if (!windows.length) return;
  resources.sample();

  const busyPids = new Set<number>(); // procesos con algo a la vista: no se atribuyen a una pestaña de fondo
  const tabContents = new Set<Electron.WebContents>();
  const candidates: Array<{ tab: BrowserWindowController['tabs'][number]; pid: number }> = [];
  for (const w of windows) {
    for (const tab of w.tabs) {
      if (tab.isPending || tab.webContents.isDestroyed()) {
        tab.highCpu = false;
        continue;
      }
      tabContents.add(tab.webContents);
      const pid = tab.webContents.getOSProcessId();
      if (tab === w.active) {
        busyPids.add(pid);
        tab.highCpu = false;
      } else if (tab.kind === 'web') {
        candidates.push({ tab, pid });
      } else {
        tab.highCpu = false;
      }
    }
  }
  for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && !tabContents.has(wc)) busyPids.add(wc.getOSProcessId());

  for (const { tab, pid } of candidates) {
    const total = resources.averageCpu(pid, SLEEP_MINUTE_MS);
    const avg = total === null ? null : total * CORES;
    const excused = tab.webContents.isCurrentlyAudible() || busyPids.has(pid);
    if (tab.highCpu) {
      if (excused || avg === null || avg < CALM_CPU) tab.highCpu = false;
    } else if (!excused && avg !== null && avg >= HIGH_CPU) {
      tab.highCpu = true;
    }
  }
}
