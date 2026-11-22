import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MenuItemConstructorOptions } from 'electron';
import { migrate } from '../../src/main/db';
import { BookmarkError, BookmarkStore } from '../../src/main/bookmark-store';
import { bookmarkItemMenu, bookmarksSubmenu, folderMenu, menuLabel, whereFromEvent } from '../../src/main/bookmark-menus';
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, isBookmarkableUrl, type BookmarkNode } from '../../src/shared/bookmarks';
import { sanitizeSettings } from '../../src/shared/settings';

function store(): BookmarkStore {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return new BookmarkStore(db);
}

const titles = (s: BookmarkStore, folder: number) => s.children(folder).map((n) => n.title);

describe('árbol de favoritos', () => {
  it('empieza con la barra y "Otros favoritos"', () => {
    const s = store();
    expect(s.folders()).toEqual([
      { id: BAR_FOLDER_ID, title: 'Barra de favoritos', depth: 0 },
      { id: OTHER_FOLDER_ID, title: 'Otros favoritos', depth: 0 },
    ]);
  });

  it('agrega al final o en una posición, y el orden se mantiene', () => {
    const s = store();
    s.addUrl(BAR_FOLDER_ID, 'A', 'https://a.com/');
    s.addUrl(BAR_FOLDER_ID, 'C', 'https://c.com/');
    s.addUrl(BAR_FOLDER_ID, 'B', 'https://b.com/', 1);
    expect(titles(s, BAR_FOLDER_ID)).toEqual(['A', 'B', 'C']);
    expect(s.children(BAR_FOLDER_ID).map((n) => n.position)).toEqual([0, 1, 2]);
  });

  it('sin nombre usa la dirección (página) o "Carpeta nueva"', () => {
    const s = store();
    s.addUrl(BAR_FOLDER_ID, '  ', 'https://a.com/');
    s.addFolder(BAR_FOLDER_ID, '');
    expect(titles(s, BAR_FOLDER_ID)).toEqual(['https://a.com/', 'Carpeta nueva']);
  });

  it('solo direcciones que se pueden abrir', () => {
    const s = store();
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'chrome://settings', 'callisto://ui/', 'file']) {
      expect(() => s.addUrl(BAR_FOLDER_ID, 'x', bad)).toThrow(BookmarkError);
    }
    expect(isBookmarkableUrl('callisto://history/')).toBe(true);
    expect(isBookmarkableUrl('file:///C:/doc.pdf')).toBe(true);
  });

  it('mover dentro de la misma carpeta y a otra', () => {
    const s = store();
    const a = s.addUrl(BAR_FOLDER_ID, 'A', 'https://a.com/');
    s.addUrl(BAR_FOLDER_ID, 'B', 'https://b.com/');
    const c = s.addUrl(BAR_FOLDER_ID, 'C', 'https://c.com/');
    s.move(c, BAR_FOLDER_ID, 0);
    expect(titles(s, BAR_FOLDER_ID)).toEqual(['C', 'A', 'B']);
    s.move(a, OTHER_FOLDER_ID);
    expect(titles(s, BAR_FOLDER_ID)).toEqual(['C', 'B']);
    expect(titles(s, OTHER_FOLDER_ID)).toEqual(['A']);
    expect(s.children(BAR_FOLDER_ID).map((n) => n.position)).toEqual([0, 1]); // sin huecos
  });

  it('una carpeta no se puede mover dentro de sí misma ni de sus subcarpetas', () => {
    const s = store();
    const f = s.addFolder(BAR_FOLDER_ID, 'F');
    const sub = s.addFolder(f, 'Sub');
    expect(() => s.move(f, f)).toThrow('dentro de sí misma');
    expect(() => s.move(f, sub)).toThrow('dentro de sí misma');
    s.move(sub, OTHER_FOLDER_ID);
    expect(titles(s, OTHER_FOLDER_ID)).toEqual(['Sub']);
  });

  it('las carpetas principales no se pueden cambiar, mover ni borrar', () => {
    const s = store();
    for (const root of [BAR_FOLDER_ID, OTHER_FOLDER_ID]) {
      expect(() => s.update(root, { title: 'x' })).toThrow(BookmarkError);
      expect(() => s.remove(root)).toThrow(BookmarkError);
      expect(() => s.move(root, OTHER_FOLDER_ID)).toThrow(BookmarkError);
    }
  });

  it('borrar una carpeta borra todo su contenido', () => {
    const s = store();
    const f = s.addFolder(BAR_FOLDER_ID, 'F');
    const sub = s.addFolder(f, 'Sub');
    s.addUrl(sub, 'X', 'https://x.com/');
    s.addUrl(f, 'Y', 'https://y.com/');
    expect(s.descendantCount(f)).toBe(3);
    s.remove(f);
    expect(s.children(BAR_FOLDER_ID)).toEqual([]);
    expect(s.findByUrl('https://x.com/')).toBeUndefined();
    expect(s.folders()).toHaveLength(2);
  });

  it('carpetas con su profundidad, en orden de árbol', () => {
    const s = store();
    const f = s.addFolder(BAR_FOLDER_ID, 'Trabajo');
    s.addFolder(f, 'Proyectos');
    expect(s.folders().map((x) => `${x.depth}:${x.title}`)).toEqual(['0:Barra de favoritos', '1:Trabajo', '2:Proyectos', '0:Otros favoritos']);
  });

  it('editar nombre y dirección; buscar sin interpretar comodines', () => {
    const s = store();
    const id = s.addUrl(BAR_FOLDER_ID, 'Diario', 'https://diario.com/');
    s.update(id, { title: 'El diario', url: 'https://eldiario.com/' });
    expect(s.get(id)).toMatchObject({ title: 'El diario', url: 'https://eldiario.com/' });
    expect(() => s.update(id, { url: 'javascript:x' })).toThrow(BookmarkError);
    expect(s.search('diario').map((n) => n.id)).toEqual([id]);
    expect(s.search('%')).toEqual([]);
    expect(s.findByUrl('https://eldiario.com/')?.id).toBe(id);
  });
});

// ---------------------------------------------------------------- menús

const node = (id: number, kind: 'url' | 'folder', title: string, url: string | null = null): BookmarkNode => ({ id, parentId: 1, kind, title, url, position: 0 });
const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === 'separator' ? '—' : i.label));

describe('menús de favoritos', () => {
  it('"&" se duplica (si no, Windows lo oculta) y los nombres largos se acortan', () => {
    expect(menuLabel('Rock & Roll')).toBe('Rock && Roll');
    expect(menuLabel('a'.repeat(100))).toHaveLength(60);
    expect(menuLabel('   ')).toBe('(sin nombre)');
  });

  it('Ctrl abre en segundo plano, Mayús en una ventana nueva', () => {
    expect(whereFromEvent({ ctrlKey: true, metaKey: false, shiftKey: false })).toBe('background-tab');
    expect(whereFromEvent({ ctrlKey: false, metaKey: false, shiftKey: true })).toBe('new-window');
    expect(whereFromEvent(undefined)).toBe('current');
  });

  it('carpeta: páginas, subcarpetas como submenú, "Abrir todos" y vacía', () => {
    const tree: Record<number, BookmarkNode[]> = {
      10: [node(11, 'url', 'A', 'https://a.com/'), node(12, 'folder', 'Sub'), node(13, 'url', 'B', 'https://b.com/')],
      12: [],
    };
    const open = vi.fn();
    const openAll = vi.fn();
    const items = folderMenu(10, { children: (id) => tree[id] ?? [] }, { open, openAll });
    expect(labels(items)).toEqual(['A', 'Sub', 'B', '—', 'Abrir todos (2)']);
    expect(labels(items[1]!.submenu as MenuItemConstructorOptions[])).toEqual(['(vacía)']);
    (items[0]!.click as unknown as (a: unknown, b: unknown, e: unknown) => void)(null, null, { ctrlKey: true });
    expect(open).toHaveBeenCalledWith(tree[10]![0], 'background-tab');
    (items[4]!.click as unknown as () => void)();
    expect(openAll).toHaveBeenCalledWith([tree[10]![0], tree[10]![2]]);
  });

  it('menú contextual de una página, de una carpeta y de la barra', () => {
    const a = { open: vi.fn(), openAll: vi.fn(), edit: vi.fn(), remove: vi.fn(), addPage: vi.fn(), addFolder: vi.fn(), toggleBar: vi.fn(), manage: vi.fn() };
    expect(labels(bookmarkItemMenu({ node: node(1, 'url', 'A', 'https://a.com/'), folderUrls: [], barShown: true }, a)).slice(0, 6)).toEqual(['Abrir', 'Abrir en una pestaña nueva', 'Abrir en una ventana nueva', '—', 'Editar…', 'Eliminar']);
    const folder = bookmarkItemMenu({ node: node(2, 'folder', 'F'), folderUrls: [], barShown: true }, a);
    expect(folder[0]).toMatchObject({ label: 'Abrir todos (0)', enabled: false });
    expect(labels(bookmarkItemMenu({ node: null, folderUrls: [], barShown: false }, a))).toEqual(['Agregar página…', 'Agregar carpeta…', '—', 'Mostrar la barra de favoritos', 'Administrar favoritos']);
  });

  it('submenú "Favoritos": agregar o editar según la página, la barra y "Otros favoritos"', () => {
    const tree: Record<number, BookmarkNode[]> = { [BAR_FOLDER_ID]: [node(5, 'url', 'Diario', 'https://d.com/')], [OTHER_FOLDER_ID]: [] };
    const a = { open: vi.fn(), openAll: vi.fn(), addCurrent: vi.fn(), toggleBar: vi.fn(), manage: vi.fn() };
    const items = bookmarksSubmenu({ children: (id) => tree[id] ?? [] }, BAR_FOLDER_ID, OTHER_FOLDER_ID, { canAdd: true, starred: false, barShown: true }, a);
    expect(labels(items)).toEqual(['Agregar esta página a favoritos', 'Mostrar la barra de favoritos', 'Administrar favoritos', '—', 'Diario']);
    expect(bookmarksSubmenu({ children: () => [] }, 1, 2, { canAdd: false, starred: true, barShown: true }, a)[0]).toMatchObject({ label: 'Editar el favorito de esta página', enabled: false });
  });
});

describe('configuración de la barra', () => {
  it('siempre, nunca o solo en pestañas nuevas; por defecto siempre', () => {
    expect(sanitizeSettings({ bookmarksBar: 'newtab' }).bookmarksBar).toBe('newtab');
    expect(sanitizeSettings({ bookmarksBar: 'a veces' }).bookmarksBar).toBe('always');
    expect(sanitizeSettings({}).bookmarksBar).toBe('always');
  });
});
