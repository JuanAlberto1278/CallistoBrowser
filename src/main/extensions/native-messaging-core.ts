// Mensajería con programas instalados (chrome.runtime.connectNative / sendNativeMessage, 1.4.3): la parte pura, sin
// Electron (la prueban las pruebas unitarias). El resto está en native-messaging.ts.
//
// Protocolo de Chrome: cada mensaje es un JSON en UTF-8 precedido por su largo en bytes (4 bytes, little-endian). Del
// programa al navegador, como máximo 1 MB por mensaje.
import { dirname, isAbsolute, resolve } from 'node:path';

/** Mensajes del programa hacia la extensión: como máximo 1 MB (como en Chrome). */
export const MAX_HOST_MESSAGE = 1024 * 1024;
/** Mensajes de la extensión hacia el programa: como máximo 64 MB (Chrome permite más; esto alcanza y evita abusos). */
export const MAX_EXTENSION_MESSAGE = 64 * 1024 * 1024;

export interface NativeHostConfig {
  name: string;
  description: string;
  /** Ruta absoluta del programa (las relativas se resuelven contra la carpeta del manifiesto, como en Chrome). */
  path: string;
  allowedOrigins: string[];
}

/** Nombre válido de un programa (como en Chrome: minúsculas, números, _ y puntos entre partes). */
export function isValidHostName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 255 && /^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(name);
}

/** El manifiesto de un programa (el .json que registra), o null si no es válido para ese nombre. */
export function parseHostManifest(raw: unknown, manifestPath: string, expectedName: string): NativeHostConfig | null {
  const m = raw as { name?: unknown; description?: unknown; path?: unknown; type?: unknown; allowed_origins?: unknown } | null;
  if (!m || typeof m !== 'object') return null;
  if (m.name !== expectedName || m.type !== 'stdio' || typeof m.path !== 'string' || !m.path.trim()) return null;
  if (!Array.isArray(m.allowed_origins)) return null;
  const allowedOrigins = m.allowed_origins.filter((o): o is string => typeof o === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(o));
  const path = isAbsolute(m.path) ? m.path : resolve(dirname(manifestPath), m.path);
  return { name: m.name, description: typeof m.description === 'string' ? m.description.slice(0, 300) : '', path, allowedOrigins };
}

/** Un mensaje para el programa: el largo en bytes UTF-8 (no en caracteres) y el JSON. */
export function encodeNativeMessage(message: unknown): Buffer {
  const json = JSON.stringify(message ?? null);
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_EXTENSION_MESSAGE) throw new Error('Message exceeds maximum allowed size.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Lee los mensajes del programa a medida que llegan: un pedazo puede traer medio mensaje o varios juntos. `error` queda
 * con el motivo si el programa manda algo que no es válido (y ya no se lee más).
 */
export class NativeMessageReader {
  private buffer = Buffer.alloc(0);
  error: string | null = null;

  feed(chunk: Buffer): unknown[] {
    if (this.error) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_HOST_MESSAGE) {
        this.error = 'Error when communicating with the native messaging host.';
        return out;
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        this.error = 'Error when communicating with the native messaging host.';
        return out;
      }
    }
    return out;
  }
}

/**
 * Claves del registro donde un programa se registra para los navegadores basados en Chromium, en el orden en que se
 * buscan: Chrome y Edge (los programas se suelen registrar para alguno de los dos), del usuario y del equipo.
 */
export function registryKeys(name: string): string[] {
  const keys: string[] = [];
  for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) for (const hive of ['HKCU', 'HKLM']) keys.push(`${hive}\\Software\\${browser}\\NativeMessagingHosts\\${name}`);
  return keys;
}

/** Valor "(Predeterminado)" de la salida de `reg query <clave> /ve`, o null. */
export function parseRegDefault(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+\(.+?\)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** ¿Se arranca con cmd.exe? (como Chrome: los .bat y .cmd no se pueden ejecutar directamente) */
export const needsShell = (path: string) => /\.(bat|cmd)$/i.test(path);
