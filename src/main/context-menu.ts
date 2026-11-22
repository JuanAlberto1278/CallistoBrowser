import type { ContextMenuParams, MenuItemConstructorOptions, Referrer } from 'electron';

// Plantillas de los menús contextuales (nativos de Windows). Solo se ofrecen acciones que funcionan en esta versión:
// por ejemplo, "Guardar imagen como" no aparece hasta que existan las descargas autorizadas (V0.5).

type Item = MenuItemConstructorOptions;
const SEP: Item = { type: 'separator' };

/** Quita separadores al principio, al final y repetidos. */
export function tidy(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (out.length === 0 || out[out.length - 1]!.type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1]!.type === 'separator') out.pop();
  return out;
}

const isWebUrl = (u: string) => /^https?:\/\//i.test(u);

/** Texto seleccionado acortado para mostrarlo dentro de una opción del menú. */
export function menuSnippet(text: string, max = 32): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------- página web

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll';

export interface PageMenuActions {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Buscador configurado, para "Buscar «…» en Google". */
  searchEngineName: string;
  openInNewTab(url: string, referrer?: Referrer): void;
  openInNewWindow(url: string, referrer?: Referrer): void;
  copyText(text: string): void;
  copyImageAt(x: number, y: number): void;
  searchFor(text: string): void;
  edit(cmd: EditCommand): void;
  replaceMisspelling(word: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  inspect(x: number, y: number): void;
}

export function pageMenuTemplate(p: ContextMenuParams, a: PageMenuActions): Item[] {
  const items: Item[] = [];
  const selection = p.selectionText.trim();

  if (p.isEditable && p.misspelledWord) {
    const suggestions = p.dictionarySuggestions.slice(0, 5);
    if (suggestions.length === 0) items.push({ label: 'No hay sugerencias de ortografía', enabled: false });
    for (const s of suggestions) items.push({ label: s, click: () => a.replaceMisspelling(s) });
    // Sin "Agregar al diccionario": en Windows, Electron agrega la palabra al diccionario del sistema operativo
    // (una configuración del sistema). Se agregará cuando Callisto tenga su propio diccionario por perfil.
    items.push(SEP);
  }

  if (p.linkURL) {
    if (isWebUrl(p.linkURL)) {
      items.push(
        { label: 'Abrir enlace en una pestaña nueva', click: () => a.openInNewTab(p.linkURL, p.referrerPolicy) },
        { label: 'Abrir enlace en una ventana nueva', click: () => a.openInNewWindow(p.linkURL, p.referrerPolicy) },
      );
    }
    const isMail = p.linkURL.toLowerCase().startsWith('mailto:');
    items.push(
      isMail
        ? { label: 'Copiar dirección de correo', click: () => a.copyText(decodeURIComponent(p.linkURL.slice(7).split('?')[0] ?? '')) }
        : { label: 'Copiar dirección del enlace', click: () => a.copyText(p.linkURL) },
      SEP,
    );
  }

  if (p.mediaType === 'image' && p.srcURL) {
    if (isWebUrl(p.srcURL)) items.push({ label: 'Abrir imagen en una pestaña nueva', click: () => a.openInNewTab(p.srcURL, p.referrerPolicy) });
    items.push({ label: 'Copiar imagen', click: () => a.copyImageAt(p.x, p.y) });
    if (!p.srcURL.startsWith('data:')) items.push({ label: 'Copiar dirección de la imagen', click: () => a.copyText(p.srcURL) });
    items.push(SEP);
  }

  if (p.isEditable) {
    const f = p.editFlags;
    items.push(
      { label: 'Deshacer', accelerator: 'Ctrl+Z', registerAccelerator: false, enabled: f.canUndo, click: () => a.edit('undo') },
      { label: 'Rehacer', accelerator: 'Ctrl+Y', registerAccelerator: false, enabled: f.canRedo, click: () => a.edit('redo') },
      SEP,
      { label: 'Cortar', accelerator: 'Ctrl+X', registerAccelerator: false, enabled: f.canCut, click: () => a.edit('cut') },
      { label: 'Copiar', accelerator: 'Ctrl+C', registerAccelerator: false, enabled: f.canCopy, click: () => a.edit('copy') },
      { label: 'Pegar', accelerator: 'Ctrl+V', registerAccelerator: false, enabled: f.canPaste, click: () => a.edit('paste') },
      { label: 'Pegar como texto sin formato', accelerator: 'Ctrl+Shift+V', registerAccelerator: false, enabled: f.canPaste, click: () => a.edit('pasteAndMatchStyle') },
      { label: 'Eliminar', enabled: f.canDelete, click: () => a.edit('delete') },
      SEP,
      { label: 'Seleccionar todo', accelerator: 'Ctrl+A', registerAccelerator: false, enabled: f.canSelectAll, click: () => a.edit('selectAll') },
      SEP,
    );
  } else if (selection) {
    items.push(
      { label: 'Copiar', accelerator: 'Ctrl+C', registerAccelerator: false, click: () => a.edit('copy') },
      { label: `Buscar «${menuSnippet(selection)}» en ${a.searchEngineName}`, click: () => a.searchFor(selection) },
      SEP,
    );
  }

  if (!p.linkURL && !(p.mediaType === 'image' && p.srcURL) && !p.isEditable && !selection) {
    items.push(
      { label: 'Atrás', accelerator: 'Alt+Left', registerAccelerator: false, enabled: a.canGoBack, click: () => a.back() },
      { label: 'Adelante', accelerator: 'Alt+Right', registerAccelerator: false, enabled: a.canGoForward, click: () => a.forward() },
      { label: 'Volver a cargar', accelerator: 'F5', registerAccelerator: false, click: () => a.reload() },
      SEP,
    );
  }

  items.push({ label: 'Inspeccionar', accelerator: 'Ctrl+Shift+I', registerAccelerator: false, click: () => a.inspect(p.x, p.y) });
  return tidy(items);
}

// ---------------------------------------------------------------- pestañas

export interface TabMenuInfo {
  /** null = clic derecho en la franja, fuera de una pestaña. */
  hasTab: boolean;
  tabCount: number;
  tabsToRight: number;
  canReopen: boolean;
}

export interface TabMenuActions {
  newTabToRight(): void;
  newTab(): void;
  reload(): void;
  duplicate(): void;
  moveToNewWindow(): void;
  close(): void;
  closeOthers(): void;
  closeToRight(): void;
  reopenClosed(): void;
}

export function tabMenuTemplate(info: TabMenuInfo, a: TabMenuActions): Item[] {
  const reopen: Item = { label: 'Volver a abrir la pestaña cerrada', accelerator: 'Ctrl+Shift+T', registerAccelerator: false, enabled: info.canReopen, click: () => a.reopenClosed() };
  if (!info.hasTab) {
    return [{ label: 'Nueva pestaña', accelerator: 'Ctrl+T', registerAccelerator: false, click: () => a.newTab() }, reopen];
  }
  return tidy([
    { label: 'Nueva pestaña a la derecha', click: () => a.newTabToRight() },
    SEP,
    { label: 'Volver a cargar', accelerator: 'F5', registerAccelerator: false, click: () => a.reload() },
    { label: 'Duplicar', accelerator: 'Ctrl+Shift+K', registerAccelerator: false, click: () => a.duplicate() },
    { label: 'Mover a una ventana nueva', enabled: info.tabCount > 1, click: () => a.moveToNewWindow() },
    SEP,
    { label: 'Cerrar pestaña', accelerator: 'Ctrl+W', registerAccelerator: false, click: () => a.close() },
    { label: 'Cerrar las demás pestañas', enabled: info.tabCount > 1, click: () => a.closeOthers() },
    { label: 'Cerrar las pestañas de la derecha', enabled: info.tabsToRight > 0, click: () => a.closeToRight() },
    SEP,
    reopen,
  ]);
}

// ---------------------------------------------------------------- menú "Configuración y más" (botón ⋯)

export interface AppMenuActions {
  newTab(): void;
  newWindow(): void;
  history(): void;
  zoom(direction: 'in' | 'out' | 'reset'): void;
  find(): void;
  settings(): void;
  closeWindow(): void;
}

export function appMenuTemplate(info: { zoomPercent: number }, a: AppMenuActions): Item[] {
  return [
    { label: 'Nueva pestaña', accelerator: 'Ctrl+T', registerAccelerator: false, click: () => a.newTab() },
    { label: 'Nueva ventana', accelerator: 'Ctrl+N', registerAccelerator: false, click: () => a.newWindow() },
    SEP,
    { label: 'Historial', accelerator: 'Ctrl+H', registerAccelerator: false, click: () => a.history() },
    SEP,
    {
      label: `Zoom (${info.zoomPercent} %)`,
      submenu: [
        { label: 'Acercar', accelerator: 'Ctrl+Plus', registerAccelerator: false, click: () => a.zoom('in') },
        { label: 'Alejar', accelerator: 'Ctrl+-', registerAccelerator: false, click: () => a.zoom('out') },
        { label: 'Restablecer', accelerator: 'Ctrl+0', registerAccelerator: false, enabled: info.zoomPercent !== 100, click: () => a.zoom('reset') },
      ],
    },
    { label: 'Buscar en la página', accelerator: 'Ctrl+F', registerAccelerator: false, click: () => a.find() },
    SEP,
    { label: 'Configuración', click: () => a.settings() },
    SEP,
    { label: 'Cerrar ventana', accelerator: 'Ctrl+Shift+W', registerAccelerator: false, click: () => a.closeWindow() },
  ];
}

// ---------------------------------------------------------------- interfaz (barra de direcciones y búsqueda)

export interface UiEditMenuActions {
  edit(cmd: EditCommand): void;
  /** Texto del portapapeles para "Pegar e ir"/"Pegar y buscar"; null si no hay texto. */
  clipboardText: string | null;
  /** true si el texto del portapapeles es una dirección (no una búsqueda). */
  clipboardIsUrl: boolean;
  pasteAndGo(text: string): void;
  isAddressBar: boolean;
}

export function uiEditMenuTemplate(p: ContextMenuParams, a: UiEditMenuActions): Item[] {
  const f = p.editFlags;
  const items: Item[] = [
    { label: 'Deshacer', accelerator: 'Ctrl+Z', registerAccelerator: false, enabled: f.canUndo, click: () => a.edit('undo') },
    SEP,
    { label: 'Cortar', accelerator: 'Ctrl+X', registerAccelerator: false, enabled: f.canCut, click: () => a.edit('cut') },
    { label: 'Copiar', accelerator: 'Ctrl+C', registerAccelerator: false, enabled: f.canCopy, click: () => a.edit('copy') },
    { label: 'Pegar', accelerator: 'Ctrl+V', registerAccelerator: false, enabled: f.canPaste, click: () => a.edit('paste') },
  ];
  if (a.isAddressBar && a.clipboardText) {
    const text = a.clipboardText;
    items.push({ label: a.clipboardIsUrl ? 'Pegar e ir' : 'Pegar y buscar', click: () => a.pasteAndGo(text) });
  }
  items.push(
    { label: 'Eliminar', enabled: f.canDelete, click: () => a.edit('delete') },
    SEP,
    { label: 'Seleccionar todo', accelerator: 'Ctrl+A', registerAccelerator: false, enabled: f.canSelectAll, click: () => a.edit('selectAll') },
  );
  return tidy(items);
}
