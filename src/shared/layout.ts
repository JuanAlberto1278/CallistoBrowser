// Alturas de la interfaz del navegador. El proceso principal las usa para ubicar la página debajo de la interfaz;
// la interfaz las usa para dibujar cada franja con exactamente esa altura.

export const TAB_STRIP_HEIGHT = 38;
/** Barra de herramientas (46) + barra de carga (2). */
export const TOOLBAR_HEIGHT = 48;
export const NOTICE_HEIGHT = 40;
export const FIND_BAR_HEIGHT = 40;

export function chromeHeight(opts: { notice: boolean; find: boolean }): number {
  return TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT + (opts.notice ? NOTICE_HEIGHT : 0) + (opts.find ? FIND_BAR_HEIGHT : 0);
}
