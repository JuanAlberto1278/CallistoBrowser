import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { keepPinnedFirst } from '../../src/shared/tab-order';
import { ClosedTabs, closedLabel, type ClosedEntry } from '../../src/main/closed-tabs';
import { buildSuggestions, matchesQuery, samePage } from '../../src/main/suggestions';
import { appMenuTemplate, tabMenuTemplate } from '../../src/main/context-menu';
import { matchShortcut } from '../../src/main/shortcuts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/shared/settings';
import { resolveInput } from '../../src/shared/omnibox';

const entry = (url: string, title = '') => ({ url, title, pageState: '' });
const tabEntry = (url: string, title = ''): ClosedEntry => ({ kind: 'tab', windowId: 1, index: 0, tab: { entries: [entry(url, title)], index: 0 } });

describe('pestañas fijadas', () => {
  it('van siempre primero, conservando el orden de cada parte', () => {
    const list = [
      { id: 1, pinned: false },
      { id: 2, pinned: true },
      { id: 3, pinned: false },
      { id: 4, pinned: true },
    ];
    expect(keepPinnedFirst(list).map((t) => t.id)).toEqual([2, 4, 1, 3]);
    expect(keepPinnedFirst([])).toEqual([]);
  });

  it('menú de la pestaña: Fijar / Desfijar; una fijada no muestra las opciones de grupo', () => {
    const actions = {
      newTabToRight: vi.fn(), newTab: vi.fn(), reload: vi.fn(), duplicate: vi.fn(), moveToNewWindow: vi.fn(), close: vi.fn(),
      closeOthers: vi.fn(), closeToRight: vi.fn(), reopenClosed: vi.fn(), addToNewGroup: vi.fn(), addToGroup: vi.fn(), removeFromGroup: vi.fn(),
      pin: vi.fn(), toggleMute: vi.fn(),
    };
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? '—');
    const base = { hasTab: true, tabCount: 2, tabsToRight: 1, canReopen: false, groupId: null, groups: [] };

    const normal = tabMenuTemplate({ ...base, pinned: false, muted: false }, actions);
    expect(labels(normal)).toEqual(expect.arrayContaining(['Fijar', 'Silenciar la pestaña', 'Agregar la pestaña a un grupo nuevo']));
    (normal.find((i) => i.label === 'Fijar')!.click as unknown as () => void)();
    expect(actions.pin).toHaveBeenCalled();

    const pinned = tabMenuTemplate({ ...base, pinned: true, muted: true }, actions);
    expect(labels(pinned)).toEqual(expect.arrayContaining(['Desfijar', 'Activar el sonido de la pestaña']));
    expect(labels(pinned)).not.toContain('Agregar la pestaña a un grupo nuevo');
    (pinned.find((i) => i.label === 'Activar el sonido de la pestaña')!.click as unknown as () => void)();
    expect(actions.toggleMute).toHaveBeenCalled();
  });
});

describe('cerradas recientemente', () => {
  it('take saca cualquier entrada contando desde la más reciente', () => {
    const c = new ClosedTabs([tabEntry('https://a.com/'), tabEntry('https://b.com/'), tabEntry('https://c.com/')]);
    let changes = 0;
    c.onChange = () => changes++;
    const second = c.take(1)!;
    expect(second.kind === 'tab' && second.tab.entries[0]!.url).toBe('https://b.com/');
    expect(c.entries().map((e) => (e.kind === 'tab' ? e.tab.entries[0]!.url : ''))).toEqual(['https://a.com/', 'https://c.com/']);
    expect(changes).toBe(1);
    expect(c.take(5)).toBeUndefined();
    expect(c.take(-1)).toBeUndefined();
    expect(c.take(0.5)).toBeUndefined();
    expect(c.entries()).toHaveLength(2);
  });

  it('texto de cada entrada: título, dirección o ventana', () => {
    expect(closedLabel(tabEntry('https://a.com/', 'Página A'))).toBe('Página A');
    expect(closedLabel(tabEntry('https://a.com/x'))).toBe('https://a.com/x');
    expect(closedLabel(tabEntry('https://a.com/', 'x'.repeat(80)))).toHaveLength(58);
    const win: ClosedEntry = { kind: 'window', tabs: [{ entries: [entry('https://a.com/')], index: 0 }, { entries: [entry('https://b.com/')], index: 0 }] } as ClosedEntry;
    expect(closedLabel(win)).toBe('Ventana (2 pestañas)');
  });

  it('menú ⋯: submenú con las cerradas (la primera con Ctrl+Shift+T) o "(vacío)"', () => {
    const noop = () => {};
    const actions = { newTab: noop, newWindow: noop, newPrivateWindow: noop, history: noop, downloads: noop, passwords: noop, extensions: noop, zoom: noop, find: noop, settings: noop, closeWindow: noop, installUpdate: noop };
    const reopen = vi.fn();
    const items = appMenuTemplate({ zoomPercent: 100, recentlyClosed: [{ label: 'R&D', click: reopen }, { label: 'Otra', click: noop }] }, actions) as MenuItemConstructorOptions[];
    const sub = items.find((i) => i.label === 'Cerradas recientemente')!.submenu as MenuItemConstructorOptions[];
    expect(sub.map((i) => i.label)).toEqual(['R&&D', 'Otra']);
    expect(sub[0]!.accelerator).toBe('Ctrl+Shift+T');
    expect(sub[1]!.accelerator).toBeUndefined();
    (sub[0]!.click as unknown as () => void)();
    expect(reopen).toHaveBeenCalled();

    const empty = appMenuTemplate({ zoomPercent: 100 }, actions) as MenuItemConstructorOptions[];
    const emptySub = empty.find((i) => i.label === 'Cerradas recientemente')!.submenu as MenuItemConstructorOptions[];
    expect(emptySub).toEqual([{ label: '(vacío)', enabled: false }]);
  });
});

describe('búsqueda unificada', () => {
  const row = (url: string, title: string) => ({ url, title, host: new URL(url).hostname, visitCount: 3, typedCount: 1, lastVisit: 0, iconUrl: null });
  const base = { engineName: 'Google', icon: () => null };
  const tab = (id: number, url: string, title: string) => ({ id, url, title, icon: null });

  it('coincidencia: todas las palabras, en el título o la dirección, sin importar mayúsculas', () => {
    expect(matchesQuery('correo trabajo', 'Correo - Trabajo', 'https://mail.com/')).toBe(true);
    expect(matchesQuery('mail', 'Bandeja', 'https://mail.com/inbox')).toBe(true);
    expect(matchesQuery('mail otra', 'Bandeja', 'https://mail.com/inbox')).toBe(false);
    expect(matchesQuery('https', 'x', 'https://a.com/')).toBe(false); // el esquema no cuenta
    expect(matchesQuery('  ', 'x', 'https://a.com/')).toBe(true);
  });

  it('misma página: sin importar www, la barra final ni el ancla', () => {
    expect(samePage('https://www.a.com/x/', 'https://a.com/x#arriba')).toBe(true);
    expect(samePage('https://a.com/x?q=1', 'https://a.com/x?q=2')).toBe(false);
    expect(samePage('http://a.com/', 'https://a.com/')).toBe(false);
  });

  it('si lo escrito ya está abierto, primero "cambiar a esa pestaña"; ir a la dirección queda como opción', () => {
    const items = buildSuggestions({ ...base, text: 'a.com', resolved: resolveInput('a.com'), inline: null, history: [row('https://a.com/', 'A')], tabs: [tab(7, 'https://a.com/', 'A')] });
    expect(items[0]).toMatchObject({ kind: 'tab', tabId: 7, url: 'https://a.com/' });
    expect(items[0]!.detail).toContain('Ya está abierta');
    expect(items[1]).toMatchObject({ kind: 'url', url: 'https://a.com/' });
    expect(items.filter((i) => i.kind === 'history')).toHaveLength(0); // no se repite como historial
  });

  it('pestañas y favoritos que coinciden van antes del historial, sin repetir direcciones', () => {
    const items = buildSuggestions({
      ...base,
      text: 'receta',
      resolved: resolveInput('receta'),
      inline: null,
      history: [row('https://cocina.com/receta-1', 'Receta 1'), row('https://cocina.com/receta-2', 'Receta 2'), row('https://cocina.com/otra', 'Otra receta')],
      tabs: [tab(3, 'https://cocina.com/receta-1', 'Receta 1'), tab(4, 'https://nada.com/', 'Nada')],
      bookmarks: [{ title: 'Recetas guardadas', url: 'https://cocina.com/receta-2', icon: null }],
    });
    expect(items.map((i) => i.kind)).toEqual(['search', 'tab', 'bookmark', 'history']);
    expect(items[1]).toMatchObject({ tabId: 3, detail: 'Cambiar a esta pestaña · cocina.com/receta-1' });
    expect(items[2]).toMatchObject({ url: 'https://cocina.com/receta-2', text: 'Recetas guardadas' });
    expect(items[3]).toMatchObject({ url: 'https://cocina.com/otra' });
  });

  it('con una sola letra no se sugieren pestañas ni favoritos (coincidiría casi todo)', () => {
    const items = buildSuggestions({ ...base, text: 'r', resolved: resolveInput('r'), inline: null, history: [], tabs: [tab(3, 'https://r.com/', 'R')], bookmarks: [{ title: 'R', url: 'https://r.com/', icon: null }] });
    expect(items.map((i) => i.kind)).toEqual(['search']);
  });

  it('Ctrl+Shift+A: buscar entre las pestañas abiertas', () => {
    const key = (k: string, mods: Partial<{ control: boolean; shift: boolean; alt: boolean }> = {}) =>
      matchShortcut({ type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, control: false, shift: false, alt: false, meta: false, ...mods } as never, { fromPage: true, isLoading: false });
    expect(key('A', { control: true, shift: true })).toBe('tab-search');
    expect(key('a', { control: true })).not.toBe('tab-search'); // Ctrl+A sigue siendo "seleccionar todo"
  });
});

describe('preguntar antes de cerrar varias pestañas', () => {
  it('activado por defecto; se respeta lo guardado', () => {
    expect(DEFAULT_SETTINGS.confirmCloseTabs).toBe(true);
    expect(sanitizeSettings({}).confirmCloseTabs).toBe(true);
    expect(sanitizeSettings({ confirmCloseTabs: false }).confirmCloseTabs).toBe(false);
    expect(sanitizeSettings({ confirmCloseTabs: 'no' }).confirmCloseTabs).toBe(true);
  });
});
