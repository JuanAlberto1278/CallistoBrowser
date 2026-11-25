import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip, listZip, safeEntryName, ZipError } from '../../src/main/extensions/unzip';
import { CrxError, idFromPublicKey, parseAndVerifyCrx } from '../../src/main/extensions/crx';
import { migrate } from '../../src/main/db';
import { compareVersions, crxUrl, ExtensionRegistry, parseUpdateCheck, unpackCrx, updateCheckUrl } from '../../src/main/extensions/installer';
import { localizedText, permissionWarnings, siteAccess, unsupportedPermissions } from '../../src/shared/extensions';

// ---------------------------------------------------------------- ZIP de prueba

interface Entry {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** Mentir el tamaño declarado (bomba) o el CRC (dañado). */
  declaredSize?: number;
  crc?: number;
  symlink?: boolean;
  flags?: number;
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(e.symlink ? (0o120777 << 16) >>> 0 : 0, 38);
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

const MANIFEST = Buffer.from(JSON.stringify({ manifest_version: 3, name: 'Prueba', version: '1.0' }));

describe('extractor de ZIP propio', () => {
  it('extrae archivos y carpetas, comprimidos o no', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callisto-zip-'));
    try {
      const dest = join(dir, 'ext');
      const files = extractZip(zip([{ name: 'manifest.json', data: MANIFEST }, { name: 'js/', method: 0 }, { name: 'js/a.js', data: Buffer.from('x'.repeat(5000)) }, { name: 'raw.txt', data: Buffer.from('hola'), method: 0 }]), dest);
      expect(files.sort()).toEqual(['js/a.js', 'manifest.json', 'raw.txt']);
      expect(readFileSync(join(dest, 'js', 'a.js'), 'utf8')).toBe('x'.repeat(5000));
      expect(readFileSync(join(dest, 'raw.txt'), 'utf8')).toBe('hola');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rechaza rutas peligrosas', () => {
    for (const bad of ['../fuera.txt', 'a/../../fuera.txt', '/abs.txt', 'C:/win.txt', 'C:x', 'a\\..\\..\\x', 'ads.txt:secreto', 'nul\0.txt', 'a/./b', 'con|x']) {
      expect(() => safeEntryName(bad), bad).toThrow(ZipError);
    }
    expect(safeEntryName('a\\b.js')).toBe('a/b.js');
    expect(() => listZip(zip([{ name: '../../evil.js', data: Buffer.from('x') }]))).toThrow(ZipError);
  });

  it('rechaza enlaces simbólicos, cifrado, duplicados y compresión desconocida', () => {
    expect(() => listZip(zip([{ name: 'link', data: Buffer.from('/etc/passwd'), symlink: true }]))).toThrow(/simbólico/);
    expect(() => listZip(zip([{ name: 'a.js', data: Buffer.from('x'), flags: 1 }]))).toThrow(/cifrado/);
    expect(() => listZip(zip([{ name: 'A.js', data: Buffer.from('x') }, { name: 'a.js', data: Buffer.from('y') }]))).toThrow(/repetido/);
    const z = zip([{ name: 'a.js', data: Buffer.from('x'), method: 0 }]);
    const cen = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt16LE(14, cen + 10); // LZMA
    expect(() => listZip(z)).toThrow(/Compresión/);
  });

  it('bombas de descompresión y datos dañados: no escribe nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callisto-zip-'));
    try {
      // Declara 10 bytes pero descomprime 10 MB: se corta en lo declarado y se rechaza
      const bomb = zip([{ name: 'manifest.json', data: MANIFEST }, { name: 'bomba.bin', data: Buffer.alloc(10 * 1024 * 1024), declaredSize: 10 }]);
      expect(() => extractZip(bomb, join(dir, 'a'))).toThrow(ZipError);
      expect(readdirSync(dir)).toEqual([]); // nada a medias
      // Declara más de lo permitido
      expect(() => listZip(zip([{ name: 'x.bin', data: Buffer.from('x'), declaredSize: 2 ** 31 }]))).toThrow(/demasiado grande/);
      expect(() => listZip(zip([{ name: 'a', data: Buffer.from('x') }, { name: 'b', data: Buffer.from('y') }]), { maxEntries: 1, maxFileBytes: 10, maxTotalBytes: 10 })).toThrow(/demasiados/);
      // CRC incorrecto
      expect(() => extractZip(zip([{ name: 'a.js', data: Buffer.from('hola'), crc: 1234 }]), join(dir, 'b'))).toThrow(/dañado/);
      expect(() => listZip(Buffer.from('esto no es un zip'))).toThrow(ZipError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nunca sobrescribe lo que ya existe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callisto-zip-'));
    try {
      writeFileSync(join(dir, 'manifest.json'), 'original');
      expect(() => extractZip(zip([{ name: 'manifest.json', data: MANIFEST }]), dir)).toThrow();
      expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe('original');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- CRX de prueba

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
const field = (tag: number, bytes: Buffer) => Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes]);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { der: publicKey.export({ type: 'spki', format: 'der' }), privateKey };
}

/** CRX3 firmado por `developer` y (opcionalmente) por `publisher`; `tamper` altera el ZIP después de firmar. */
function crx(developer: ReturnType<typeof keyPair>, publisher: ReturnType<typeof keyPair> | null, opts: { declaredId?: string; tamper?: boolean } = {}): Buffer {
  const archive = zip([{ name: 'manifest.json', data: MANIFEST }]);
  const idHex = createHash('sha256').update(developer.der).digest().subarray(0, 16);
  const crxId = opts.declaredId ? Buffer.from(opts.declaredId.split('').map((c) => (c.charCodeAt(0) - 97).toString(16)).join(''), 'hex') : idHex;
  const signed = field(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signed.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), len, signed, archive]);
  const proof = (k: ReturnType<typeof keyPair>) => field(2, Buffer.concat([field(1, k.der), field(2, sign('sha256', message, k.privateKey))]));
  const header = Buffer.concat([proof(developer), ...(publisher ? [proof(publisher)] : []), field(10000, signed)]);
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  const body = Buffer.from(archive);
  if (opts.tamper) body[40] ^= 0xff;
  return Buffer.concat([head, header, body]);
}

describe('verificación de CRX (firma del desarrollador y de la Chrome Web Store)', () => {
  const dev = keyPair();
  const store = keyPair();
  const storeHash = createHash('sha256').update(store.der).digest('hex');
  const id = idFromPublicKey(dev.der);

  it('acepta un paquete firmado por el desarrollador y por la tienda, con el ID pedido', () => {
    const r = parseAndVerifyCrx(crx(dev, store), id, storeHash);
    expect(r.id).toBe(id);
    expect(r.publicKey).toBe(dev.der.toString('base64'));
    expect(listZip(r.zip).map((e) => e.name)).toEqual(['manifest.json']);
  });

  it('rechaza: sin firma de la tienda, otra extensión, contenido alterado, clave que no es la del ID', () => {
    expect(() => parseAndVerifyCrx(crx(dev, null), id, storeHash)).toThrow(/Chrome Web Store/);
    expect(() => parseAndVerifyCrx(crx(dev, store), 'a'.repeat(32), storeHash)).toThrow(/otra extensión/);
    expect(() => parseAndVerifyCrx(crx(dev, store, { tamper: true }), id, storeHash)).toThrow(CrxError);
    // Declara el ID de otra extensión firmando con una clave que no es la suya
    const other = idFromPublicKey(keyPair().der);
    expect(() => parseAndVerifyCrx(crx(dev, store, { declaredId: other }), other, storeHash)).toThrow(/desarrollador/);
    // Con la clave real de la tienda (Google), una firma propia nunca pasa
    expect(() => parseAndVerifyCrx(crx(dev, store), id)).toThrow(/Chrome Web Store/);
    expect(() => parseAndVerifyCrx(Buffer.from('PK\x03\x04 no es crx'), id)).toThrow(/CRX/);
  });
});

// ---------------------------------------------------------------- instalador, registro y textos

describe('instalador', () => {
  it('direcciones de la Chrome Web Store (descarga y consulta de actualización)', () => {
    const u = new URL(crxUrl('eimadpbcbfnmbkopoojfekhnkhdbieeh', '156.0.1.2'));
    expect(u.origin + u.pathname).toBe('https://clients2.google.com/service/update2/crx');
    expect(u.searchParams.get('response')).toBe('redirect');
    expect(new URLSearchParams(u.searchParams.get('x')!).get('id')).toBe('eimadpbcbfnmbkopoojfekhnkhdbieeh');
    const c = new URL(updateCheckUrl('eimadpbcbfnmbkopoojfekhnkhdbieeh', '4.9.0', '156.0'));
    expect(new URLSearchParams(c.searchParams.get('x')!).get('v')).toBe('4.9.0');
  });

  it('lee la respuesta real de actualización (hay versión nueva / no hay)', () => {
    const ok = '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7266" elapsed_seconds="21905"/><app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/x/EIMADPBCBFNMBKOPOOJFEKHNKHDBIEEH_4_9_135_0.crx" fp="1.0b78" hash_sha256="0b78" protected="0" size="858730" status="ok" version="4.9.135"/></app></gupdate>';
    const none = '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_days="7266" elapsed_seconds="21905"/><app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" cohort="1::" cohortname="" status="ok"><updatecheck _esbAllowlist="true" status="noupdate"/></app></gupdate>';
    expect(parseUpdateCheck(ok, 'eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBe('4.9.135');
    expect(parseUpdateCheck(none, 'eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBeNull();
    expect(parseUpdateCheck(ok, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(parseUpdateCheck(ok.replace('version="4.9.135"', 'version="1.0; rm -rf"'), 'eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBeNull();
  });

  it('compara versiones de extensiones', () => {
    expect(compareVersions('1.10', '1.9')).toBe(1);
    expect(compareVersions('2026.1116.1650', '2026.1116.1650')).toBe(0);
    expect(compareVersions('1.0', '1.0.0.1')).toBe(-1);
  });

  it('instala desde un CRX verificado: carpeta por versión, clave en el manifiesto, nada si falla', () => {
    const dev = keyPair();
    const store = keyPair();
    const storeHash = createHash('sha256').update(store.der).digest('hex');
    const id = idFromPublicKey(dev.der);
    const dir = mkdtempSync(join(tmpdir(), 'callisto-ext-'));
    try {
      const r = unpackCrx(crx(dev, store), id, dir, storeHash);
      expect(r.version).toBe('1.0');
      expect(r.dir).toMatch(/^1\.0_[0-9a-f]{8}$/);
      const manifest = JSON.parse(readFileSync(join(dir, id, r.dir, 'manifest.json'), 'utf8'));
      expect(manifest.key).toBe(dev.der.toString('base64'));
      // Paquete sin firma de la tienda: error y ninguna carpeta (ni a medias)
      const other = keyPair();
      const otherId = idFromPublicKey(other.der);
      expect(() => unpackCrx(crx(other, null), otherId, dir, storeHash)).toThrow(CrxError);
      expect(existsSync(join(dir, otherId)) ? readdirSync(join(dir, otherId)) : []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registro de extensiones: instalar, actualizar (devuelve la carpeta vieja), desactivar y quitar', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const reg = new ExtensionRegistry(db);
    const id = 'a'.repeat(32);
    expect(reg.put(id, 'Prueba', '1.0', '1.0_x')).toBeNull();
    expect(reg.put(id, 'Prueba', '1.1', '1.1_y')).toBe('1.0_x');
    reg.setEnabled(id, false);
    expect(reg.get(id)).toMatchObject({ version: '1.1', dir: '1.1_y', enabled: false });
    reg.remove(id);
    expect(reg.all()).toEqual([]);
  });
});

describe('permisos y compatibilidad (en palabras)', () => {
  it('acceso a sitios: todos, algunos, ninguno', () => {
    expect(siteAccess({ host_permissions: ['<all_urls>'] })).toBe('all');
    expect(siteAccess({ content_scripts: [{ matches: ['*://*/*'] }] })).toBe('all');
    expect(siteAccess({ host_permissions: ['https://*.github.com/*', 'https://example.com/*'] })).toEqual(['example.com', 'github.com']);
    expect(siteAccess({ permissions: ['storage'] })).toEqual([]);
  });

  it('advertencias como las de Chrome, sin repetir', () => {
    expect(permissionWarnings({ host_permissions: ['<all_urls>'], permissions: ['tabs', 'storage', 'bookmarks', 'webNavigation'] })).toEqual(['Leer y cambiar todos tus datos en todos los sitios web', 'Leer y cambiar tus favoritos']);
    expect(permissionWarnings({ permissions: ['tabs', 'webNavigation', 'notifications'] })).toEqual(['Leer tu historial de navegación', 'Mostrar notificaciones']);
    expect(permissionWarnings({ host_permissions: ['https://a.com/*', 'https://b.com/*'] })).toEqual(['Leer y cambiar tus datos en a.com y b.com']);
    expect(permissionWarnings({ permissions: ['storage', 'alarms'] })).toEqual([]);
  });

  it('lo que falta en Callisto, requerido u opcional', () => {
    expect(unsupportedPermissions({ permissions: ['storage', 'sidePanel', 'identity'], optional_permissions: ['userScripts', 'sidePanel'] })).toEqual([
      { permission: 'sidePanel', what: 'panel lateral', optional: false },
      { permission: 'userScripts', what: 'scripts de usuario', optional: true },
    ]);
    // identity funciona desde la 1.4.2 (launchWebAuthFlow)
    expect(unsupportedPermissions({ permissions: ['bookmarks', 'tabGroups', 'tabs', 'identity'] })).toEqual([]);
  });

  it('nombres traducidos (__MSG_…__)', () => {
    expect(localizedText('__MSG_extName__', { extname: { message: 'Mi extensión' } })).toBe('Mi extensión');
    expect(localizedText('Sin traducir', null)).toBe('Sin traducir');
    expect(localizedText('__MSG_falta__', {})).toBe('__MSG_falta__');
  });
});
