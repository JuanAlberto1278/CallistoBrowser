import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { migrate } from '../../src/main/db';
import { PasswordVault, VaultError, decryptPassword, encryptPassword, type KeyWrapper } from '../../src/main/password-vault';
import { autofillBounds, isLoginOrigin, isUsernameLike, pickPasswordIndex, pickUsernameIndex, type FieldInfo } from '../../src/shared/passwords';

/** Envoltorio falso de la clave: "cifra" con XOR y un secreto propio (en la app es DPAPI vía safeStorage). */
function fakeWrapper(secret = 7, opts: { available?: boolean } = {}): KeyWrapper & { wraps: number } {
  const w = {
    wraps: 0,
    available: async () => opts.available !== false,
    wrap: async (s: string) => {
      w.wraps++;
      return Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ secret));
    },
    unwrap: async (b: Buffer) => {
      const s = Buffer.from(b.map((x) => x ^ secret)).toString('utf8');
      if (!/^[A-Za-z0-9+/=]{44}$/.test(s)) throw new Error('no se puede descifrar');
      return { secret: s, rewrap: false };
    },
  };
  return w;
}

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

const SITE = 'https://cuenta.ejemplo.com';

describe('cifrado de cada contraseña (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('ida y vuelta, y el cifrado no contiene la contraseña', () => {
    const blob = encryptPassword(key, SITE, 'ana', 'secreto-123');
    expect(blob.includes(Buffer.from('secreto-123'))).toBe(false);
    expect(decryptPassword(key, SITE, 'ana', blob)).toBe('secreto-123');
  });

  it('dos cifrados de lo mismo son distintos (IV aleatorio)', () => {
    expect(encryptPassword(key, SITE, 'ana', 'x').equals(encryptPassword(key, SITE, 'ana', 'x'))).toBe(false);
  });

  it('falla si el dato se alteró, si es de otro sitio/usuario o si la clave es otra', () => {
    const blob = encryptPassword(key, SITE, 'ana', 'secreto');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptPassword(key, SITE, 'ana', tampered)).toThrow();
    expect(() => decryptPassword(key, 'https://otro.com', 'ana', blob)).toThrow();
    expect(() => decryptPassword(key, SITE, 'beto', blob)).toThrow();
    expect(() => decryptPassword(randomBytes(32), SITE, 'ana', blob)).toThrow();
  });
});

describe('bóveda de un perfil', () => {
  it('crea la clave del perfil una vez y la guarda solo envuelta', async () => {
    const d = db();
    const w = fakeWrapper();
    const v = new PasswordVault(d, w);
    expect(await v.open()).toBe('ready');
    const row = d.prepare('SELECT wrapped FROM password_key').get() as { wrapped: Uint8Array };
    expect(Buffer.from(row.wrapped).length).toBe(44);
    // Otra instancia (reinicio) usa la misma clave: lo guardado se puede leer
    const id = await v.save(SITE, 'ana', 'secreto');
    const again = new PasswordVault(d, w);
    expect(await again.password(id)).toBe('secreto');
    expect(w.wraps).toBe(1);
  });

  it('en la base no hay contraseñas en texto plano', async () => {
    const d = db();
    const v = new PasswordVault(d, fakeWrapper());
    await v.save(SITE, 'ana', 'contraseña-muy-secreta');
    const rows = d.prepare('SELECT * FROM logins').all() as Array<Record<string, unknown>>;
    const dump = JSON.stringify(rows, (_k, val) => (val instanceof Uint8Array ? Buffer.from(val).toString('latin1') : val));
    expect(dump).not.toContain('contraseña-muy-secreta');
    expect(dump).not.toContain(Buffer.from('contraseña-muy-secreta').toString('latin1'));
  });

  it('guardar, buscar, sugerir por sitio exacto, editar y borrar', async () => {
    const v = new PasswordVault(db(), fakeWrapper());
    const a = await v.save(SITE, 'ana', 'uno');
    const b = await v.save(SITE, 'beto', 'dos');
    await v.save('https://otro.com', 'carla', 'tres');
    expect(v.list().map((l) => l.username)).toEqual(['ana', 'beto', 'carla']);
    expect(v.list('OTRO').map((l) => l.username)).toEqual(['carla']);
    expect(v.list('bet').map((l) => l.username)).toEqual(['beto']);
    // Solo el sitio exacto: ni otro esquema ni otro subdominio
    expect(v.forOrigin(SITE).map((l) => l.username).sort()).toEqual(['ana', 'beto']);
    expect(v.forOrigin('http://cuenta.ejemplo.com')).toEqual([]);
    expect(v.forOrigin('https://ejemplo.com')).toEqual([]);

    // El último usado va primero
    v.markUsed(b);
    expect(v.forOrigin(SITE)[0]!.username).toBe('beto');
    expect(v.get(b)!.timesUsed).toBe(1);

    await v.update(a, { username: 'ana.maria', password: 'nueva' });
    expect(v.get(a)!.username).toBe('ana.maria');
    expect(await v.password(a)).toBe('nueva');
    await expect(v.update(a, { username: 'beto' })).rejects.toThrow(VaultError);
    await v.update(a, { username: 'ana' }); // cambia solo el usuario: la contraseña se vuelve a cifrar
    expect(await v.password(a)).toBe('nueva');

    v.remove(a);
    expect(v.get(a)).toBeUndefined();
    await expect(v.password(a)).rejects.toThrow(VaultError);
  });

  it('distingue lo ya guardado, una contraseña cambiada y un usuario nuevo', async () => {
    const v = new PasswordVault(db(), fakeWrapper());
    const id = await v.save(SITE, 'ana', 'uno');
    expect(await v.check(SITE, 'ana', 'uno')).toEqual({ kind: 'same', id });
    expect(await v.check(SITE, 'ana', 'dos')).toEqual({ kind: 'update', id });
    expect(await v.check(SITE, 'beto', 'uno')).toEqual({ kind: 'new' });
    // Guardar otra vez el mismo usuario reemplaza la contraseña (no duplica)
    expect(await v.save(SITE, 'ana', 'dos')).toBe(id);
    expect(v.count()).toBe(1);
  });

  it('valida sitio, usuario y contraseña', async () => {
    const v = new PasswordVault(db(), fakeWrapper());
    await expect(v.save('callisto://history', 'a', 'b')).rejects.toThrow(VaultError);
    await expect(v.save('https://x.com/ruta', 'a', 'b')).rejects.toThrow(VaultError);
    await expect(v.save(SITE, 'a', '')).rejects.toThrow(VaultError);
    await expect(v.save(SITE, 'a'.repeat(2000), 'b')).rejects.toThrow(VaultError);
  });

  it('"Nunca guardar" por sitio', () => {
    const v = new PasswordVault(db(), fakeWrapper());
    v.block(SITE);
    v.block(SITE);
    v.block('javascript:alert(1)');
    expect(v.isBlocked(SITE)).toBe(true);
    expect(v.blocked()).toEqual([SITE]);
    v.unblock(SITE);
    expect(v.isBlocked(SITE)).toBe(false);
  });

  it('sin cifrado de Windows no guarda nada', async () => {
    const v = new PasswordVault(db(), fakeWrapper(7, { available: false }));
    expect(await v.open()).toBe('unavailable');
    await expect(v.save(SITE, 'ana', 'x')).rejects.toThrow(VaultError);
  });

  it('con una clave que no se puede desenvolver: ilegible, sin pisar lo guardado', async () => {
    const d = db();
    await new PasswordVault(d, fakeWrapper(7)).save(SITE, 'ana', 'x');
    const other = new PasswordVault(d, fakeWrapper(99)); // "otra cuenta de Windows"
    expect(await other.open()).toBe('unreadable');
    await expect(other.save(SITE, 'beto', 'y')).rejects.toThrow(VaultError);
    expect(other.count()).toBe(1);
    // Sin contraseñas guardadas, en cambio, se empieza con una clave nueva
    const d2 = db();
    await new PasswordVault(d2, fakeWrapper(7)).open();
    expect(await new PasswordVault(d2, fakeWrapper(99)).open()).toBe('ready');
  });
});

const f = (type: string, value = '', extra: Partial<FieldInfo> = {}): FieldInfo => ({ type, value, autocomplete: '', name: '', id: '', ...extra });

describe('formularios de inicio de sesión', () => {
  it('sitio: solo orígenes http(s) completos', () => {
    expect(isLoginOrigin('https://a.com')).toBe(true);
    expect(isLoginOrigin('http://localhost:8080')).toBe(true);
    expect(isLoginOrigin('https://a.com/')).toBe(false);
    expect(isLoginOrigin('file:///C:/x')).toBe(false);
    expect(isLoginOrigin('callisto://settings')).toBe(false);
    expect(isLoginOrigin('null')).toBe(false);
  });

  it('qué contraseña guardar', () => {
    expect(pickPasswordIndex([f('password', 'a')])).toBe(0);
    expect(pickPasswordIndex([f('password')])).toBe(-1);
    // Registro: contraseña y repetición
    expect(pickPasswordIndex([f('password', 'n'), f('password', 'n')])).toBe(0);
    // Cambio de contraseña: actual, nueva, repetida
    expect(pickPasswordIndex([f('password', 'vieja'), f('password', 'nueva'), f('password', 'nueva')])).toBe(1);
    // Marcada como nueva
    expect(pickPasswordIndex([f('password', 'vieja', { autocomplete: 'current-password' }), f('password', 'nueva', { autocomplete: 'new-password' })])).toBe(1);
  });

  it('qué campo es el usuario', () => {
    expect(pickUsernameIndex([f('text', 'ana'), f('password', 'x')], 1)).toBe(0);
    expect(pickUsernameIndex([f('email', 'a@b.c'), f('checkbox'), f('password', 'x')], 2)).toBe(0);
    expect(pickUsernameIndex([f('text', 'buscar'), f('text', 'ana'), f('password', 'x')], 2)).toBe(1);
    expect(pickUsernameIndex([f('text', 'ana', { autocomplete: 'username' }), f('text', 'otro'), f('password', 'x')], 2)).toBe(0);
    expect(pickUsernameIndex([f('password', 'x')], 0)).toBe(-1);
    expect(pickUsernameIndex([f('text', '123', { autocomplete: 'one-time-code' }), f('password', 'x')], 1)).toBe(-1);
  });

  it('campo de usuario suelto (inicio de sesión en dos pasos)', () => {
    expect(isUsernameLike(f('email'))).toBe(true);
    expect(isUsernameLike(f('text', '', { autocomplete: 'username' }))).toBe(true);
    expect(isUsernameLike(f('text', '', { name: 'login_usuario' }))).toBe(true);
    expect(isUsernameLike(f('text', '', { id: 'identifierId' }))).toBe(true);
    expect(isUsernameLike(f('text', '', { name: 'q' }))).toBe(false);
    expect(isUsernameLike(f('checkbox', '', { name: 'user' }))).toBe(false);
  });
});

describe('menú de sugerencias', () => {
  const page = { x: 0, y: 100, width: 1000, height: 600 };
  const win = { width: 1000, height: 700 };
  it('debajo del campo, con el zoom de la página', () => {
    const b = autofillBounds({ x: 100, y: 50, width: 300, height: 30 }, 1, page, win, 2)!;
    expect(b.y).toBe(100 + 50 + 30 + 2 - 6);
    expect(b.x).toBe(94);
    expect(b.width).toBe(312);
    const z = autofillBounds({ x: 100, y: 50, width: 300, height: 30 }, 2, page, win, 1)!;
    expect(z.x).toBe(194);
    expect(z.y).toBe(100 + 100 + 60 + 2 - 6);
  });
  it('arriba si abajo no entra, dentro de la ventana, y nada si el campo no está a la vista', () => {
    const b = autofillBounds({ x: 900, y: 560, width: 300, height: 30 }, 1, page, win, 3)!;
    expect(b.y + b.height).toBeLessThanOrEqual(100 + 560 + 6);
    expect(b.x + b.width).toBeLessThanOrEqual(1000);
    expect(autofillBounds({ x: 10, y: -80, width: 100, height: 30 }, 1, page, win, 1)).toBeNull();
    expect(autofillBounds({ x: 10, y: 700, width: 100, height: 30 }, 1, page, win, 1)).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('ayudante de Windows Hello', () => {
  const root = join(__dirname, '..', '..');
  it('se compila con lo que trae Windows y responde sin mostrar ningún cuadro', () => {
    execFileSync(process.execPath, [join(root, 'scripts', 'build-auth-helper.cjs')], { stdio: 'ignore' });
    const exe = join(root, 'build-native', 'callisto-auth.exe');
    expect(['hello', 'password']).toContain(execFileSync(exe, ['check'], { encoding: 'utf8' }).trim());
    // Argumentos inválidos: sale con error, sin preguntar nada
    let code = 0;
    try {
      execFileSync(exe, ['verify'], { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(3);
  });
});
