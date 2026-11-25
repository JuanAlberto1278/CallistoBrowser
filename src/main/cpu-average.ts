// CPU promedio de un proceso a partir de sus muestras (sin Electron: lo prueban las pruebas unitarias).

export interface CpuPoint {
  /** Momento de la muestra (ms). */
  t: number;
  /** Duración que mide (ms desde la muestra anterior). */
  dt: number;
  cpu: number;
}

/**
 * CPU promedio de un proceso en los últimos `windowMs`, ponderada por la duración de cada muestra. null si las muestras
 * no cubren al menos el 80 % de ese tiempo (proceso nuevo o recién empezado a medir: todavía no se sabe).
 */
export function averageCpu(points: readonly CpuPoint[], now: number, windowMs: number): number | null {
  const from = now - windowMs;
  let covered = 0;
  let sum = 0;
  for (const p of points) {
    const start = Math.max(p.t - p.dt, from);
    const span = p.t - start;
    if (span <= 0) continue;
    covered += span;
    sum += p.cpu * span;
  }
  if (covered < windowMs * 0.8) return null;
  return sum / covered;
}

