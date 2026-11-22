// Contrato IPC entre la interfaz del navegador (renderer privilegiado) y el proceso principal.
// La interfaz solo puede pedir estas acciones; el proceso principal valida remitente y argumentos.

import type { SecurityLevel } from './url-security';

export interface Notice {
  id: number;
  kind: 'info' | 'warning';
  text: string;
}

/** Barra de búsqueda en la página (null en TabState = cerrada). */
export interface FindState {
  query: string;
  /** Coincidencia activa (1..matches); 0 si no hay. */
  activeMatch: number;
  matches: number;
  /** Ya hubo un resultado para `query` (para no mostrar "0 de 0" mientras se busca). */
  searched: boolean;
}

export interface TabState {
  id: number;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  security: SecurityLevel;
  /** Clave del favicon en el mapa que envía IPC.favicons; null = ícono genérico. */
  faviconKey: string | null;
  /** Zoom de la pestaña en %, 100 = normal. */
  zoomPercent: number;
  find: FindState | null;
  /** Aviso propio de la pestaña (descarga bloqueada, página que dejó de funcionar…). */
  notice: Notice | null;
}

export interface WindowState {
  tabs: TabState[];
  activeTabId: number;
}

export const IPC = {
  // interfaz -> principal (actúan sobre la pestaña activa salvo que reciban un id)
  navigate: 'callisto:navigate',
  goBack: 'callisto:go-back',
  goForward: 'callisto:go-forward',
  reload: 'callisto:reload',
  stop: 'callisto:stop',
  dismissNotice: 'callisto:dismiss-notice',
  uiReady: 'callisto:ui-ready',
  newTab: 'callisto:new-tab',
  closeTab: 'callisto:close-tab',
  activateTab: 'callisto:activate-tab',
  moveTab: 'callisto:move-tab',
  tabMenu: 'callisto:tab-menu',
  find: 'callisto:find',
  closeFind: 'callisto:close-find',
  resetZoom: 'callisto:reset-zoom',
  // principal -> interfaz
  state: 'callisto:state',
  favicons: 'callisto:favicons',
  focusAddressBar: 'callisto:focus-address-bar',
  focusFind: 'callisto:focus-find',
} as const;

export const MAX_ADDRESS_INPUT = 8192;
export const MAX_FIND_INPUT = 1000;

export interface CallistoUiApi {
  navigate(input: string): void;
  goBack(): void;
  goForward(): void;
  reload(ignoreCache: boolean): void;
  stop(): void;
  dismissNotice(id: number): void;
  ready(): void;
  newTab(): void;
  closeTab(id: number): void;
  activateTab(id: number): void;
  moveTab(id: number, index: number): void;
  /** Menú contextual de una pestaña, o de la franja de pestañas si id es null. */
  showTabMenu(id: number | null): void;
  /** Busca en la pestaña activa. `newSession`: el texto cambió (empieza una búsqueda nueva). */
  find(query: string, forward: boolean, newSession: boolean): void;
  closeFind(): void;
  resetZoom(): void;
  onState(cb: (state: WindowState) => void): void;
  /** Favicons nuevos: clave -> URL data: de la imagen (la interfaz los guarda). */
  onFavicons(cb: (favicons: Record<string, string>) => void): void;
  onFocusAddressBar(cb: () => void): void;
  onFocusFind(cb: () => void): void;
}
