import type { NavigationEntry } from 'electron';

/** Estado restaurable de una pestaña: su historial completo y la entrada activa. */
export interface TabSnapshot {
  entries: NavigationEntry[];
  index: number;
}

export type ClosedEntry =
  | { kind: 'tab'; windowId: number; index: number; tab: TabSnapshot }
  | { kind: 'window'; tabs: TabSnapshot[]; active: number };

const LIMIT = 25;

/** Una pestaña vale la pena recordarla si visitó algo más que la página en blanco. */
export function isRestorable(s: TabSnapshot): boolean {
  return s.entries.some((e) => e.url !== '' && e.url !== 'about:blank');
}

/**
 * Pestañas y ventanas cerradas recientemente (Ctrl+Shift+T). Se guardan con la sesión, así que sobreviven a un
 * reinicio. `onChange` avisa para guardar.
 */
export class ClosedTabs {
  private readonly stack: ClosedEntry[];
  onChange: (() => void) | null = null;

  constructor(initial: ClosedEntry[] = []) {
    this.stack = initial.slice(-LIMIT);
  }

  /** Copia de la pila, de la más antigua a la más reciente. */
  entries(): ClosedEntry[] {
    return this.stack.slice();
  }

  push(entry: ClosedEntry): void {
    if (entry.kind === 'tab' && !isRestorable(entry.tab)) return;
    if (entry.kind === 'window') {
      const tabs = entry.tabs.filter(isRestorable);
      if (tabs.length === 0) return;
      if (tabs.length !== entry.tabs.length) entry = { kind: 'window', tabs, active: 0 };
    }
    this.stack.push(entry);
    if (this.stack.length > LIMIT) this.stack.shift();
    this.onChange?.();
  }

  pop(): ClosedEntry | undefined {
    const e = this.stack.pop();
    if (e) this.onChange?.();
    return e;
  }

  clear(): void {
    this.stack.length = 0;
    this.onChange?.();
  }

  get size(): number {
    return this.stack.length;
  }
}
