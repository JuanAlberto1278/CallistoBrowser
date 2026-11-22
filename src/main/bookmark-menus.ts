import type { KeyboardEvent, MenuItemConstructorOptions } from 'electron';
import type { BookmarkNode } from '../shared/bookmarks';
import type { OpenWhere } from '../shared/ipc';

// Menús nativos de favoritos (lógica pura: reciben los datos y las acciones).

type Item = MenuItemConstructorOptions;
const SEP: Item = { type: 'separator' };
const MAX_DEPTH = 20;

/** En los menús de Windows "&" marca la tecla de acceso: hay que duplicarlo para que se vea. */
export function menuLabel(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim() || '(sin nombre)';
  return (t.length > max ? `${t.slice(0, max - 1)}…` : t).replace(/&/g, '&&');
}

/** Dónde abrir según las teclas: Ctrl → pestaña en segundo plano, Mayús → ventana nueva. */
export function whereFromEvent(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'> | undefined): OpenWhere {
  if (e?.ctrlKey || e?.metaKey) return 'background-tab';
  if (e?.shiftKey) return 'new-window';
  return 'current';
}

export interface FolderMenuSource {
  children(folderId: number): BookmarkNode[];
}

export interface FolderMenuActions {
  open(node: BookmarkNode, where: OpenWhere): void;
  openAll(nodes: BookmarkNode[]): void;
}

/** Elementos de un menú con favoritos: páginas que se abren y carpetas como submenús. */
export function nodesMenu(nodes: BookmarkNode[], src: FolderMenuSource, a: FolderMenuActions, depth = 0): Item[] {
  return nodes.map((n): Item => {
    if (n.kind === 'url') {
      return { label: menuLabel(n.title || n.url || ''), toolTip: n.url ?? undefined, click: (_mi, _w, e) => a.open(n, whereFromEvent(e)) };
    }
    return { label: menuLabel(n.title), submenu: depth >= MAX_DEPTH ? [{ label: '…', enabled: false }] : folderMenu(n.id, src, a, depth + 1) };
  });
}

/** Contenido de una carpeta, con "Abrir todos" si tiene páginas. */
export function folderMenu(folderId: number, src: FolderMenuSource, a: FolderMenuActions, depth = 0): Item[] {
  const children = src.children(folderId);
  if (children.length === 0) return [{ label: '(vacía)', enabled: false }];
  const items = nodesMenu(children, src, a, depth);
  const urls = children.filter((c) => c.kind === 'url');
  if (urls.length >= 2) items.push(SEP, { label: `Abrir todos (${urls.length})`, click: () => a.openAll(urls) });
  return items;
}

export interface BookmarkItemMenuInfo {
  node: BookmarkNode | null;
  /** Páginas dentro de la carpeta (para "Abrir todos"). */
  folderUrls: BookmarkNode[];
  barShown: boolean;
}

export interface BookmarkItemMenuActions {
  open(where: OpenWhere): void;
  openAll(): void;
  edit(): void;
  remove(): void;
  addPage(): void;
  addFolder(): void;
  toggleBar(): void;
  manage(): void;
}

/** Menú contextual de un favorito de la barra (o de la barra misma, si node es null). */
export function bookmarkItemMenu(info: BookmarkItemMenuInfo, a: BookmarkItemMenuActions): Item[] {
  const items: Item[] = [];
  const n = info.node;
  if (n?.kind === 'url') {
    items.push(
      { label: 'Abrir', click: () => a.open('current') },
      { label: 'Abrir en una pestaña nueva', click: () => a.open('background-tab') },
      { label: 'Abrir en una ventana nueva', click: () => a.open('new-window') },
      SEP,
      { label: 'Editar…', click: () => a.edit() },
      { label: 'Eliminar', click: () => a.remove() },
      SEP,
    );
  } else if (n?.kind === 'folder') {
    items.push(
      { label: `Abrir todos (${info.folderUrls.length})`, enabled: info.folderUrls.length > 0, click: () => a.openAll() },
      SEP,
      { label: 'Cambiar nombre…', click: () => a.edit() },
      { label: 'Eliminar', click: () => a.remove() },
      SEP,
    );
  }
  items.push(
    { label: 'Agregar página…', click: () => a.addPage() },
    { label: 'Agregar carpeta…', click: () => a.addFolder() },
    SEP,
    { label: 'Mostrar la barra de favoritos', type: 'checkbox', checked: info.barShown, accelerator: 'Ctrl+Shift+B', registerAccelerator: false, click: () => a.toggleBar() },
    { label: 'Administrar favoritos', accelerator: 'Ctrl+Shift+O', registerAccelerator: false, click: () => a.manage() },
  );
  return items;
}

export interface BookmarksSubmenuActions extends FolderMenuActions {
  addCurrent(): void;
  toggleBar(): void;
  manage(): void;
}

/** Submenú "Favoritos" del menú "Configuración y más". */
export function bookmarksSubmenu(src: FolderMenuSource, barFolderId: number, otherFolderId: number, info: { canAdd: boolean; starred: boolean; barShown: boolean }, a: BookmarksSubmenuActions): Item[] {
  const bar = src.children(barFolderId);
  const other = src.children(otherFolderId);
  return [
    { label: info.starred ? 'Editar el favorito de esta página' : 'Agregar esta página a favoritos', accelerator: 'Ctrl+D', registerAccelerator: false, enabled: info.canAdd, click: () => a.addCurrent() },
    { label: 'Mostrar la barra de favoritos', type: 'checkbox', checked: info.barShown, accelerator: 'Ctrl+Shift+B', registerAccelerator: false, click: () => a.toggleBar() },
    { label: 'Administrar favoritos', accelerator: 'Ctrl+Shift+O', registerAccelerator: false, click: () => a.manage() },
    ...(bar.length ? [SEP, ...nodesMenu(bar, src, a)] : []),
    ...(other.length ? [SEP, { label: 'Otros favoritos', submenu: folderMenu(otherFolderId, src, a) } as Item] : []),
  ];
}
