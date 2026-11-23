import { describe, expect, it, vi } from 'vitest';
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { stepZoom, zoomPercent, ZOOM_FACTORS } from '../../src/shared/zoom';
import { childInsertIndex, cycleIndex, indexAfterClose, moveItem } from '../../src/shared/tab-order';
import { decodeDataUrl, sniffImage, toDataUrl } from '../../src/shared/image-sniff';
import { chromeHeight } from '../../src/shared/layout';
import { ClosedTabs, isRestorable, type TabSnapshot } from '../../src/main/closed-tabs';
import { menuSnippet, pageMenuTemplate, tabMenuTemplate, tidy, uiEditMenuTemplate, type PageMenuActions, type TabMenuActions } from '../../src/main/context-menu';

describe('zoom', () => {
  it('sube y baja por los niveles de Chrome/Edge', () => {
    expect(stepZoom(1, 'in')).toBe(1.1);
    expect(stepZoom(1.1, 'in')).toBe(1.25);
    expect(stepZoom(1, 'out')).toBe(0.9);
    expect(stepZoom(0.9, 'out')).toBe(0.8);
  });
  it('se detiene en los extremos (25 % y 500 %)', () => {
    expect(stepZoom(5, 'in')).toBe(5);
    expect(stepZoom(0.25, 'out')).toBe(0.25);
  });
  it('desde un valor intermedio va al nivel siguiente', () => {
    expect(stepZoom(1.05, 'in')).toBe(1.1);
    expect(stepZoom(1.05, 'out')).toBe(1);
  });
  it('tolera la imprecisión de coma flotante de Chromium', () => {
    expect(stepZoom(1.0999999, 'in')).toBe(1.25);
    expect(stepZoom(1.1000001, 'out')).toBe(1);
  });
  it('porcentaje redondeado', () => {
    expect(zoomPercent(0.33)).toBe(33);
    expect(zoomPercent(1.1000001)).toBe(110);
    expect(ZOOM_FACTORS).toContain(1);
  });
});

describe('orden de pestañas', () => {
  it('una pestaña hija va a la derecha de su origen y de sus hermanas anteriores', () => {
    // pestañas: [A(1), B(2), C(3)] — se abre un enlace desde A
    expect(childInsertIndex([null, null, null], 0, 1)).toBe(1);
    // [A(1), hija de A, hija de A, C] — la tercera hija va después de las otras dos
    expect(childInsertIndex([null, 1, 1, null], 0, 1)).toBe(3);
    // origen al final
    expect(childInsertIndex([null, null], 1, 2)).toBe(2);
  });
  it('al cerrar la activa se activa la de la derecha, o la de la izquierda si era la última', () => {
    expect(indexAfterClose(3, 0)).toBe(0); // quedan 2: la que estaba a la derecha ahora es la 0
    expect(indexAfterClose(3, 1)).toBe(1);
    expect(indexAfterClose(3, 2)).toBe(1);
    expect(indexAfterClose(1, 0)).toBe(0);
  });
  it('mover una pestaña', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
  });
  it('Ctrl+Tab da la vuelta', () => {
    expect(cycleIndex(3, 2, 1)).toBe(0);
    expect(cycleIndex(3, 0, -1)).toBe(2);
    expect(cycleIndex(1, 0, 1)).toBe(0);
  });
});

describe('favicons: tipo real por los primeros bytes', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it.each([
    [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'image/png'],
    [bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    [bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), 'image/gif'],
    [bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50), 'image/webp'],
    [bytes(0, 0, 1, 0, 1, 0, 16, 16), 'image/x-icon'],
    [bytes(0x42, 0x4d, 0, 0), 'image/bmp'],
  ])('%#', (b, mime) => {
    expect(sniffImage(b)).toBe(mime);
  });
  it('SVG, con o sin declaración XML', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(enc('﻿<?xml version="1.0"?>\n<!-- x -->\n<svg viewBox="0 0 1 1"/>'))).toBe('image/svg+xml');
  });
  it('rechaza lo que no es una imagen (HTML de error, texto, vacío)', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffImage(enc('<!doctype html><html><body>404</body></html>'))).toBeNull();
    expect(sniffImage(enc('<svgx>'))).toBeNull();
    expect(sniffImage(enc('hola'))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
  it('URL data: en base64 y con escapes', () => {
    expect(decodeDataUrl('data:image/png;base64,iVBORw0KGgo=')?.slice(0, 4)).toEqual(bytes(0x89, 0x50, 0x4e, 0x47));
    expect(new TextDecoder().decode(decodeDataUrl('data:image/svg+xml,%3Csvg%3E')!)).toBe('<svg>');
    expect(decodeDataUrl('http://x')).toBeNull();
    expect(decodeDataUrl('data:image/png;base64,***')).toBeNull();
  });
  it('vuelve a armar la URL data: con el tipo verificado', () => {
    const b = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(toDataUrl('image/png', b)).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});

describe('altura de la interfaz', () => {
  it('suma pestañas + barra, y el aviso y la búsqueda solo si están abiertos', () => {
    const base = chromeHeight({ notice: false, find: false });
    expect(chromeHeight({ notice: true, find: false })).toBeGreaterThan(base);
    expect(chromeHeight({ notice: true, find: true })).toBeGreaterThan(chromeHeight({ notice: true, find: false }));
  });
});

describe('pestañas cerradas', () => {
  const snap = (...urls: string[]): TabSnapshot => ({ entries: urls.map((url) => ({ url, title: '' })), index: urls.length - 1 });

  it('no recuerda pestañas que solo tuvieron la página en blanco', () => {
    expect(isRestorable(snap('about:blank'))).toBe(false);
    expect(isRestorable(snap('about:blank', 'https://a.com/'))).toBe(true);
    const c = new ClosedTabs();
    c.push({ kind: 'tab', windowId: 1, index: 0, tab: snap('about:blank') });
    expect(c.size).toBe(0);
  });
  it('devuelve primero la última cerrada y guarda como máximo 25', () => {
    const c = new ClosedTabs();
    for (let i = 0; i < 30; i++) c.push({ kind: 'tab', windowId: 1, index: i, tab: snap(`https://s${i}.com/`) });
    expect(c.size).toBe(25);
    const last = c.pop();
    expect(last?.kind === 'tab' && last.index).toBe(29);
  });
  it('de una ventana cerrada guarda solo las pestañas con contenido', () => {
    const c = new ClosedTabs();
    c.push({ kind: 'window', tabs: [snap('about:blank'), snap('https://a.com/')], active: 0 });
    const e = c.pop();
    expect(e?.kind === 'window' && e.tabs.length).toBe(1);
    c.push({ kind: 'window', tabs: [snap('about:blank')], active: 0 });
    expect(c.size).toBe(0);
  });
});

// ---------------------------------------------------------------- menús contextuales

const params = (p: Partial<ContextMenuParams>): ContextMenuParams =>
  ({
    x: 10, y: 20, linkURL: '', linkText: '', pageURL: 'https://a.com/', frameURL: '', srcURL: '', mediaType: 'none',
    hasImageContents: false, isEditable: false, selectionText: '', titleText: '', altText: '', suggestedFilename: '',
    misspelledWord: '', dictionarySuggestions: [], frameCharset: '', formControlType: 'none', spellcheckEnabled: false,
    menuSourceType: 'mouse', mediaFlags: {}, selectionRect: { x: 0, y: 0, width: 0, height: 0 }, selectionStartOffset: 0,
    referrerPolicy: { url: 'https://a.com/', policy: 'strict-origin-when-cross-origin' }, frame: null,
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false },
    ...p,
  }) as ContextMenuParams;

const pageActions = (): PageMenuActions => ({
  canGoBack: true, canGoForward: false, searchEngineName: 'Google', saveAs: vi.fn(), openInPrivateWindow: vi.fn(),
  openInNewTab: vi.fn(), openInNewWindow: vi.fn(), copyText: vi.fn(), copyImageAt: vi.fn(), searchFor: vi.fn(), edit: vi.fn(),
  replaceMisspelling: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(), inspect: vi.fn(),
});

const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === 'separator' ? '—' : i.label));
const click = (items: MenuItemConstructorOptions[], label: string) =>
  (items.find((i) => i.label === label)!.click as unknown as () => void)();

describe('menú contextual de la página', () => {
  it('en un enlace: abrir en pestaña/ventana nueva y copiar la dirección, con el referrer de la página', () => {
    const a = pageActions();
    const items = pageMenuTemplate(params({ linkURL: 'https://b.com/x' }), a);
    expect(labels(items)).toEqual(['Abrir enlace en una pestaña nueva', 'Abrir enlace en una ventana nueva', 'Abrir enlace en una ventana privada', 'Guardar enlace como…', 'Copiar dirección del enlace', '—', 'Inspeccionar']);
    click(items, 'Abrir enlace en una pestaña nueva');
    expect(a.openInNewTab).toHaveBeenCalledWith('https://b.com/x', { url: 'https://a.com/', policy: 'strict-origin-when-cross-origin' });
    click(items, 'Copiar dirección del enlace');
    expect(a.copyText).toHaveBeenCalledWith('https://b.com/x');
  });
  it('un enlace javascript: no se puede abrir, solo copiar', () => {
    const items = pageMenuTemplate(params({ linkURL: 'javascript:alert(1)' }), pageActions());
    expect(labels(items)).not.toContain('Abrir enlace en una pestaña nueva');
    expect(labels(items)).toContain('Copiar dirección del enlace');
  });
  it('un enlace mailto: copia solo la dirección de correo', () => {
    const a = pageActions();
    const items = pageMenuTemplate(params({ linkURL: 'mailto:ana%40x.com?subject=hola' }), a);
    click(items, 'Copiar dirección de correo');
    expect(a.copyText).toHaveBeenCalledWith('ana@x.com');
  });
  it('en una imagen: abrir, guardar como, copiar imagen y copiar su dirección', () => {
    const a = pageActions();
    const items = pageMenuTemplate(params({ mediaType: 'image', srcURL: 'https://a.com/i.png' }), a);
    expect(labels(items)).toEqual(['Abrir imagen en una pestaña nueva', 'Guardar imagen como…', 'Copiar imagen', 'Copiar dirección de la imagen', '—', 'Inspeccionar']);
    click(items, 'Guardar imagen como…');
    expect(a.saveAs).toHaveBeenCalledWith('https://a.com/i.png');
    click(items, 'Copiar imagen');
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20);
  });
  it('con texto seleccionado: copiar y buscar en Google', () => {
    const a = pageActions();
    const items = pageMenuTemplate(params({ selectionText: '  hola   mundo  ' }), a);
    expect(labels(items)).toEqual(['Copiar', 'Buscar «hola mundo» en Google', '—', 'Inspeccionar']);
    click(items, 'Buscar «hola mundo» en Google');
    expect(a.searchFor).toHaveBeenCalledWith('hola   mundo');
  });
  it('en un campo editable: edición según lo que permite el campo, y sugerencias de ortografía', () => {
    const a = pageActions();
    const items = pageMenuTemplate(
      params({ isEditable: true, misspelledWord: 'olaa', dictionarySuggestions: ['hola', 'ola'], editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false } }),
      a,
    );
    expect(labels(items).slice(0, 3)).toEqual(['hola', 'ola', '—']);
    expect(labels(items)).not.toContain('Agregar al diccionario'); // tocaría el diccionario de Windows
    expect(items.find((i) => i.label === 'Pegar')!.enabled).toBe(true);
    expect(items.find((i) => i.label === 'Cortar')!.enabled).toBe(false);
    click(items, 'hola');
    expect(a.replaceMisspelling).toHaveBeenCalledWith('hola');
  });
  it('en la página sin nada especial: atrás, adelante, volver a cargar e inspeccionar', () => {
    const items = pageMenuTemplate(params({}), pageActions());
    expect(labels(items)).toEqual(['Atrás', 'Adelante', 'Volver a cargar', '—', 'Inspeccionar']);
    expect(items.find((i) => i.label === 'Adelante')!.enabled).toBe(false);
  });
  it('acorta el texto largo seleccionado', () => {
    expect(menuSnippet('a'.repeat(50))).toHaveLength(32);
    expect(menuSnippet('a'.repeat(50)).endsWith('…')).toBe(true);
  });
  it('tidy quita separadores sobrantes', () => {
    const S = { type: 'separator' as const };
    expect(labels(tidy([S, { label: 'a' }, S, S, { label: 'b' }, S]))).toEqual(['a', '—', 'b']);
  });
});

describe('menú de pestaña', () => {
  const actions = (): TabMenuActions => ({
    newTabToRight: vi.fn(), newTab: vi.fn(), reload: vi.fn(), duplicate: vi.fn(), moveToNewWindow: vi.fn(),
    close: vi.fn(), closeOthers: vi.fn(), closeToRight: vi.fn(), reopenClosed: vi.fn(),
  });
  it('habilita solo lo que tiene sentido', () => {
    const items = tabMenuTemplate({ hasTab: true, tabCount: 1, tabsToRight: 0, canReopen: false }, actions());
    const enabled = (l: string) => items.find((i) => i.label === l)!.enabled !== false;
    expect(enabled('Duplicar')).toBe(true);
    expect(enabled('Mover a una ventana nueva')).toBe(false);
    expect(enabled('Cerrar las demás pestañas')).toBe(false);
    expect(enabled('Cerrar las pestañas de la derecha')).toBe(false);
    expect(enabled('Volver a abrir la pestaña cerrada')).toBe(false);
  });
  it('fuera de una pestaña: nueva pestaña y volver a abrir', () => {
    const a = actions();
    const items = tabMenuTemplate({ hasTab: false, tabCount: 3, tabsToRight: 0, canReopen: true }, a);
    expect(labels(items)).toEqual(['Nueva pestaña', 'Volver a abrir la pestaña cerrada']);
    click(items, 'Volver a abrir la pestaña cerrada');
    expect(a.reopenClosed).toHaveBeenCalled();
  });
});

describe('menú de la barra de direcciones', () => {
  const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };
  it('"Pegar e ir" si el portapapeles tiene una dirección, "Pegar y buscar" si es texto', () => {
    const go = vi.fn();
    const asUrl = uiEditMenuTemplate(params({ isEditable: true, editFlags: flags }), { edit: vi.fn(), clipboardText: 'a.com', clipboardIsUrl: true, pasteAndGo: go, isAddressBar: true });
    expect(labels(asUrl)).toContain('Pegar e ir');
    click(asUrl, 'Pegar e ir');
    expect(go).toHaveBeenCalledWith('a.com');
    const asText = uiEditMenuTemplate(params({ isEditable: true, editFlags: flags }), { edit: vi.fn(), clipboardText: 'hola', clipboardIsUrl: false, pasteAndGo: go, isAddressBar: true });
    expect(labels(asText)).toContain('Pegar y buscar');
  });
  it('en el campo de búsqueda en la página no ofrece "Pegar e ir"', () => {
    const items = uiEditMenuTemplate(params({ isEditable: true, editFlags: flags }), { edit: vi.fn(), clipboardText: 'a.com', clipboardIsUrl: true, pasteAndGo: vi.fn(), isAddressBar: false });
    expect(labels(items)).not.toContain('Pegar e ir');
  });
});
