import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { shell, webContents as allWebContents, type DownloadItem, type Event, type Session, type WebContents } from 'electron';
import type { DownloadStore } from './download-store';
import { isDangerousFile, sanitizeFileName, siteOf, uniqueFileName, type DownloadEntry, type DownloadState } from '../shared/downloads';

/**
 * Pedido de autorización. Cuando existe, la descarga original YA se canceló: no hay nada guardado.
 */
export interface DownloadRequest {
  id: number;
  url: string;
  pageUrl: string;
  filename: string;
  mime: string;
  totalBytes: number;
  /** webContents que la inició (para volver a pedirla con su contexto). */
  sourceId: number | null;
  /** Ventana donde se pregunta (la asigna quien escucha 'request'). */
  windowId: number | null;
  dangerous: boolean;
}

interface Expected {
  url: string;
  path: string;
  entryId: number;
  mime: string;
  filename: string;
  timer: NodeJS.Timeout;
}

interface Pass {
  filename: string;
  path: string;
  entryId: number;
  timer: NodeJS.Timeout;
}

/** Tiempo para que llegue la re-descarga pedida al autorizar. */
const REDOWNLOAD_TIMEOUT_MS = 15_000;
/** Validez del pase "volvé a hacer clic". */
export const CLICK_PASS_MS = 60_000;

const ERRORS = {
  interrupted: 'La descarga se interrumpió (conexión, servidor o disco).',
  noClick: 'El sitio no permite volver a pedir este archivo y no se volvió a hacer clic a tiempo.',
  folder: 'No se pudo usar la carpeta de descargas.',
  closed: 'Callisto se cerró antes de que terminara.',
};

/**
 * Guardia y gestor de descargas (docs/01-v0.1-resultados.md §1.5):
 * 1. Toda descarga que no fue autorizada se CANCELA de inmediato en 'will-download' y se le pregunta al usuario.
 * 2. Al autorizar, Callisto la vuelve a pedir al sitio (downloadURL) y la guarda directo en la carpeta elegida.
 * 3. Si el sitio no permite volver a pedirla (formulario POST, enlace de un solo uso), queda un pase de un solo uso
 *    durante un minuto: el usuario vuelve a hacer clic y esa descarga se guarda sin volver a preguntar.
 * Mientras se decide, Chromium puede tener hasta ~512 KB en un archivo temporal de la cuarentena privada de Callisto
 * (nunca en una carpeta del usuario); al cancelar desaparece.
 */
export class DownloadManager extends EventEmitter<{ changed: []; request: [DownloadRequest] }> {
  private requests: DownloadRequest[] = [];
  private readonly live = new Map<number, DownloadItem>();
  private expected: Expected[] = [];
  private passes: Pass[] = [];
  /** Rutas reservadas por descargas en curso (para no pisar archivos entre sí). */
  private readonly reserved = new Set<string>();
  private seq = 0;
  private changedQueued = false;

  constructor(
    private readonly session: Session,
    private readonly store: DownloadStore,
    /** Carpeta de descargas configurada. */
    private readonly folder: () => string,
  ) {
    super();
    store.markUnfinishedAsInterrupted(ERRORS.closed);
    session.on('will-download', (event, item, wc) => this.onWillDownload(event, item, wc));
  }

  // ---------------------------------------------------------------- guardia

  private onWillDownload(event: Event, item: DownloadItem, wc: WebContents | undefined): void {
    const chain = item.getURLChain();
    const firstUrl = chain[0] ?? item.getURL();

    // 1. ¿Es la re-descarga que pidió Callisto al autorizar?
    const ei = this.expected.findIndex((x) => x.url === firstUrl);
    if (ei >= 0) {
      const exp = this.expected.splice(ei, 1)[0]!;
      clearTimeout(exp.timer);
      // Un formulario repetido como GET suele devolver una página en vez del archivo: no se guarda eso
      if (looksWrong(exp.mime, item.getMimeType())) {
        event.preventDefault();
        this.waitForClick(exp.entryId, exp.filename, exp.path);
        return;
      }
      item.setSavePath(exp.path);
      this.track(exp.entryId, item, true);
      return;
    }

    // 2. ¿Pase de un solo uso ("volvé a hacer clic")?
    const filename = sanitizeFileName(item.getFilename());
    const pi = this.passes.findIndex((p) => p.filename === filename);
    if (pi >= 0) {
      const pass = this.passes.splice(pi, 1)[0]!;
      clearTimeout(pass.timer);
      item.setSavePath(pass.path);
      this.track(pass.entryId, item, false);
      return;
    }

    // 3. Sin autorización: se cancela YA (nada se guarda) y se pregunta.
    event.preventDefault();
    const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
    const req: DownloadRequest = {
      id: ++this.seq,
      url: firstUrl,
      pageUrl,
      filename,
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      sourceId: wc && !wc.isDestroyed() ? wc.id : null,
      windowId: null,
      dangerous: isDangerousFile(filename),
    };
    this.requests.push(req);
    this.emit('request', req);
    this.queueChanged();
  }

  // ---------------------------------------------------------------- pedidos de autorización

  get pendingRequests(): readonly DownloadRequest[] {
    return this.requests;
  }

  requestsFor(windowId: number): DownloadRequest[] {
    return this.requests.filter((r) => r.windowId === windowId);
  }

  private take(id: number): DownloadRequest | undefined {
    const i = this.requests.findIndex((r) => r.id === id);
    return i >= 0 ? this.requests.splice(i, 1)[0] : undefined;
  }

  /** Rechazada: no se guarda nada (la original ya se había cancelado). */
  deny(id: number): void {
    if (this.take(id)) this.queueChanged();
  }

  /** Rechaza todos los pedidos de una ventana que se cierra. */
  denyForWindow(windowId: number): void {
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.windowId !== windowId);
    if (this.requests.length !== before) this.queueChanged();
  }

  /** Rechaza los pedidos que quedaron sin ventana donde preguntar. */
  denyWithoutWindow(): void {
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.windowId !== null);
    if (this.requests.length !== before) this.queueChanged();
  }

  /** Autorizada: se vuelve a pedir y se guarda en la carpeta de descargas (o en `customPath`, "Guardar como…"). */
  approve(id: number, customPath?: string): number | undefined {
    const req = this.take(id);
    if (!req) return undefined;
    const entryId = this.startAuthorized({ url: req.url, pageUrl: req.pageUrl, filename: req.filename, mime: req.mime, totalBytes: req.totalBytes, sourceId: req.sourceId }, customPath);
    this.queueChanged();
    return entryId;
  }

  /** Descarga elegida explícitamente por el usuario en Callisto ("Guardar imagen como…"): ya está autorizada. */
  startAuthorized(d: { url: string; pageUrl: string; filename: string; mime: string; totalBytes: number; sourceId: number | null }, customPath?: string): number {
    let path: string;
    try {
      path = customPath ?? this.uniquePath(this.folder(), d.filename);
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      const id = this.store.insert({ url: d.url, pageUrl: d.pageUrl, filename: d.filename, path: '', mime: d.mime, totalBytes: d.totalBytes, receivedBytes: 0, state: 'interrupted', error: ERRORS.folder });
      this.queueChanged();
      return id;
    }
    this.reserved.add(path.toLowerCase());
    const entryId = this.store.insert({ url: d.url, pageUrl: d.pageUrl, filename: basename(path), path, mime: d.mime, totalBytes: d.totalBytes, receivedBytes: 0, state: 'starting', error: null });
    this.redownload(entryId, d.url, d.mime, d.filename, path, d.sourceId);
    this.queueChanged();
    return entryId;
  }

  private redownload(entryId: number, url: string, mime: string, filename: string, path: string, sourceId: number | null): void {
    const exp: Expected = {
      url,
      path,
      entryId,
      mime,
      filename,
      timer: setTimeout(() => {
        this.expected = this.expected.filter((x) => x !== exp);
        this.waitForClick(entryId, filename, path);
      }, REDOWNLOAD_TIMEOUT_MS),
    };
    this.expected.push(exp);
    const wc = sourceId !== null ? allWebContents.fromId(sourceId) : undefined;
    try {
      // Con el contenido que la inició (mismas cookies; los blob: solo existen ahí)
      if (wc && !wc.isDestroyed()) wc.downloadURL(url);
      else this.session.downloadURL(url);
    } catch {
      clearTimeout(exp.timer);
      this.expected = this.expected.filter((x) => x !== exp);
      this.waitForClick(entryId, filename, path);
    }
  }

  /** El sitio no deja volver a pedir el archivo: pase de un solo uso para el próximo clic del usuario. */
  private waitForClick(entryId: number, filename: string, path: string): void {
    this.store.update(entryId, { state: 'waiting_click', error: null, receivedBytes: 0 });
    const pass: Pass = {
      filename,
      path,
      entryId,
      timer: setTimeout(() => {
        this.passes = this.passes.filter((p) => p !== pass);
        this.reserved.delete(path.toLowerCase());
        this.store.update(entryId, { state: 'interrupted', error: ERRORS.noClick });
        this.queueChanged();
      }, CLICK_PASS_MS),
    };
    this.passes.push(pass);
    this.queueChanged();
  }

  private uniquePath(dir: string, filename: string): string {
    const name = uniqueFileName(sanitizeFileName(filename), (candidate) => {
      const full = join(dir, candidate);
      return existsSync(full) || this.reserved.has(full.toLowerCase());
    });
    return join(dir, name);
  }

  // ---------------------------------------------------------------- seguimiento

  private track(entryId: number, item: DownloadItem, isRedownload: boolean): void {
    this.live.set(entryId, item);
    const path = item.getSavePath();
    const record = this.store.get(entryId);
    this.store.update(entryId, { state: 'in_progress', path, filename: basename(path), totalBytes: item.getTotalBytes(), mime: item.getMimeType() || record?.mime || '' });
    /** La re-descarga fue rechazada por el sitio: se pasó a "volvé a hacer clic" (lo que siga de este item no cuenta). */
    let toClick = false;
    const fallBackToClick = () => {
      toClick = true;
      this.live.delete(entryId);
      this.waitForClick(entryId, record?.filename ?? basename(path), path);
    };
    item.on('updated', (_e, state) => {
      // Un formulario repetido como GET (405) o un enlace vencido (410) deja la descarga interrumpida sin datos;
      // Chromium no siempre la da por terminada, así que se resuelve acá
      if (state === 'interrupted' && isRedownload && !toClick && item.getReceivedBytes() === 0) {
        fallBackToClick();
        item.cancel();
        return;
      }
      this.queueChanged();
    });
    item.once('done', (_e, state) => {
      if (toClick) return;
      this.live.delete(entryId);
      this.reserved.delete(path.toLowerCase());
      const received = item.getReceivedBytes();
      if (state === 'completed') {
        markOfTheWeb(path, record?.url ?? item.getURL(), record?.pageUrl ?? '');
        this.store.update(entryId, { state: 'completed', receivedBytes: received, totalBytes: item.getTotalBytes() || received, error: null });
      } else if (state === 'cancelled') {
        this.store.update(entryId, { state: 'cancelled', receivedBytes: 0, error: null });
      } else if (isRedownload && received === 0) {
        // El sitio rechazó la repetición (formulario, enlace vencido): se pide volver a hacer clic
        this.reserved.add(path.toLowerCase());
        fallBackToClick();
      } else {
        this.store.update(entryId, { state: 'interrupted', receivedBytes: received, error: ERRORS.interrupted });
      }
      this.queueChanged();
    });
    this.queueChanged();
  }

  private queueChanged(): void {
    if (this.changedQueued) return;
    this.changedQueued = true;
    setTimeout(() => {
      this.changedQueued = false;
      this.emit('changed');
    }, 150);
  }

  // ---------------------------------------------------------------- lista y acciones

  /** Descargas para mostrar (las más recientes primero), con los datos en vivo de las que están en curso. */
  entries(opts: { query?: string; limit?: number } = {}): DownloadEntry[] {
    return this.store.list(opts).map((r) => {
      const item = this.live.get(r.id);
      let state: DownloadState = r.state;
      let received = r.receivedBytes;
      let total = r.totalBytes;
      let bps = 0;
      let canResume = false;
      if (item) {
        received = item.getReceivedBytes();
        total = item.getTotalBytes();
        bps = item.getCurrentBytesPerSecond();
        canResume = item.canResume();
        state = item.getState() === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'in_progress';
      }
      return {
        id: r.id,
        url: r.url,
        site: siteOf(r.url, r.pageUrl),
        filename: r.filename,
        path: r.path,
        state,
        receivedBytes: received,
        totalBytes: total,
        bytesPerSecond: bps,
        canResume,
        error: item && state === 'interrupted' ? ERRORS.interrupted : r.error,
        startTime: r.startTime,
        exists: r.state === 'completed' && !!r.path && existsSync(r.path),
      };
    });
  }

  get activeCount(): number {
    return this.live.size + this.expected.length;
  }

  /** Progreso conjunto de las descargas en curso (0..1), o null si no se conoce. */
  get progress(): number | null {
    let received = 0;
    let total = 0;
    for (const item of this.live.values()) {
      const t = item.getTotalBytes();
      if (!t) return null;
      received += item.getReceivedBytes();
      total += t;
    }
    return total ? received / total : null;
  }

  pause(id: number): void {
    this.live.get(id)?.pause();
    this.queueChanged();
  }

  resume(id: number): void {
    const item = this.live.get(id);
    if (item?.canResume()) item.resume();
    this.queueChanged();
  }

  cancel(id: number): void {
    const item = this.live.get(id);
    if (item) {
      item.cancel();
      return;
    }
    // Esperando la re-descarga o el clic: se anula el pase
    const exp = this.expected.find((x) => x.entryId === id);
    const pass = this.passes.find((p) => p.entryId === id);
    for (const t of [exp?.timer, pass?.timer]) if (t) clearTimeout(t);
    this.expected = this.expected.filter((x) => x.entryId !== id);
    this.passes = this.passes.filter((p) => p.entryId !== id);
    const r = this.store.get(id);
    if (r && (r.state === 'starting' || r.state === 'waiting_click')) {
      this.reserved.delete(r.path.toLowerCase());
      this.store.update(id, { state: 'cancelled', error: null });
    }
    this.queueChanged();
  }

  /** Vuelve a intentar una descarga que falló o se canceló (el usuario ya la había autorizado). */
  retry(id: number): void {
    const r = this.store.get(id);
    if (!r || this.live.has(id) || !['interrupted', 'cancelled'].includes(r.state)) return;
    let path: string;
    try {
      path = this.uniquePath(this.folder(), r.filename);
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      this.store.update(id, { state: 'interrupted', error: ERRORS.folder });
      this.queueChanged();
      return;
    }
    this.reserved.add(path.toLowerCase());
    this.store.update(id, { state: 'starting', error: null, path, filename: basename(path), receivedBytes: 0 });
    this.redownload(id, r.url, r.mime, r.filename, path, null);
    this.queueChanged();
  }

  async open(id: number): Promise<void> {
    const r = this.store.get(id);
    if (r?.state === 'completed' && existsSync(r.path)) await shell.openPath(r.path);
  }

  showInFolder(id: number): void {
    const r = this.store.get(id);
    if (r && r.path && existsSync(r.path)) shell.showItemInFolder(r.path);
    else void shell.openPath(this.folder());
  }

  openFolder(): void {
    const dir = this.folder();
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* sin carpeta: openPath avisará */
    }
    void shell.openPath(dir);
  }

  /** Quita de la lista (no borra el archivo). Las que están en curso no se quitan. */
  remove(id: number): void {
    const r = this.store.get(id);
    if (!r || this.live.has(id) || r.state === 'starting' || r.state === 'waiting_click') return;
    this.store.remove(id);
    this.queueChanged();
  }

  clearFinished(): void {
    this.store.clearFinished();
    this.queueChanged();
  }
}

/** ¿La re-descarga trae otra cosa? (p. ej. una página HTML en vez del archivo que se había pedido). */
export function looksWrong(originalMime: string, newMime: string): boolean {
  const html = (m: string) => /^text\/html\b|^application\/xhtml/i.test(m);
  return !!originalMime && !html(originalMime) && html(newMime);
}

/**
 * Marca de "descargado de Internet" (Zone.Identifier), como Chrome y Edge: Windows SmartScreen y Office la usan para
 * advertir antes de abrir archivos descargados. Si Chromium ya la puso, no se toca.
 */
export function markOfTheWeb(path: string, url: string, pageUrl: string): void {
  if (process.platform !== 'win32') return;
  const ads = `${path}:Zone.Identifier`;
  try {
    if (existsSync(ads)) return;
    const web = (u: string) => /^https?:\/\//i.test(u) && u.length < 2048;
    const lines = ['[ZoneTransfer]', 'ZoneId=3'];
    if (web(pageUrl)) lines.push(`ReferrerUrl=${pageUrl}`);
    lines.push(`HostUrl=${web(url) ? url : 'about:internet'}`);
    writeFileSync(ads, lines.join('\r\n') + '\r\n');
  } catch {
    /* sistema de archivos sin flujos alternativos (FAT, exFAT, red): no se puede marcar */
  }
}
