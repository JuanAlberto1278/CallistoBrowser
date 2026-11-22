import type { SavedSession, SessionStore } from './session-store';

const DELAY_MS = 2000;

/**
 * Guarda la sesión (ventanas y pestañas) poco después de cada cambio, agrupando cambios seguidos, para que un cierre
 * inesperado no la pierda. Al cerrar la última ventana (o al salir) guarda en el acto y deja de guardar: a partir de
 * ahí las ventanas se destruyen y una sesión "vacía" pisaría la buena.
 */
export class SessionSaver {
  private timer: NodeJS.Timeout | null = null;
  private frozen = false;

  constructor(
    private readonly store: SessionStore,
    private readonly collect: () => SavedSession,
    private readonly isLastWindow: (w: unknown) => boolean,
  ) {}

  markDirty(): void {
    if (this.frozen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, DELAY_MS);
  }

  saveNow(): void {
    if (this.frozen) return;
    try {
      this.store.save(this.collect());
    } catch (e) {
      console.error('No se pudo guardar la sesión:', e);
    }
  }

  /** Una ventana se está cerrando. Si es la última, la sesión queda guardada con ella. */
  windowClosing(w: unknown): void {
    if (this.isLastWindow(w)) this.finalSave();
    else this.markDirty();
  }

  finalSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.saveNow();
    this.frozen = true;
  }
}
