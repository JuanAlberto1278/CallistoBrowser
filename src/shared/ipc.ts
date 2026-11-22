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
  /** Pedido de permiso del sitio esperando la decisión del usuario. */
  permission: PermissionPrompt | null;
}

export type PromptPermission = 'camera' | 'microphone' | 'geolocation' | 'notifications';

export interface PermissionPrompt {
  id: number;
  /** Sitio que pide (https://sitio). */
  origin: string;
  permissions: PromptPermission[];
  /** Texto listo para mostrar: "usar tu cámara y tu micrófono". */
  phrase: string;
}

/** Sugerencia de la barra de direcciones. */
export interface Suggestion {
  kind: 'search' | 'url' | 'history';
  /** Línea principal (título, dirección o texto buscado). */
  text: string;
  /** Línea secundaria (dirección o "Buscar en Google"). */
  detail: string;
  /** Adónde lleva. */
  url: string;
  /** Favicon como URL data: (historial), o null. */
  icon: string | null;
  /** Texto que se muestra en la barra al seleccionarla con las flechas. */
  fill?: string;
}

export interface SuggestResult {
  items: Suggestion[];
  /** Autocompletado en línea: el resto del nombre del sitio ("gle.com" para "goo") y su dirección. */
  inline: { completion: string; url: string } | null;
}

export interface WindowState {
  tabs: TabState[];
  activeTabId: number;
  /** Nombre del buscador configurado (para los textos de la barra). */
  searchEngine: string;
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
  suggest: 'callisto:suggest',
  overlayHeight: 'callisto:overlay-height',
  respondPermission: 'callisto:respond-permission',
  appMenu: 'callisto:app-menu',
  // principal -> interfaz
  state: 'callisto:state',
  favicons: 'callisto:favicons',
  focusAddressBar: 'callisto:focus-address-bar',
  focusFind: 'callisto:focus-find',
} as const;

export const MAX_ADDRESS_INPUT = 8192;
export const MAX_FIND_INPUT = 1000;
/** Alto máximo del panel de sugerencias que se superpone a la página. */
export const MAX_OVERLAY_HEIGHT = 600;

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
  /** Sugerencias para lo que se está escribiendo en la barra de direcciones. */
  suggest(text: string): Promise<SuggestResult>;
  /** Alto del panel de sugerencias abierto (0 = cerrado): la interfaz se extiende sobre la página mientras tanto. */
  setOverlayHeight(px: number): void;
  respondPermission(id: number, allow: boolean, remember: boolean): void;
  /** Menú "Configuración y más". */
  showAppMenu(): void;
  onState(cb: (state: WindowState) => void): void;
  /** Favicons nuevos: clave -> URL data: de la imagen (la interfaz los guarda). */
  onFavicons(cb: (favicons: Record<string, string>) => void): void;
  onFocusAddressBar(cb: () => void): void;
  onFocusFind(cb: () => void): void;
}
