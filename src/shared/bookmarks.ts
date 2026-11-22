// Favoritos: tipos compartidos entre el proceso principal, la interfaz y la página de favoritos.

/** Carpetas raíz fijas (no se pueden borrar, renombrar ni mover). */
export const BAR_FOLDER_ID = 1;
export const OTHER_FOLDER_ID = 2;
export const ROOT_FOLDER_IDS: readonly number[] = [BAR_FOLDER_ID, OTHER_FOLDER_ID];

export interface BookmarkNode {
  id: number;
  parentId: number | null;
  kind: 'folder' | 'url';
  title: string;
  url: string | null;
  position: number;
  /** Favicon (URL data:) si se conoce; solo en las listas que lo piden. */
  icon?: string | null;
  /** Carpetas: cantidad de elementos que contiene. */
  childCount?: number;
}

/** Carpeta para elegir destino, con su profundidad (para indentarla). */
export interface FolderOption {
  id: number;
  title: string;
  depth: number;
}

export type BarVisibility = 'always' | 'never' | 'newtab';

/** Editor de favoritos (panel bajo la estrella o bajo la barra). */
export interface BookmarkEditorState {
  /** edit: favorito existente; new-page: agregar una página; new-folder: crear una carpeta. */
  mode: 'edit' | 'new-page' | 'new-folder';
  id: number | null;
  kind: 'folder' | 'url';
  title: string;
  url: string;
  parentId: number;
  folders: FolderOption[];
  /** Recién agregado con la estrella (el panel dice "Favorito agregado"). */
  justAdded: boolean;
  /** Dónde se abre: bajo la estrella (barra de direcciones) o bajo la barra de favoritos. */
  anchor: 'star' | 'bar';
  /** Mensaje si no se pudo guardar (p. ej. una dirección no válida). */
  error: string | null;
}

/** Dirección válida para un favorito (las que se pueden abrir en una pestaña). */
export function isBookmarkableUrl(url: string): boolean {
  return /^(https?:\/\/[^/]|file:\/\/|callisto:\/\/(history|settings|downloads|bookmarks)\/?)/i.test(url) && url.length <= 8192;
}
