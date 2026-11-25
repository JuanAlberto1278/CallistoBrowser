// JavaScript e imágenes bloqueados por sitio (1.5), pestaña por pestaña.
//
// Se usa el protocolo de depuración de Chromium (el mismo que DevTools usa para "Desactivar JavaScript") solo en las
// pestañas cuyo sitio tiene algo bloqueado: Emulation.setScriptExecutionDisabled para JavaScript y Fetch (que hace
// fallar los pedidos de imágenes) para las imágenes, también en los iframes de otros sitios (cada uno es su propio
// "target": se conectan solos con Target.setAutoAttach y esperan a recibir los ajustes antes de arrancar).
//
// No se usa session.webRequest: con un oyente ahí, Electron deja de pasarles los pedidos a las extensiones
// (chrome.webRequest dejaba de funcionar para todas). Ver docs/18-v1.5.md.
import type { Debugger, WebContents } from 'electron';

export interface BlockState {
  javascript: boolean;
  images: boolean;
}

const NONE: BlockState = { javascript: false, images: false };
const same = (a: BlockState, b: BlockState) => a.javascript === b.javascript && a.images === b.images;

export class SiteContentBlocker {
  private state: BlockState = NONE;
  private attached = false;
  /** Sesiones de los iframes de otros procesos (modo "flatten"). */
  private readonly sessions = new Set<string>();
  private readonly onMessage = (_e: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => this.message(method, params, sessionId);
  private readonly onDetach = () => {
    this.attached = false;
    this.sessions.clear();
    this.dbg.off('message', this.onMessage);
    this.dbg.off('detach', this.onDetach);
  };

  constructor(private readonly wc: WebContents) {}

  private get dbg(): Debugger {
    return this.wc.debugger;
  }

  get current(): BlockState {
    return this.state;
  }

  /** Aplica lo que corresponde al sitio que se está abriendo (al empezar cada navegación del frame principal). */
  async apply(next: BlockState): Promise<void> {
    if (this.wc.isDestroyed()) return;
    if (same(next, this.state) && (this.attached || (!next.javascript && !next.images))) return;
    this.state = next;
    if (!next.javascript && !next.images) return this.release();
    if (!this.attached && !this.attach()) return;
    await Promise.all([this.configure(undefined), ...[...this.sessions].map((s) => this.configure(s))]);
  }

  dispose(): void {
    this.release();
  }

  private attach(): boolean {
    try {
      if (this.dbg.isAttached()) return false; // otro uso momentáneo (ver service-worker-reaper.ts): se reintenta en la próxima navegación
      this.dbg.attach('1.3');
    } catch {
      return false;
    }
    this.attached = true;
    this.dbg.on('message', this.onMessage);
    this.dbg.on('detach', this.onDetach);
    void this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return true;
  }

  private release(): void {
    if (!this.attached) return;
    const dbg = this.dbg;
    this.onDetach();
    try {
      if (!this.wc.isDestroyed() && dbg.isAttached()) dbg.detach(); // al desconectarse, Chromium quita los ajustes
    } catch {
      /* ya desconectado */
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.attached || this.wc.isDestroyed()) return Promise.resolve(undefined);
    // La página principal llega con sesión vacía (""), que Chromium no acepta al responder: es "sin sesión"
    return this.dbg.sendCommand(method, params, sessionId || undefined).catch(() => undefined);
  }

  /** Ajustes de un target (la página o un iframe). */
  private configure(sessionId: string | undefined): Promise<unknown> {
    const s = this.state;
    return Promise.all([
      this.send('Emulation.setScriptExecutionDisabled', { value: s.javascript }, sessionId),
      s.images ? this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Image', requestStage: 'Request' }] }, sessionId) : this.send('Fetch.disable', {}, sessionId),
    ]);
  }

  private message(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === 'Target.attachedToTarget') {
      const child = String(params.sessionId ?? '');
      if (!child) return;
      this.sessions.add(child);
      // Sus propios iframes también, y recién después de recibir los ajustes arranca
      void Promise.all([this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child), this.configure(child)]).then(() =>
        this.send('Runtime.runIfWaitingForDebugger', {}, child),
      );
    } else if (method === 'Target.detachedFromTarget') {
      this.sessions.delete(String(params.sessionId ?? ''));
    } else if (method === 'Fetch.requestPaused') {
      // Solo se piden las imágenes (ver configure): se rechazan como lo haría un bloqueador
      void this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId);
    }
  }
}
