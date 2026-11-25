// Contrato IPC entre la interfaz del navegador (renderer privilegiado) y el proceso principal.
// La interfaz solo puede pedir estas acciones; el proceso principal valida remitente y argumentos.

import type { SecurityLevel } from './url-security';
import type { DownloadEntry, DownloadPrompt } from './downloads';
import type { BookmarkEditorState, BookmarkNode } from './bookmarks';
import type { WindowProfile } from './profiles';
import type { GroupAction, GroupColor, TabGroupState } from './tab-groups';
import type { PasswordOffer } from './passwords';
import type { ExtensionInstallPrompt } from './extensions';
import type { ThemeVars } from './themes';

export type NoticeAction = 'wait' | 'stop';

export interface Notice {
  id: number;
  kind: 'info' | 'warning';
  text: string;
  /** Botones del aviso ("La página no responde": Esperar / Detener la página). */
  actions?: Array<{ id: NoticeAction; label: string }>;
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
  /** Pestaña nueva sin contenido: la interfaz muestra la página de nueva pestaña encima. */
  newTabPage: boolean;
  /** Grupo de la pestaña (null = sin grupo). */
  groupId: number | null;
  /** Oferta de guardar (o actualizar) la contraseña recién enviada. */
  passwordOffer: PasswordOffer | null;
  /** Dormida para ahorrar memoria (se vuelve a cargar al activarla). */
  asleep: boolean;
  /** Está reproduciendo sonido ahora. */
  audible: boolean;
  /** Silenciada por el usuario. */
  muted: boolean;
  /** Fijada: va a la izquierda, solo con el ícono. */
  pinned: boolean;
  /** En segundo plano y usando mucha CPU desde hace un rato (un clic en el ícono la duerme). */
  highCpu: boolean;
}

export interface DownloadsUiState {
  /** Descarga esperando autorización en esta ventana (ya cancelada: nada guardado hasta decidir). */
  prompt: DownloadPrompt | null;
  /** Otras descargas esperando autorización detrás de la actual. */
  waiting: number;
  panelOpen: boolean;
  /** Descargas recientes (solo con el panel abierto). */
  items: DownloadEntry[];
  /** Descargas en curso. */
  active: number;
  /** Progreso conjunto 0..1 (null = desconocido). */
  progress: number | null;
}

export interface BookmarksUiState {
  /** Se muestra la barra de favoritos (según la configuración y si la pestaña activa es una pestaña nueva). */
  barVisible: boolean;
  /** Contenido de la barra (con favicons), solo si está visible. */
  bar: BookmarkNode[];
  /** La página activa ya es un favorito (estrella llena). */
  starred: boolean;
  /** La página activa se puede agregar (no se puede con páginas en blanco o de error). */
  starrable: boolean;
  editor: BookmarkEditorState | null;
}

/** Dónde abrir un favorito. */
export type OpenWhere = 'current' | 'new-tab' | 'background-tab' | 'new-window';

export interface TopSite {
  url: string;
  host: string;
  title: string;
  icon: string | null;
}

export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'open' | 'show' | 'retry' | 'remove';

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
  /** 'tab': una pestaña abierta (elegirla la activa, no navega); 'bookmark': un favorito. */
  kind: 'search' | 'url' | 'history' | 'tab' | 'bookmark';
  /** Pestaña abierta a la que lleva (solo 'tab'). */
  tabId?: number;
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
  /** Perfil de la ventana (y si es privada). */
  profile: WindowProfile;
  /** Grupos de pestañas de la ventana. */
  groups: TabGroupState[];
  /** Grupo cuyo panel de edición está abierto. */
  groupEditor: number | null;
  downloads: DownloadsUiState;
  bookmarks: BookmarksUiState;
  extensions: ExtensionsUiState;
  /** Colores del tema elegido (null en ui = "Sistema"). */
  theme: ThemeVars;
  /** Versión nueva de Callisto descargada y lista para instalar (null = no hay). */
  updateReady: string | null;
}

export interface ExtensionsUiState {
  /** Partición de la sesión del perfil (para la lista de botones); null = sin extensiones (ventana privada). */
  partition: string | null;
  /** "¿Agregar la extensión?" pendiente en esta ventana. */
  prompt: ExtensionInstallPrompt | null;
}

export const IPC = {
  // interfaz -> principal (actúan sobre la pestaña activa salvo que reciban un id)
  navigate: 'callisto:navigate',
  goBack: 'callisto:go-back',
  goForward: 'callisto:go-forward',
  reload: 'callisto:reload',
  stop: 'callisto:stop',
  dismissNotice: 'callisto:dismiss-notice',
  noticeAction: 'callisto:notice-action',
  sleepTab: 'callisto:sleep-tab',
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
  answerDownload: 'callisto:answer-download',
  downloadAction: 'callisto:download-action',
  downloadsPanel: 'callisto:downloads-panel',
  openDownloadsPage: 'callisto:open-downloads-page',
  topSites: 'callisto:top-sites',
  hideTopSite: 'callisto:hide-top-site',
  restoreTopSites: 'callisto:restore-top-sites',
  toggleStar: 'callisto:toggle-star',
  bookmarkEditorSave: 'callisto:bookmark-editor-save',
  bookmarkEditorRemove: 'callisto:bookmark-editor-remove',
  bookmarkEditorClose: 'callisto:bookmark-editor-close',
  openBookmark: 'callisto:open-bookmark',
  bookmarkMenu: 'callisto:bookmark-menu',
  bookmarkFolderMenu: 'callisto:bookmark-folder-menu',
  bookmarkOverflowMenu: 'callisto:bookmark-overflow-menu',
  moveBookmark: 'callisto:move-bookmark',
  profileMenu: 'callisto:profile-menu',
  groupEditor: 'callisto:group-editor',
  updateGroup: 'callisto:update-group',
  groupAction: 'callisto:group-action',
  moveGroup: 'callisto:move-group',
  answerPasswordOffer: 'callisto:answer-password-offer',
  answerExtensionInstall: 'callisto:answer-extension-install',
  titleBarColors: 'callisto:title-bar-colors',
  toggleMute: 'callisto:toggle-mute',
  suggestTabs: 'callisto:suggest-tabs',
  switchToTab: 'callisto:switch-to-tab',
  extensionMenu: 'callisto:extension-menu',
  // principal -> interfaz
  state: 'callisto:state',
  favicons: 'callisto:favicons',
  focusAddressBar: 'callisto:focus-address-bar',
  focusFind: 'callisto:focus-find',
  focusTabSearch: 'callisto:focus-tab-search',
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
  /** Mueve una pestaña; `groupId` (si se indica): el grupo al que queda (null = sin grupo). */
  moveTab(id: number, index: number, groupId?: number | null): void;
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
  /** Respuesta al pedido de autorización de una descarga. */
  answerDownload(id: number, answer: 'save' | 'save-as' | 'cancel'): void;
  downloadAction(id: number, action: DownloadAction): void;
  setDownloadsPanel(open: boolean): void;
  openDownloadsPage(): void;
  /** Sitios más visitados para la página de nueva pestaña. */
  topSites(): Promise<TopSite[]>;
  /** Quita (o vuelve a mostrar, con `hide` en false) un sitio de los más visitados. */
  hideTopSite(host: string, hide: boolean): void;
  restoreTopSites(): void;
  /** Estrella: agrega la página a favoritos, o abre el editor si ya lo es (Ctrl+D). */
  toggleStar(): void;
  bookmarkEditorSave(values: { title: string; url: string; parentId: number }): void;
  /** Quita el favorito que se está editando (o descarta el nuevo). */
  bookmarkEditorRemove(): void;
  bookmarkEditorClose(): void;
  openBookmark(id: number, where: OpenWhere): void;
  /** Menú contextual de un favorito de la barra, o de la barra (id null). */
  showBookmarkMenu(id: number | null): void;
  /** Contenido de una carpeta de la barra, como menú. */
  showBookmarkFolder(id: number): void;
  /** Favoritos de la barra que no entran, desde la posición indicada. */
  showBookmarkOverflow(fromIndex: number): void;
  /** Reordenar arrastrando: mover a una carpeta, en una posición. */
  moveBookmark(id: number, parentId: number, index: number): void;
  /** Menú del botón de perfil. */
  showProfileMenu(): void;
  /** Abre (o cierra, con null) el panel de un grupo. */
  editGroup(id: number | null): void;
  updateGroup(id: number, patch: { title?: string; color?: GroupColor; collapsed?: boolean }): void;
  groupAction(id: number, action: GroupAction): void;
  /** Mueve un grupo entero a la posición indicada. */
  moveGroup(id: number, index: number): void;
  /** Respuesta a la oferta de guardar una contraseña ('save' puede llevar el usuario corregido). */
  answerPasswordOffer(id: number, answer: 'save' | 'never' | 'dismiss', username?: string): void;
  /** Pestañas abiertas que coinciden (todas, si `text` está vacío): el buscador de pestañas (Ctrl+Shift+A). */
  suggestTabs(text: string): Promise<Suggestion[]>;
  /** Ir a una pestaña abierta (de cualquier ventana del perfil). */
  switchToTab(id: number): void;
  onFocusTabSearch(cb: () => void): void;
  /** Botón de un aviso de la pestaña activa. */
  noticeAction(noticeId: number, action: NoticeAction): void;
  /** Dormir una pestaña (el ícono de "usa mucha CPU"). */
  sleepTab(id: number): void;
  /** Silenciar o devolver el sonido a una pestaña. */
  toggleMute(id: number): void;
  /** Colores reales de la franja de pestañas (fondo y texto, #rrggbb) para los botones de ventana de Windows. */
  setTitleBarColors(color: string, symbolColor: string): void;
  /** Respuesta a "¿Agregar la extensión?". */
  answerExtensionInstall(id: number, allow: boolean): void;
  /** Menú (clic derecho) del botón de una extensión. */
  showExtensionMenu(extensionId: string): void;
  onState(cb: (state: WindowState) => void): void;
  /** Favicons nuevos: clave -> URL data: de la imagen (la interfaz los guarda). */
  onFavicons(cb: (favicons: Record<string, string>) => void): void;
  onFocusAddressBar(cb: () => void): void;
  onFocusFind(cb: () => void): void;
}
