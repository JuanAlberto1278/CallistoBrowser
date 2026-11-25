import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { averageCpu } from '../../src/main/cpu-average';
import { describeProcess, sortRows } from '../../src/main/task-rows';
import { localDay, MemorySavings, parseSavings } from '../../src/main/memory-savings';
import { matchShortcut } from '../../src/main/shortcuts';
import { appMenuTemplate } from '../../src/main/context-menu';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/shared/settings';
import { internalPageOf } from '../../src/shared/internal-pages';

describe('CPU promedio', () => {
  it('pondera cada muestra por el tiempo que mide', () => {
    // 3 muestras de 1 s: 10 %, 10 %, 40 % → 20 %
    const points = [
      { t: 1000, dt: 1000, cpu: 10 },
      { t: 2000, dt: 1000, cpu: 10 },
      { t: 3000, dt: 1000, cpu: 40 },
    ];
    expect(averageCpu(points, 3000, 3000)).toBeCloseTo(20);
    // Una muestra larga pesa más que una corta
    expect(averageCpu([{ t: 3000, dt: 2500, cpu: 0 }, { t: 3500, dt: 500, cpu: 60 }], 3500, 3000)).toBeCloseTo(10);
  });

  it('solo cuenta lo que cae dentro de la ventana', () => {
    const points = [
      { t: 1000, dt: 1000, cpu: 100 }, // fuera
      { t: 6000, dt: 5000, cpu: 20 }, // la mitad adentro
    ];
    expect(averageCpu(points, 6000, 2500)).toBeCloseTo(20);
  });

  it('sin datos suficientes (menos del 80 % de la ventana) no decide', () => {
    expect(averageCpu([], 5000, 1000)).toBeNull();
    expect(averageCpu([{ t: 5000, dt: 500, cpu: 90 }], 5000, 1000)).toBeNull();
    expect(averageCpu([{ t: 5000, dt: 800, cpu: 90 }], 5000, 1000)).toBeCloseTo(90);
  });
});

describe('Administrador de tareas: qué es cada proceso', () => {
  const sample = (type: string, extra: Partial<{ name: string; memoryKb: number; cpu: number; pid: number }> = {}) => ({ pid: 10, type, cpu: 1.26, memoryKb: 51_200, ...extra });

  it('los procesos de Callisto no se pueden finalizar', () => {
    expect(describeProcess(sample('Browser'), [])).toMatchObject({ kind: 'browser', title: 'Callisto (proceso principal)', canEnd: false, memoryMb: 50, cpu: 1.3 });
    expect(describeProcess(sample('GPU'), [])).toMatchObject({ kind: 'gpu', canEnd: false });
    expect(describeProcess(sample('Utility', { name: 'Network Service' }), [])).toMatchObject({ kind: 'utility', title: 'Servicio de red', canEnd: false });
    expect(describeProcess(sample('Utility', { name: 'Rare Service' }), [])).toMatchObject({ title: 'Servicio: Rare Service' });
    expect(describeProcess(sample('Tab'), [{ kind: 'ui', label: 'Interfaz de Callisto' }, { kind: 'ui', label: 'Interfaz de Callisto' }])).toMatchObject({
      kind: 'ui',
      title: 'Interfaz de Callisto (2 ventanas)',
      canEnd: false,
    });
    expect(describeProcess(sample('Tab'), [])).toMatchObject({ kind: 'other', canEnd: false });
  });

  it('una pestaña sola, o varias del mismo sitio que comparten el proceso', () => {
    expect(describeProcess(sample('Tab'), [{ kind: 'tabs', label: 'Pestaña: Correo' }])).toMatchObject({ kind: 'tabs', title: 'Pestaña: Correo', members: [], canEnd: true });
    const shared = describeProcess(sample('Tab'), [
      { kind: 'tabs', label: 'Pestaña: A' },
      { kind: 'tabs', label: 'Pestaña: B' },
    ]);
    expect(shared).toMatchObject({ kind: 'tabs', title: '2 pestañas del mismo sitio', members: ['Pestaña: A', 'Pestaña: B'], canEnd: true });
    expect(describeProcess(sample('Tab'), [{ kind: 'extension', label: 'Extensión: uBlock' }])).toMatchObject({ kind: 'extension', canEnd: true });
  });

  it('orden: principal, GPU, interfaz, servicios y después las páginas, las que más memoria usan primero', () => {
    const rows = sortRows([
      describeProcess(sample('Tab', { pid: 1, memoryKb: 10_240 }), [{ kind: 'tabs', label: 'Pestaña: chica' }]),
      describeProcess(sample('Tab', { pid: 2, memoryKb: 204_800 }), [{ kind: 'tabs', label: 'Pestaña: grande' }]),
      describeProcess(sample('Utility', { pid: 3, name: 'Network Service' }), []),
      describeProcess(sample('Browser', { pid: 4 }), []),
      describeProcess(sample('GPU', { pid: 5 }), []),
    ]);
    expect(rows.map((r) => r.pid)).toEqual([4, 5, 3, 2, 1]);
  });

  it('callisto://tasks es una página interna', () => {
    expect(internalPageOf('callisto://tasks/')).toBe('tasks');
  });
});

describe('memoria liberada hoy', () => {
  it('lo guardado vale solo para el mismo día y si es válido', () => {
    expect(parseSavings({ day: '2026-11-24', kb: 2048 }, '2026-11-24')).toEqual({ day: '2026-11-24', kb: 2048 });
    expect(parseSavings({ day: '2026-11-23', kb: 2048 }, '2026-11-24')).toEqual({ day: '2026-11-24', kb: 0 });
    expect(parseSavings({ day: '2026-11-24', kb: -5 }, '2026-11-24').kb).toBe(0);
    expect(parseSavings('basura', '2026-11-24').kb).toBe(0);
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('suma, se guarda y vuelve a cero al cambiar el día', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callisto-savings-'));
    const file = join(dir, 'memory-savings.json');
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 24, 23, 0));
      const s = new MemorySavings(file);
      s.add(100 * 1024);
      s.add(50 * 1024);
      s.add(-3);
      expect(s.todayMb).toBe(150);
      expect(new MemorySavings(file).todayMb).toBe(150); // se recuerda
      vi.setSystemTime(new Date(2026, 10, 25, 0, 30));
      expect(s.todayMb).toBe(0);
      expect(new MemorySavings(file).todayMb).toBe(0);
      writeFileSync(file, '{dañado');
      expect(new MemorySavings(file).todayMb).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('{dañado'); // no se toca hasta que haya algo que guardar
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atajo, menú y configuración', () => {
  it('Shift+Esc abre el Administrador de tareas (Esc solo, no)', () => {
    const key = (mods: Partial<{ shift: boolean; control: boolean }>) =>
      matchShortcut({ type: 'keyDown', key: 'Escape', code: 'Escape', control: false, shift: false, alt: false, meta: false, ...mods } as never, { fromPage: true, isLoading: false });
    expect(key({ shift: true })).toBe('task-manager');
    expect(key({})).not.toBe('task-manager');
    expect(key({ shift: true, control: true })).not.toBe('task-manager');
  });

  it('menú ⋯ → Administrador de tareas', () => {
    const noop = () => {};
    const taskManager = vi.fn();
    const actions = { newTab: noop, newWindow: noop, newPrivateWindow: noop, history: noop, downloads: noop, passwords: noop, extensions: noop, zoom: noop, find: noop, settings: noop, closeWindow: noop, taskManager };
    const items = appMenuTemplate({ zoomPercent: 100 }, actions) as MenuItemConstructorOptions[];
    const item = items.find((i) => i.label === 'Administrador de tareas')!;
    expect(item.accelerator).toBe('Shift+Esc');
    (item.click as unknown as () => void)();
    expect(taskManager).toHaveBeenCalled();
  });

  it('dormir antes con poca memoria: activado por defecto', () => {
    expect(DEFAULT_SETTINGS.sleepWhenLowMemory).toBe(true);
    expect(sanitizeSettings({}).sleepWhenLowMemory).toBe(true);
    expect(sanitizeSettings({ sleepWhenLowMemory: false }).sleepWhenLowMemory).toBe(false);
    expect(sanitizeSettings({ sleepWhenLowMemory: 1 }).sleepWhenLowMemory).toBe(true);
  });
});
