import type { Input } from 'electron';

export type ShortcutAction =
  | 'focus-address-bar'
  | 'back'
  | 'forward'
  | 'reload'
  | 'reload-ignore-cache'
  | 'stop'
  | 'devtools'
  | 'close-window';

/**
 * Atajos de teclado del navegador. `fromPage` indica si la tecla se pulsó dentro de la página web
 * (Esc solo detiene la carga si viene de la página y hay una carga en curso).
 */
export function matchShortcut(input: Input, ctx: { fromPage: boolean; isLoading: boolean }): ShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  const ctrl = input.control || input.meta;
  const key = input.key;
  const k = key.length === 1 ? key.toLowerCase() : key;

  if ((ctrl && !input.shift && k === 'l') || (input.alt && !ctrl && k === 'd') || (k === 'F6' && !ctrl && !input.alt)) return 'focus-address-bar';
  if ((input.alt && k === 'ArrowLeft') || k === 'BrowserBack') return 'back';
  if ((input.alt && k === 'ArrowRight') || k === 'BrowserForward') return 'forward';
  if ((ctrl && k === 'F5') || (input.shift && k === 'F5') || (ctrl && input.shift && k === 'r')) return 'reload-ignore-cache';
  if (k === 'F5' || (ctrl && !input.shift && k === 'r') || k === 'BrowserRefresh') return 'reload';
  if (k === 'Escape' && ctx.fromPage && ctx.isLoading) return 'stop';
  if (k === 'F12' || (ctrl && input.shift && k === 'i')) return 'devtools';
  if (ctrl && (k === 'w' || k === 'F4')) return 'close-window';
  return null;
}
