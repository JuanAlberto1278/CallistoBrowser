// "Hoy las pestañas dormidas liberaron al menos X MB" (1.4.0).
//
// Se cuenta la memoria del proceso de una pestaña justo antes de dormirla, solo si esa pestaña era la única de su
// proceso: entonces el proceso termina y su memoria se libera entera. Si comparte el proceso con otras pestañas del mismo
// sitio no se puede saber cuánto libera, y no se cuenta (por eso "al menos").
import { readFileSync, writeFileSync } from 'node:fs';

interface Stored {
  /** Día local (AAAA-MM-DD). */
  day: string;
  kb: number;
}

export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Lo guardado, si es válido y es de hoy. */
export function parseSavings(raw: unknown, today: string): Stored {
  const r = raw as Partial<Stored> | null;
  if (r && typeof r === 'object' && r.day === today && typeof r.kb === 'number' && Number.isFinite(r.kb) && r.kb >= 0) return { day: today, kb: r.kb };
  return { day: today, kb: 0 };
}

export class MemorySavings {
  private state: Stored;

  constructor(private readonly file: string | null) {
    let raw: unknown = null;
    try {
      if (file) raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = null;
    }
    this.state = parseSavings(raw, localDay());
  }

  private rollover(): void {
    const today = localDay();
    if (this.state.day !== today) this.state = { day: today, kb: 0 };
  }

  /** Una pestaña dormida liberó `kb`. */
  add(kb: number): void {
    if (!Number.isFinite(kb) || kb <= 0) return;
    this.rollover();
    this.state.kb += kb;
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* solo es un dato informativo */
    }
  }

  get todayMb(): number {
    this.rollover();
    return Math.round(this.state.kb / 1024);
  }
}

let current = new MemorySavings(null);

export function configureMemorySavings(file: string): void {
  current = new MemorySavings(file);
}

export function memorySavings(): MemorySavings {
  return current;
}
