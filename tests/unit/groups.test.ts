import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { groupAtDrop, groupDropIndex, keepGroupsTogether, nextGroupColor, sanitizeGroupTitle } from '../../src/shared/tab-groups';
import { cleanSession } from '../../src/main/session-store';
import { tabMenuTemplate } from '../../src/main/context-menu';

const t = (id: string, groupId: number | null = null) => ({ id, groupId });
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id).join(' ');

describe('pestañas de un grupo siempre juntas', () => {
  it('reúne las pestañas de cada grupo donde aparece la primera', () => {
    expect(ids(keepGroupsTogether([t('a', 1), t('b'), t('c', 1), t('d', 2), t('e'), t('f', 2)]))).toBe('a c b d f e');
  });
  it('si ya están juntas no cambia nada', () => {
    const list = [t('a'), t('b', 1), t('c', 1), t('d')];
    expect(ids(keepGroupsTogether(list))).toBe('a b c d');
  });
});

describe('soltar una pestaña', () => {
  const list = [t('a', 1), t('b', 1), t('c'), t('d', 2)];
  it('entre dos pestañas del mismo grupo: se une', () => {
    expect(groupAtDrop(list, 1)).toBe(1);
  });
  it('en el borde de un grupo o fuera: sin grupo', () => {
    expect(groupAtDrop(list, 0)).toBeNull();
    expect(groupAtDrop(list, 2)).toBeNull();
    expect(groupAtDrop(list, 3)).toBeNull();
    expect(groupAtDrop(list, 4)).toBeNull();
  });
});

describe('soltar un grupo entero', () => {
  const rest = [t('x'), t('a', 1), t('b', 1), t('c', 1), t('y')];
  it('nunca adentro de otro grupo: va después de ese grupo', () => {
    expect(groupDropIndex(rest, 2)).toBe(4);
    expect(groupDropIndex(rest, 3)).toBe(4);
  });
  it('fuera de grupos, donde se soltó', () => {
    expect(groupDropIndex(rest, 0)).toBe(0);
    expect(groupDropIndex(rest, 1)).toBe(1);
    expect(groupDropIndex(rest, 5)).toBe(5);
    expect(groupDropIndex(rest, 99)).toBe(5);
  });
});

describe('colores y nombres', () => {
  it('el primer color libre', () => {
    expect(nextGroupColor([])).toBe('grey');
    expect(nextGroupColor(['grey', 'blue'])).toBe('red');
  });
  it('nombres sin caracteres de control y acotados (vacío está permitido)', () => {
    expect(sanitizeGroupTitle('  Trabajo\u0007 ')).toBe('Trabajo ');
    expect(sanitizeGroupTitle('')).toBe('');
    expect(sanitizeGroupTitle('x'.repeat(100))).toHaveLength(60);
    expect(sanitizeGroupTitle(42)).toBe('');
  });
});

describe('grupos en la sesión guardada', () => {
  const entry = (url: string) => ({ url, title: url });
  it('valida grupos y descarta referencias a grupos que no existen', () => {
    const s = cleanSession({
      windows: [
        {
          tabs: [
            { entries: [entry('https://a.com/')], index: 0, groupId: 7 },
            { entries: [entry('https://b.com/')], index: 0, groupId: 99 },
            { entries: [entry('https://c.com/')], index: 0 },
          ],
          groups: [
            { id: 7, title: 'Trabajo', color: 'violeta', collapsed: true },
            { id: 8, title: 'Sin pestañas', color: 'blue' },
            'basura',
          ],
        },
      ],
    });
    const w = s.windows[0]!;
    expect(w.groups).toEqual([{ id: 7, title: 'Trabajo', color: 'grey', collapsed: true }]);
    expect(w.tabs.map((x) => x.groupId)).toEqual([7, null, null]);
  });
});

describe('menú de la pestaña: grupos', () => {
  const actions = () => ({
    newTabToRight: vi.fn(), newTab: vi.fn(), reload: vi.fn(), duplicate: vi.fn(), moveToNewWindow: vi.fn(), close: vi.fn(),
    closeOthers: vi.fn(), closeToRight: vi.fn(), reopenClosed: vi.fn(), addToNewGroup: vi.fn(), addToGroup: vi.fn(), removeFromGroup: vi.fn(),
  });
  const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? '—');

  it('sin grupos: solo "a un grupo nuevo"', () => {
    const items = tabMenuTemplate({ hasTab: true, tabCount: 2, tabsToRight: 1, canReopen: false, groupId: null, groups: [] }, actions());
    expect(labels(items)).toContain('Agregar la pestaña a un grupo nuevo');
    expect(labels(items)).not.toContain('Agregar la pestaña al grupo');
    expect(labels(items)).not.toContain('Quitar del grupo');
  });

  it('con grupos: submenú con los otros grupos (sin nombre: por color) y "Quitar del grupo"', () => {
    const a = actions();
    const items = tabMenuTemplate(
      { hasTab: true, tabCount: 3, tabsToRight: 1, canReopen: false, groupId: 1, groups: [{ id: 1, title: 'Actual', colorName: 'Azul' }, { id: 2, title: '', colorName: 'Verde' }, { id: 3, title: 'R&D', colorName: 'Rojo' }] },
      a,
    );
    const sub = items.find((i) => i.label === 'Agregar la pestaña al grupo')!.submenu as MenuItemConstructorOptions[];
    expect(sub.map((i) => i.label)).toEqual(['Grupo verde', 'R&&D']);
    (sub[0]!.click as unknown as () => void)();
    expect(a.addToGroup).toHaveBeenCalledWith(2);
    expect(labels(items)).toContain('Quitar del grupo');
  });
});
