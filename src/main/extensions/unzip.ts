import { inflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// Extractor de ZIP propio para las extensiones (V0.10), en lugar de adm-zip (8 vulnerabilidades en 2026: sobrescritura
// por enlaces simbólicos, bombas de descompresión, rutas fuera de la carpeta…). Estricto a propósito: ante cualquier
// cosa rara, rechaza el archivo entero. Sin Electron, para probarlo aislado.
//
// - Solo "stored" (0) y "deflate" (8); sin cifrado, sin ZIP64, sin enlaces simbólicos.
// - Rutas relativas, sin "..", sin unidades, sin ":" (flujos alternativos de NTFS), sin duplicados (sin distinguir
//   mayúsculas, como Windows).
// - Límites de cantidad y tamaño; el tamaño descomprimido se limita al declarado y se verifica el CRC.
// - Escribe solo en una carpeta nueva y vacía, sin sobrescribir nada ('wx').

export class ZipError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** Las extensiones más grandes de la tienda pesan decenas de MB; el límite deja margen sin permitir bombas. */
export const DEFAULT_LIMITS: ZipLimits = { maxEntries: 20_000, maxFileBytes: 128 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

export interface ZipEntry {
  name: string;
  directory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Nombre seguro dentro de la carpeta de destino (separadores '/'), o error. */
export function safeEntryName(raw: string): string {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.includes('\0')) throw new ZipError('Nombre de archivo vacío o inválido en el ZIP.');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(`Ruta absoluta en el ZIP: ${raw}`);
  const parts = name.split('/');
  const last = parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts;
  for (const p of last) {
    if (p === '' || p === '.' || p === '..') throw new ZipError(`Ruta no permitida en el ZIP: ${raw}`);
    if (p.includes(':')) throw new ZipError(`Nombre no permitido en el ZIP: ${raw}`);
    if (/[<>"|?*\x00-\x1f]/.test(p)) throw new ZipError(`Nombre no permitido en el ZIP: ${raw}`);
  }
  return name;
}

/** Lee el directorio central y valida cada entrada (sin descomprimir). */
export function listZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
  // Fin del directorio central: en los últimos 22 + 65535 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('No es un ZIP válido.');
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) throw new ZipError('ZIP64 no soportado.');
  if (count > limits.maxEntries) throw new ZipError('El ZIP tiene demasiados archivos.');
  if (cenOffset + cenSize > eocd) throw new ZipError('Directorio del ZIP inválido.');

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError('Directorio del ZIP inválido.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('ZIP cifrado no soportado.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64 no soportado.');
    if (method !== 0 && method !== 8) throw new ZipError(`Compresión no soportada (${method}).`);
    const mode = (external >>> 16) & 0o170000;
    if (mode === 0o120000) throw new ZipError(`Enlace simbólico en el ZIP: ${rawName}`);
    const name = safeEntryName(rawName);
    const directory = name.endsWith('/');
    const key = name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) throw new ZipError(`Archivo repetido en el ZIP: ${rawName}`);
    seen.add(key);
    if (!directory) {
      if (size > limits.maxFileBytes) throw new ZipError(`Archivo demasiado grande en el ZIP: ${rawName}`);
      total += size;
      if (total > limits.maxTotalBytes) throw new ZipError('El contenido del ZIP es demasiado grande.');
      if (method === 0 && compressedSize !== size) throw new ZipError('Tamaños inconsistentes en el ZIP.');
    }
    entries.push({ name, directory, method, compressedSize, size, crc, localOffset });
  }
  return entries;
}

/** Contenido de una entrada, verificado (tamaño y CRC). */
export function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new ZipError('Encabezado local del ZIP inválido.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError('ZIP truncado.');
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (e.method === 0) data = Buffer.from(raw);
  else {
    try {
      // Nunca más de lo declarado (más 1 byte, para detectar que mintió)
      data = inflateRawSync(raw, { maxOutputLength: e.size + 1 });
    } catch {
      throw new ZipError(`No se pudo descomprimir ${e.name}.`);
    }
  }
  if (data.length !== e.size) throw new ZipError(`Tamaño incorrecto de ${e.name}.`);
  if (crc32(data) !== e.crc) throw new ZipError(`El contenido de ${e.name} está dañado.`);
  return data;
}

/**
 * Extrae todo en `dest`, que debe ser una carpeta nueva (se crea; si ya existe y tiene algo, falla al escribir porque
 * nunca se sobrescribe). Valida TODO antes de escribir el primer archivo.
 */
export function extractZip(buf: Buffer, dest: string, limits: ZipLimits = DEFAULT_LIMITS): string[] {
  const root = resolve(dest);
  const entries = listZip(buf, limits);
  const files = entries.map((e) => {
    const target = resolve(root, ...e.name.replace(/\/$/, '').split('/'));
    if (target !== root && !target.startsWith(root + sep)) throw new ZipError(`Ruta fuera de la carpeta: ${e.name}`);
    return { e, target };
  });
  // Primero se descomprime y verifica todo en memoria (dentro de los límites): un ZIP dañado no deja nada a medias
  const contents = files.map(({ e }) => (e.directory ? null : readEntry(buf, e)));
  mkdirSync(root, { recursive: true });
  const written: string[] = [];
  files.forEach(({ e, target }, i) => {
    if (e.directory) {
      mkdirSync(target, { recursive: true });
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents[i]!, { flag: 'wx' });
    written.push(e.name);
  });
  return written;
}
