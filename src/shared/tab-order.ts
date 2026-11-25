// Reglas de orden de las pestañas (lógica pura, sin Electron).

/**
 * Dónde insertar una pestaña abierta desde otra (enlace, "abrir en pestaña nueva"): justo después de la pestaña de
 * origen y de las pestañas que ya se abrieron desde ella, como hace Chrome. Así, abrir varios enlaces seguidos los deja
 * en el orden en que se abrieron.
 */
export function childInsertIndex(openerIds: ReadonlyArray<number | null>, openerIndex: number, openerId: number): number {
  let i = openerIndex + 1;
  while (i < openerIds.length && openerIds[i] === openerId) i++;
  return i;
}

/**
 * Qué pestaña activar al cerrar la pestaña activa: la de la derecha y, si era la última, la de la izquierda.
 * Devuelve el índice dentro de la lista que queda después de cerrar.
 */
export function indexAfterClose(countBefore: number, closedIndex: number): number {
  return Math.max(0, Math.min(closedIndex, countBefore - 2));
}

/** Copia de la lista con el elemento `from` movido a la posición `to` (acotada a la lista). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  const target = Math.max(0, Math.min(to, out.length));
  out.splice(target, 0, item!);
  return out;
}

/** Índice de la pestaña siguiente o anterior, dando la vuelta en los extremos (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleIndex(count: number, current: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + step + count) % count;
}

/** Las pestañas fijadas siempre primero, conservando el orden de cada parte. */
export function keepPinnedFirst<T extends { pinned: boolean }>(list: readonly T[]): T[] {
  return [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)];
}
