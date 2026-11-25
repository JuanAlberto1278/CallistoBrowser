// Lectura de CPU y memoria por proceso (1.4.0). La comparten el Administrador de tareas, el aviso de "usa mucha CPU" y
// la memoria en uso de Configuración. `app.getAppMetrics()` mide la CPU de cada proceso desde la llamada anterior: por
// eso hay un único lector y todos usan sus muestras.
import { app, webContents, type WebContents } from 'electron';
import { TEST_LOW_MEMORY } from './test-mode';
import { averageCpu, type CpuPoint } from './cpu-average';

export interface ProcessSample {
  pid: number;
  /** Tipo de proceso de Chromium: Browser, Tab, GPU, Utility… */
  type: string;
  /** Nombre del servicio (procesos de utilidad: red, audio, almacenamiento…). */
  serviceName?: string;
  name?: string;
  /**
   * CPU desde la muestra anterior, en % del total del equipo (todos los núcleos), como el Administrador de tareas de
   * Windows: un núcleo ocupado al 100 % en un equipo de 8 núcleos lógicos es 12,5 %.
   */
  cpu: number;
  /** Memoria reservada (privada), en KB. */
  memoryKb: number;
}

/** Cuánto historial de CPU se guarda por proceso. */
const HISTORY_MS = 5 * 60_000;

class ResourceMonitor {
  private lastTime = 0;
  private readonly history = new Map<number, CpuPoint[]>();
  /** Procesos vistos en la muestra anterior (la primera muestra de un proceso nuevo vale 0: no cuenta). */
  private seen = new Set<number>();
  private latestSamples: ProcessSample[] = [];

  /** Toma una muestra nueva de todos los procesos de Callisto. */
  sample(): ProcessSample[] {
    const now = Date.now();
    const dt = this.lastTime ? now - this.lastTime : 0;
    this.lastTime = now;
    const metrics = app.getAppMetrics();
    const samples: ProcessSample[] = metrics.map((m) => ({
      pid: m.pid,
      type: m.type,
      serviceName: m.serviceName,
      name: m.name,
      cpu: Math.max(0, m.cpu.percentCPUUsage),
      memoryKb: m.memory.privateBytes ?? m.memory.workingSetSize,
    }));
    const alive = new Set(samples.map((s) => s.pid));
    for (const s of samples) {
      if (!this.seen.has(s.pid) || dt <= 0) continue;
      const points = this.history.get(s.pid) ?? [];
      points.push({ t: now, dt, cpu: s.cpu });
      while (points.length && points[0]!.t < now - HISTORY_MS) points.shift();
      this.history.set(s.pid, points);
    }
    for (const pid of this.history.keys()) if (!alive.has(pid)) this.history.delete(pid);
    this.seen = alive;
    this.latestSamples = samples;
    return samples;
  }

  /** La última muestra (sin medir de nuevo). */
  get latest(): readonly ProcessSample[] {
    return this.latestSamples;
  }

  /** CPU promedio de un proceso en los últimos `windowMs` (null: todavía no hay datos suficientes). */
  averageCpu(pid: number, windowMs: number): number | null {
    return averageCpu(this.history.get(pid) ?? [], Date.now(), windowMs);
  }

  /** Memoria reservada de un proceso en la última muestra (KB), si se midió. */
  memoryKb(pid: number): number | null {
    return this.latestSamples.find((s) => s.pid === pid)?.memoryKb ?? null;
  }

  /** Muestra nueva solo si la última tiene más de `maxAgeMs`. */
  fresh(maxAgeMs: number): void {
    if (Date.now() - this.lastTime > maxAgeMs) this.sample();
  }
}

export const resources = new ResourceMonitor();

/**
 * Memoria del proceso de una página, si es la única que vive en él (al cerrarla, el proceso termina y la libera entera).
 * null si comparte el proceso (pestañas del mismo sitio) o no se pudo medir.
 */
export function soleProcessMemoryKb(wc: WebContents): number | null {
  if (wc.isDestroyed()) return null;
  const pid = wc.getOSProcessId();
  if (!pid) return null;
  const sharing = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getOSProcessId() === pid);
  if (sharing.length !== 1) return null;
  resources.fresh(1000);
  return resources.memoryKb(pid);
}

/**
 * Memoria disponible (MB) por debajo de la cual "a Windows le falta memoria": el umbral de presión moderada que usa
 * Chromium en Windows. (Un porcentaje del total no sirve: un equipo de 16 GB con 1,8 GB disponibles, un 11 %, anda bien.)
 */
export const LOW_MEMORY_MB = 1000;

/** ¿Le falta memoria al sistema? (`free` es la memoria física disponible, en KB) */
export function lowSystemMemory(): boolean {
  if (TEST_LOW_MEMORY) return true;
  const m = process.getSystemMemoryInfo();
  return m.total > 0 && m.free / 1024 < LOW_MEMORY_MB;
}
