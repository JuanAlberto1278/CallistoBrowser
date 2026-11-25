import type { NavigationEntry } from 'electron';

/** Estado restaurable de una pestaña: su historial completo y la entrada activa. */
export interface TabSnapshot {
  entries: NavigationEntry[];
  index: number;
}

export type ClosedEntry = (
  | { kind: 'tab'; windowId: number; index: number; tab: TabSnapshot }
  | { kind: 'window'; tabs: TabSnapshot[]; active: number }
) & {
  /** Cuándo se cerró (ms; 1.4.2, para chrome.sessions: las sesiones anteriores no lo tienen). */
  time?: number;
};

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
      if (tabs.length !== entry.tabs.length) entry = { kind: 'window', tabs, active: 0, time: entry.time };
    }
    this.stack.push({ ...entry, time: entry.time ?? Date.now() });
    if (this.stack.length > LIMIT) this.stack.shift();
    this.onChange?.();
  }

  /** Saca una entrada cualquiera: 0 = la más reciente (como pop), 1 = la anterior… */
  take(fromNewest: number): ClosedEntry | undefined {
    const i = this.stack.length - 1 - fromNewest;
    if (!Number.isSafeInteger(fromNewest) || fromNewest < 0 || i < 0) return undefined;
    const [e] = this.stack.splice(i, 1);
    this.onChange?.();
    return e;
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

/** Texto de una entrada para el menú "Cerradas recientemente". */
export function closedLabel(e: ClosedEntry): string {
  if (e.kind === 'window') return `Ventana (${e.tabs.length} ${e.tabs.length === 1 ? 'pestaña' : 'pestañas'})`;
  const entry = e.tab.entries[e.tab.index] ?? e.tab.entries[e.tab.entries.length - 1];
  const title = entry?.title?.trim() || entry?.url || 'Pestaña';
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}
