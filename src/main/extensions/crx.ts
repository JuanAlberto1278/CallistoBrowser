import { createHash, createPublicKey, verify } from 'node:crypto';

// Lectura y verificación de paquetes CRX3 de la Chrome Web Store (V0.10). Sin Electron, para probarlo aislado.
//
// Un CRX3 es: "Cr24" | versión 3 | largo del encabezado | encabezado (protobuf CrxFileHeader) | ZIP.
// El encabezado trae pruebas de firma (clave pública + firma) sobre:
//   "CRX3 SignedData\0" | largo (uint32 LE) de signed_header_data | signed_header_data | ZIP
// Callisto exige, como Chrome para la Web Store:
//   1. Una firma válida con la clave del desarrollador, cuyo hash da el ID declarado (el ID que se pidió).
//   2. Una firma válida de Google como publicador de la Web Store (clave con hash PUBLISHER_KEY_HASH).
// La librería electron-chrome-web-store no verificaba ninguna firma (solo comparaba el ID).

export class CrxError extends Error {}

/** SHA-256 de la clave pública con la que Google firma todo lo publicado en la Chrome Web Store (la de Chrome). */
export const PUBLISHER_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';

const MAX_HEADER = 256 * 1024;

export interface CrxProof {
  kind: 'rsa' | 'ecdsa';
  publicKey: Buffer;
  signature: Buffer;
}

export interface ParsedCrx {
  id: string;
  /** Clave pública del desarrollador (DER), en base64: va como "key" del manifiesto (fija el ID). */
  publicKey: string;
  zip: Buffer;
}

/** ID de extensión a partir de bytes en hex: los primeros 32 dígitos, 0-f → a-p. */
export function idFromHex(hex: string): string {
  return hex
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

export function idFromPublicKey(der: Buffer): string {
  return idFromHex(createHash('sha256').update(der).digest('hex'));
}

// ------------------------------------------------------------ protobuf mínimo (solo lo que usa CRX3)

function readVarint(b: Buffer, p: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (p >= b.length) throw new CrxError('Encabezado CRX truncado.');
    const x = b[p++]!;
    result += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [result, p];
    mul *= 128;
  }
  throw new CrxError('Encabezado CRX inválido.');
}

/** Campos de un mensaje protobuf: [número de campo, bytes] (solo tipo 2) o [número, número] (tipo 0). */
function fields(b: Buffer): Array<[number, Buffer | number]> {
  const out: Array<[number, Buffer | number]> = [];
  let p = 0;
  while (p < b.length) {
    let key: number;
    [key, p] = readVarint(b, p);
    const tag = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 2) {
      let len: number;
      [len, p] = readVarint(b, p);
      if (p + len > b.length) throw new CrxError('Encabezado CRX truncado.');
      out.push([tag, b.subarray(p, p + len)]);
      p += len;
    } else if (wire === 0) {
      let v: number;
      [v, p] = readVarint(b, p);
      out.push([tag, v]);
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else throw new CrxError('Encabezado CRX inválido.');
  }
  return out;
}

const bytesOf = (msg: Buffer, tag: number): Buffer | undefined => {
  const f = fields(msg).find(([t, v]) => t === tag && Buffer.isBuffer(v));
  return f ? (f[1] as Buffer) : undefined;
};

/**
 * Lee y verifica un CRX3. `expectedId`: el ID que se pidió a la tienda (si no coincide, se rechaza).
 * Devuelve el ZIP (todavía sin extraer) y la clave del desarrollador. (`publisherKeyHash` solo cambia en las pruebas.)
 */
export function parseAndVerifyCrx(buf: Buffer, expectedId: string, publisherKeyHash = PUBLISHER_KEY_HASH): ParsedCrx {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new CrxError('No es un paquete de extensión (CRX).');
  if (buf.readUInt32LE(4) !== 3) throw new CrxError('Formato de CRX no soportado (solo CRX3).');
  const headerLen = buf.readUInt32LE(8);
  if (headerLen > MAX_HEADER || 12 + headerLen > buf.length) throw new CrxError('Encabezado CRX inválido.');
  const header = buf.subarray(12, 12 + headerLen);
  const zip = buf.subarray(12 + headerLen);

  let signedData: Buffer | undefined;
  const proofs: CrxProof[] = [];
  for (const [tag, v] of fields(header)) {
    if (!Buffer.isBuffer(v)) continue;
    if (tag === 10000) signedData = v;
    else if (tag === 2 || tag === 3) {
      const publicKey = bytesOf(v, 1);
      const signature = bytesOf(v, 2);
      if (publicKey && signature) proofs.push({ kind: tag === 2 ? 'rsa' : 'ecdsa', publicKey, signature });
    }
  }
  if (!signedData) throw new CrxError('El CRX no tiene datos firmados.');
  const crxId = bytesOf(signedData, 1);
  if (!crxId || crxId.length !== 16) throw new CrxError('El CRX no declara su ID.');
  const id = idFromHex(crxId.toString('hex'));
  if (id !== expectedId) throw new CrxError(`El paquete es de otra extensión (${id}).`);

  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), len, signedData, zip]);
  const valid = (p: CrxProof) => {
    try {
      return verify('sha256', message, createPublicKey({ key: p.publicKey, format: 'der', type: 'spki' }), p.signature);
    } catch {
      return false;
    }
  };

  const developer = proofs.find((p) => p.kind === 'rsa' && idFromPublicKey(p.publicKey) === id);
  if (!developer || !valid(developer)) throw new CrxError('La firma del desarrollador no es válida.');
  const publisher = proofs.find((p) => createHash('sha256').update(p.publicKey).digest('hex') === publisherKeyHash);
  if (!publisher || !valid(publisher)) throw new CrxError('El paquete no está firmado por la Chrome Web Store.');

  return { id, publicKey: developer.publicKey.toString('base64'), zip };
}
