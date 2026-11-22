// Niveles de zoom, los mismos que usan Chrome y Edge.

export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

const EPSILON = 0.001;

/** Siguiente nivel de zoom hacia adentro o hacia afuera a partir del factor actual (que puede no ser uno de la lista). */
export function stepZoom(current: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    return ZOOM_FACTORS.find((f) => f > current + EPSILON) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  }
  for (let i = ZOOM_FACTORS.length - 1; i >= 0; i--) {
    if (ZOOM_FACTORS[i]! < current - EPSILON) return ZOOM_FACTORS[i]!;
  }
  return ZOOM_FACTORS[0];
}

export function zoomPercent(factor: number): number {
  return Math.round(factor * 100);
}
