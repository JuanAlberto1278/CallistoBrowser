import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileRegistry, RegistryError } from '../../src/main/profile-registry';
import { SessionSaver } from '../../src/main/session-saver';
import { isProfileColor, isProfileId, sanitizeProfileName } from '../../src/shared/profiles';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-registro-'));
  file = join(dir, 'profiles.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('registro de perfiles', () => {
  it('sin archivo: un perfil "Personal"', () => {
    const r = new ProfileRegistry(file);
    expect(r.profiles.map((p) => [p.id, p.name])).toEqual([['default', 'Personal']]);
    expect(r.lastUsed).toBe('default');
  });

  it('crear, con id seguro para carpetas y un color libre; se guarda en disco', () => {
    const r = new ProfileRegistry(file);
    const p = r.create('  Trabajo  ', undefined);
    expect(p.name).toBe('Trabajo');
    expect(isProfileId(p.id)).toBe(true);
    expect(p.color).not.toBe('blue'); // el azul ya lo usa "Personal"
    const again = new ProfileRegistry(file);
    expect(again.profiles.map((x) => x.name)).toEqual(['Personal', 'Trabajo']);
    expect(existsSync(`${file}.tmp`)).toBe(false); // escritura atómica: no queda el temporal
  });

  it('editar nombre y color', () => {
    const r = new ProfileRegistry(file);
    const p = r.create('A', 'green');
    r.update(p.id, { name: 'Oficina', color: 'orange' });
    expect(r.get(p.id)).toMatchObject({ name: 'Oficina', color: 'orange' });
    r.update(p.id, { name: '   ', color: 'fucsia' }); // vacío y color inexistente: no cambian
    expect(r.get(p.id)).toMatchObject({ name: 'Oficina', color: 'orange' });
    expect(() => r.update('no-existe', { name: 'x' })).toThrow(RegistryError);
  });

  it('eliminar: no el último; sus archivos quedan pendientes de borrar; deja de ser el último usado', () => {
    const r = new ProfileRegistry(file);
    const p = r.create('Trabajo', 'green');
    r.setLastUsed(p.id);
    r.setLastActive(['default', p.id]);
    r.remove(p.id);
    expect(r.profiles.map((x) => x.id)).toEqual(['default']);
    expect(r.pendingDelete).toEqual([p.id]);
    expect(r.lastUsed).toBe('default');
    expect(r.lastActive).toEqual(['default']);
    expect(() => r.remove('default')).toThrow('al menos un perfil');
    r.deleted([p.id]);
    expect(r.pendingDelete).toEqual([]);
  });

  it('un archivo dañado o con datos raros no impide arrancar', () => {
    writeFileSync(file, '{ esto no es json');
    expect(new ProfileRegistry(file).profiles.map((p) => p.id)).toEqual(['default']);
    writeFileSync(
      file,
      JSON.stringify({ profiles: [{ id: '../../Windows', name: 'x' }, { id: 'ok-1', name: 'Bien', color: 'violeta' }, { id: 'ok-1', name: 'Repetido' }], lastUsed: 'nada', pendingDelete: ['../x', 'p-viejo'] }),
    );
    const r = new ProfileRegistry(file);
    expect(r.profiles).toEqual([{ id: 'ok-1', name: 'Bien', color: 'blue', created: 0 }]);
    expect(r.lastUsed).toBe('ok-1');
    expect(r.pendingDelete).toEqual(['p-viejo']); // nunca una ruta con ".."
  });

  it('nombres e ids', () => {
    expect(sanitizeProfileName('  Mi\u0007   perfil  ')).toBe('Mi perfil');
    expect(sanitizeProfileName('', 'Perfil 2')).toBe('Perfil 2');
    expect(sanitizeProfileName('x'.repeat(100))).toHaveLength(40);
    expect(isProfileId('p-1a2b3c4d')).toBe(true);
    for (const bad of ['', '../a', 'A B', 'C:\\x', 'x'.repeat(41)]) expect(isProfileId(bad)).toBe(false);
    expect(isProfileColor('teal')).toBe(true);
    expect(isProfileColor('fucsia')).toBe(false);
  });
});

describe('guardado de sesión por perfil', () => {
  it('al cerrar la última ventana guarda y se detiene; al volver a abrir el perfil, sigue guardando', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = new SessionSaver({ save, load: () => ({ version: 1, windows: [], closed: [] }) } as never, () => ({ version: 1, windows: [], closed: [] }), () => true);
    saver.windowClosing({});
    expect(save).toHaveBeenCalledTimes(1);
    saver.markDirty();
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1); // detenido
    saver.resume();
    saver.markDirty();
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(2);
    saver.disable(); // perfil eliminado
    saver.resume();
    saver.markDirty();
    saver.finalSave();
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

it('el archivo del registro es JSON legible', () => {
  const r = new ProfileRegistry(file);
  r.create('Trabajo', 'green');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  expect(data.version).toBe(1);
  expect(data.profiles).toHaveLength(2);
});
