// Identificación del tipo real de una imagen por sus primeros bytes (no por lo que diga el servidor).
// Se usa para los favicons: solo se aceptan formatos de imagen conocidos y se reenvían a la interfaz con el tipo correcto.

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon' | 'image/bmp' | 'image/svg+xml';

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length > 6) return 'image/x-icon';
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  // SVG: texto que empieza (tras espacios, BOM, declaración XML o comentarios) con un elemento <svg
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Decodifica una URL data: (base64 o con escapes %) a bytes. Devuelve null si no es una URL data: válida. */
export function decodeDataUrl(url: string): Uint8Array | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  const meta = m[1]!;
  const data = m[2]!;
  try {
    if (/;base64$/i.test(meta)) {
      const bin = atob(data.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  } catch {
    return null;
  }
}

export function toDataUrl(mime: ImageMime, bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
