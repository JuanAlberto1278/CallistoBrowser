import type { Input } from 'electron';

export type ShortcutAction =
  | 'focus-address-bar'
  | 'tab-search'
  | 'task-manager'
  | 'back'
  | 'forward'
  | 'reload'
  | 'reload-ignore-cache'
  | 'stop'
  | 'devtools'
  | 'new-tab'
  | 'close-tab'
  | 'new-window'
  | 'new-private-window'
  | 'close-window'
  | 'next-tab'
  | 'prev-tab'
  | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`
  | 'select-last-tab'
  | 'reopen-closed-tab'
  | 'duplicate-tab'
  | 'history'
  | 'downloads'
  | 'bookmark-page'
  | 'toggle-bookmarks-bar'
  | 'bookmarks'
  | 'find'
  | 'find-next'
  | 'find-prev'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

/**
 * Atajos de teclado del navegador (los de Chrome/Edge). `fromPage` indica si la tecla se pulsó dentro de la página web
 * (Esc solo detiene la carga si viene de la página y hay una carga en curso).
 *
 * Los atajos con Ctrl exigen que Alt NO esté pulsado: en teclados como el español, AltGr equivale a Ctrl+Alt y se usa
 * para escribir caracteres (@, #, €…), que nunca deben disparar un atajo.
 */
export function matchShortcut(input: Input, ctx: { fromPage: boolean; isLoading: boolean }): ShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  const ctrl = (input.control || input.meta) && !input.alt;
  const shift = input.shift;
  const key = input.key;
  const k = key.length === 1 ? key.toLowerCase() : key;
  const code = input.code ?? '';

  // Barra de direcciones
  if ((ctrl && !shift && k === 'l') || (input.alt && !input.control && k === 'd') || (k === 'F6' && !input.control && !input.alt)) return 'focus-address-bar';

  // Buscar entre las pestañas abiertas
  if (ctrl && shift && k === 'a') return 'tab-search';

  // Administrador de tareas (como en Chrome y Edge)
  if (shift && !input.control && !input.meta && !input.alt && k === 'Escape') return 'task-manager';

  // Navegación
  if ((input.alt && !input.control && k === 'ArrowLeft') || k === 'BrowserBack') return 'back';
  if ((input.alt && !input.control && k === 'ArrowRight') || k === 'BrowserForward') return 'forward';
  if ((ctrl && k === 'F5') || (shift && !input.control && k === 'F5') || (ctrl && shift && k === 'r')) return 'reload-ignore-cache';
  if ((k === 'F5' && !input.control) || (ctrl && !shift && k === 'r') || k === 'BrowserRefresh') return 'reload';
  if (k === 'Escape' && ctx.fromPage && ctx.isLoading) return 'stop';
  if (k === 'F12' || (ctrl && shift && k === 'i')) return 'devtools';

  // Pestañas y ventanas
  if (ctrl && shift && k === 't') return 'reopen-closed-tab';
  if (ctrl && !shift && k === 't') return 'new-tab';
  if (ctrl && shift && k === 'w') return 'close-window';
  if (ctrl && !shift && (k === 'w' || k === 'F4')) return 'close-tab';
  if (ctrl && !shift && k === 'n') return 'new-window';
  if (ctrl && shift && k === 'n') return 'new-private-window';
  if (ctrl && shift && k === 'k') return 'duplicate-tab';
  if (ctrl && !shift && k === 'h') return 'history';
  if (ctrl && !shift && k === 'j') return 'downloads';
  if (ctrl && !shift && k === 'd') return 'bookmark-page';
  if (ctrl && shift && k === 'b') return 'toggle-bookmarks-bar';
  if (ctrl && shift && k === 'o') return 'bookmarks';
  if ((ctrl && !shift && k === 'Tab') || (ctrl && !shift && k === 'PageDown')) return 'next-tab';
  if ((ctrl && shift && k === 'Tab') || (ctrl && !shift && k === 'PageUp')) return 'prev-tab';
  if (ctrl && !shift) {
    // Por código físico, para que funcione igual en distribuciones de teclado donde los dígitos requieren Shift
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(k) ? k : undefined);
    if (digit === '9') return 'select-last-tab';
    if (digit) return `select-tab-${Number(digit) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  }

  // Buscar en la página
  if (ctrl && !shift && k === 'f') return 'find';
  if ((k === 'F3' && !shift && !input.control && !input.alt) || (ctrl && !shift && k === 'g')) return 'find-next';
  if ((k === 'F3' && shift && !input.control && !input.alt) || (ctrl && shift && k === 'g')) return 'find-prev';

  // Zoom (Ctrl + / Ctrl = / Ctrl - / Ctrl 0, incluidas las del teclado numérico)
  if (ctrl && (k === '+' || k === '=' || code === 'NumpadAdd')) return 'zoom-in';
  if (ctrl && !shift && (k === '-' || code === 'NumpadSubtract')) return 'zoom-out';
  if (ctrl && !shift && (k === '0' || code === 'Digit0' || code === 'Numpad0')) return 'zoom-reset';

  return null;
}
