import type { Session } from 'electron';
import { decodeDataUrl, sniffImage, toDataUrl } from '../shared/image-sniff';
import type { FaviconStore } from './profile-store';

/** Los favicons son pequeños; algo más grande no es un favicon razonable y no se procesa. */
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
const CACHE_LIMIT = 300;

/**
 * Descarga favicons con la sesión del perfil (sin cookies) y los devuelve como URL data: con el tipo real verificado.
 *
 * El proceso principal NO decodifica la imagen: solo comprueba por sus primeros bytes que sea un formato de imagen
 * conocido. La decodifica la interfaz con <img>, en su proceso con sandbox (que además entiende ICO, SVG, WebP…).
 */
export class FaviconLoader {
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly resolved = new Map<string, string>();

  /** `store`: favicons guardados en la base del perfil (se muestran al reiniciar sin volver a pedirlos). */
  constructor(private readonly session: Session, private readonly store?: FaviconStore) {}

  load(url: string): Promise<string | null> {
    let p = this.cache.get(url);
    if (!p) {
      const saved = this.store?.get(url);
      p = saved ? Promise.resolve(saved) : this.fetch(url).catch(() => null);
      p.then((data) => {
        if (!data) return;
        this.resolved.set(url, data);
        if (!saved && !url.startsWith('data:')) this.store?.put(url, data);
      });
      this.cache.set(url, p);
      if (this.cache.size > CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value!;
        this.cache.delete(oldest);
        this.resolved.delete(oldest);
      }
    }
    return p;
  }

  /** Favicon ya conocido (en memoria o guardado), sin descargar nada. */
  cached(url: string): string | undefined {
    return this.resolved.get(url) ?? this.store?.get(url);
  }

  private async fetch(url: string): Promise<string | null> {
    if (url.startsWith('data:')) {
      if (url.length > MAX_BYTES * 2) return null;
      const bytes = decodeDataUrl(url);
      return bytes ? this.validate(bytes) : null;
    }
    if (!/^https?:\/\//i.test(url)) return null;

    const res = await this.session.fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) return null;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return this.validate(bytes);
  }

  private validate(bytes: Uint8Array): string | null {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    const mime = sniffImage(bytes);
    return mime ? toDataUrl(mime, bytes) : null;
  }
}
