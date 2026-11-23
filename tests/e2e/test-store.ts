// "Chrome Web Store" local para las pruebas de extensiones: arma CRX3 firmados con claves de prueba (desarrollador y
// "tienda") a partir de las carpetas de tests/fixtures/extensions, y los sirve como la tienda de prueba de Callisto
// (CALLISTO_TEST_EXTENSION_STORE, que solo existe sin empaquetar).
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const FIXTURES = resolve(__dirname, '../fixtures/extensions');

interface Key {
  der: Buffer;
  privateKey: KeyObject;
}

function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { der: publicKey.export({ type: 'spki', format: 'der' }), privateKey };
}

const idOf = (der: Buffer) =>
  createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = deflateRawSync(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc32(e.data), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

const field = (tag: number, bytes: Buffer) => {
  const v = (n: number) => {
    const out: number[] = [];
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return Buffer.from(out);
  };
  return Buffer.concat([v(tag * 8 + 2), v(bytes.length), bytes]);
};

function crx(archive: Buffer, developer: Key, publisher: Key): Buffer {
  const crxId = createHash('sha256').update(developer.der).digest().subarray(0, 16);
  const signed = field(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signed.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), len, signed, archive]);
  const proof = (k: Key) => field(2, Buffer.concat([field(1, k.der), field(2, sign('sha256', message, k.privateKey))]));
  const header = Buffer.concat([proof(developer), proof(publisher), field(10000, signed)]);
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, archive]);
}

export interface StoreExtension {
  id: string;
  name: string;
}

export class TestStore {
  private server!: Server;
  readonly publisher = newKey();
  /** Una "tienda" falsa: firma con otra clave (para probar que se rechaza). */
  private readonly impostor = newKey();
  private readonly items = new Map<string, { crx: Buffer; manifest: Record<string, unknown> }>();
  private readonly devKeys = new Map<string, Key>();
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const m = /^\/crx\/([a-p]{32})\.(crx|json|version)$/.exec(req.url ?? '');
      const item = m ? this.items.get(m[1]!) : undefined;
      if (!m || !item) {
        res.writeHead(404);
        return res.end();
      }
      if (m[2] === 'crx') {
        res.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' });
        return res.end(item.crx);
      }
      res.writeHead(200, { 'Content-Type': m[2] === 'json' ? 'application/json' : 'text/plain' });
      res.end(m[2] === 'json' ? JSON.stringify(item.manifest) : String(item.manifest.version));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/crx/`;
  }

  /** Variable de entorno para Callisto. */
  get env(): Record<string, string> {
    return { CALLISTO_TEST_EXTENSION_STORE: JSON.stringify({ base: this.base, publisherKeyHash: createHash('sha256').update(this.publisher.der).digest('hex') }) };
  }

  /** Publica (o actualiza) una extensión de tests/fixtures/extensions con la versión indicada. */
  publish(fixture: string, opts: { version?: string; forgedSignature?: boolean } = {}): StoreExtension {
    let dev = this.devKeys.get(fixture);
    if (!dev) {
      dev = newKey();
      this.devKeys.set(fixture, dev);
    }
    const dir = join(FIXTURES, fixture);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (opts.version) manifest.version = opts.version;
    const entries = files(dir).map((f) => {
      const name = relative(dir, f).replace(/\\/g, '/');
      return { name, data: name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : readFileSync(f) };
    });
    const id = idOf(dev.der);
    this.items.set(id, { crx: crx(zip(entries), dev, opts.forgedSignature ? this.impostor : this.publisher), manifest });
    return { id, name: String(manifest.name) };
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
