// API de las páginas internas (callisto://history, callisto://settings). Cada página solo puede usar su parte:
// el proceso principal comprueba qué página envía cada pedido.

import type { DownloadAction, PromptPermission } from './ipc';
import type { DownloadEntry } from './downloads';
import type { BookmarkNode, FolderOption } from './bookmarks';
import type { ProfileColor } from './profiles';
import type { SearchEngineId, Settings } from './settings';
import type { LoginSummary, VaultStatus } from './passwords';
import type { ExtensionInfo } from './extensions';
import type { UpdateStatus } from './updates';

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  host: string;
  time: number;
  /** Favicon como URL data:, si se conoce. */
  icon: string | null;
}

export type ClearPeriod = 'hour' | 'day' | 'week' | 'month' | 'all';

export interface SitePermissionEntry {
  origin: string;
  permission: PromptPermission;
  label: string;
  setting: 'allow' | 'block';
}

export interface SettingsSnapshot {
  settings: Settings;
  engines: Array<{ id: SearchEngineId; name: string }>;
  permissions: SitePermissionEntry[];
  zoom: Array<{ host: string; percent: number }>;
  /** Carpeta de descargas en uso y si es la predeterminada (Descargas de Windows). */
  downloadDir: string;
  downloadDirIsDefault: boolean;
  /** Versión de Callisto y de sus componentes. */
  about: { version: string; electron: string; chromium: string; node: string; v8: string };
}

export interface MemoryUsage {
  /** Memoria privada de todos los procesos de Callisto, en MB. */
  mb: number;
  processes: number;
  awakeTabs: number;
  asleepTabs: number;
  /** Memoria que liberaron hoy las pestañas dormidas (al menos; ver memory-savings.ts), en MB. */
  savedTodayMb: number;
}

/** Qué es un proceso en el Administrador de tareas. */
export type TaskKind = 'browser' | 'gpu' | 'utility' | 'ui' | 'tabs' | 'internal' | 'extension' | 'devtools' | 'other';

/** Un proceso de Callisto en el Administrador de tareas. */
export interface TaskRow {
  pid: number;
  kind: TaskKind;
  title: string;
  /** Pestañas o extensiones que comparten el proceso, si son varias (con el aislamiento de sitios, las del mismo sitio). */
  members: string[];
  memoryMb: number;
  /** CPU en % del total del equipo (como el Administrador de tareas de Windows), desde la medición anterior. */
  cpu: number;
  /** Se puede finalizar (pestañas, páginas internas y extensiones; nunca el proceso principal ni la interfaz). */
  canEnd: boolean;
}

export interface TaskSnapshot {
  rows: TaskRow[];
  totalMb: number;
  asleepTabs: number;
  savedTodayMb: number;
}

/** Qué borrar en "Borrar datos de navegación". El período solo aplica al historial (Chromium borra el resto entero). */
export interface ClearDataRequest {
  period: ClearPeriod;
  history: boolean;
  siteData: boolean;
  cache: boolean;
}

export const INTERNAL_IPC = {
  historyQuery: 'callisto-internal:history-query',
  historyDeleteVisit: 'callisto-internal:history-delete-visit',
  historyClear: 'callisto-internal:history-clear',
  historyOpen: 'callisto-internal:history-open',
  settingsGet: 'callisto-internal:settings-get',
  settingsSet: 'callisto-internal:settings-set',
  settingsRemovePermission: 'callisto-internal:settings-remove-permission',
  settingsRemoveZoom: 'callisto-internal:settings-remove-zoom',
  openPage: 'callisto-internal:open-page',
  downloadsList: 'callisto-internal:downloads-list',
  downloadsAction: 'callisto-internal:downloads-action',
  downloadsOpenFolder: 'callisto-internal:downloads-open-folder',
  downloadsClear: 'callisto-internal:downloads-clear',
  settingsChooseDownloadDir: 'callisto-internal:settings-choose-download-dir',
  settingsResetDownloadDir: 'callisto-internal:settings-reset-download-dir',
  settingsClearData: 'callisto-internal:settings-clear-data',
  settingsDefaultBrowser: 'callisto-internal:settings-default-browser',
  settingsUpdateStatus: 'callisto-internal:settings-update-status',
  settingsMemory: 'callisto-internal:settings-memory',
  settingsCheckUpdate: 'callisto-internal:settings-check-update',
  settingsInstallUpdate: 'callisto-internal:settings-install-update',
  settingsMakeDefault: 'callisto-internal:settings-make-default',
  bookmarksFolders: 'callisto-internal:bookmarks-folders',
  bookmarksChildren: 'callisto-internal:bookmarks-children',
  bookmarksSearch: 'callisto-internal:bookmarks-search',
  bookmarksAdd: 'callisto-internal:bookmarks-add',
  bookmarksUpdate: 'callisto-internal:bookmarks-update',
  bookmarksMove: 'callisto-internal:bookmarks-move',
  bookmarksRemove: 'callisto-internal:bookmarks-remove',
  bookmarksOpen: 'callisto-internal:bookmarks-open',
  profilesList: 'callisto-internal:profiles-list',
  profilesCreate: 'callisto-internal:profiles-create',
  profilesUpdate: 'callisto-internal:profiles-update',
  profilesRemove: 'callisto-internal:profiles-remove',
  profilesOpen: 'callisto-internal:profiles-open',
  passwordsList: 'callisto-internal:passwords-list',
  passwordsReveal: 'callisto-internal:passwords-reveal',
  passwordsCopy: 'callisto-internal:passwords-copy',
  passwordsUpdate: 'callisto-internal:passwords-update',
  passwordsRemove: 'callisto-internal:passwords-remove',
  passwordsUnblock: 'callisto-internal:passwords-unblock',
  passwordsSetOffer: 'callisto-internal:passwords-set-offer',
  extensionsList: 'callisto-internal:extensions-list',
  extensionsSetEnabled: 'callisto-internal:extensions-set-enabled',
  extensionsSetUserScripts: 'callisto-internal:extensions-set-user-scripts',
  extensionsRemove: 'callisto-internal:extensions-remove',
  extensionsOptions: 'callisto-internal:extensions-options',
  extensionsUpdate: 'callisto-internal:extensions-update',
  extensionsOpenStore: 'callisto-internal:extensions-open-store',
  /** Colores del tema (cualquier página interna; las aplica su preload). */
  themeGet: 'callisto-internal:theme-get',
  tasksList: 'callisto-internal:tasks-list',
  tasksEnd: 'callisto-internal:tasks-end',
  settingsOpenTaskManager: 'callisto-internal:settings-open-task-manager',
  themeChanged: 'callisto-internal:theme-changed',
} as const;

export interface ExtensionsSnapshot {
  /** false en una ventana privada (sin extensiones). */
  available: boolean;
  items: ExtensionInfo[];
}

export interface PasswordEntry extends LoginSummary {
  host: string;
  /** Favicon del sitio como URL data:, si se conoce. */
  icon: string | null;
}

export interface PasswordsSnapshot {
  status: VaultStatus;
  entries: PasswordEntry[];
  /** Sitios donde el usuario eligió "Nunca guardar". */
  blocked: string[];
  offerToSave: boolean;
  /** Ventana privada: se muestran las del perfil de origen; no se guardan nuevas. */
  isPrivate: boolean;
}

/** Resultado de lo que requiere verificar la identidad: `error` = cancelado, rechazado o no se pudo. */
export interface PasswordResult {
  password?: string;
  error?: string;
}

export interface ProfilesSnapshot {
  profiles: Array<{ id: string; name: string; color: ProfileColor; windows: number; current: boolean }>;
  colors: Array<{ id: ProfileColor; name: string; hex: string }>;
}

export interface CallistoInternalApi {
  history: {
    query(opts: { query?: string; before?: { time: number; id: number }; limit?: number }): Promise<HistoryEntry[]>;
    deleteVisit(id: number): Promise<void>;
    clear(period: ClearPeriod): Promise<void>;
    /** Abre una dirección del historial: en esta pestaña o en una nueva (en primer o segundo plano). */
    open(url: string, where: 'current' | 'new-tab' | 'background-tab'): void;
  };
  settings: {
    get(): Promise<SettingsSnapshot>;
    set(partial: Partial<Settings>): Promise<SettingsSnapshot>;
    removePermission(origin: string, permission: PromptPermission): Promise<SettingsSnapshot>;
    removeZoom(host: string): Promise<SettingsSnapshot>;
    /** Abre el selector de carpetas de Windows (la ruta la elige el usuario, no la página). */
    chooseDownloadDir(): Promise<SettingsSnapshot>;
    resetDownloadDir(): Promise<SettingsSnapshot>;
    /** Borrar datos de navegación (historial, cookies y datos de sitios, caché). */
    clearData(request: ClearDataRequest): Promise<void>;
    /** ¿Callisto está registrado (instalado) y es el navegador predeterminado? */
    defaultBrowser(): Promise<{ registered: boolean; isDefault: boolean }>;
    /** Abre la página de Windows para elegir el navegador predeterminado. */
    makeDefault(): void;
    /** Actualizaciones de Callisto: `enabled` es false sin empaquetar (desarrollo). */
    updateStatus(): Promise<{ enabled: boolean; status: UpdateStatus }>;
    checkUpdate(): Promise<{ enabled: boolean; status: UpdateStatus }>;
    /** Cierra Callisto e instala la versión descargada. */
    installUpdate(): void;
    /** Memoria que usa Callisto ahora (todos sus procesos) y pestañas despiertas/dormidas. */
    memoryUsage(): Promise<MemoryUsage>;
    /** Abre el Administrador de tareas (Shift+Esc). */
    openTaskManager(): void;
  };
  /** Administrador de tareas (callisto://tasks, en su propia ventana). */
  tasks: {
    list(): Promise<TaskSnapshot>;
    /** Finaliza un proceso (sus pestañas muestran "La página dejó de funcionar"). */
    end(pid: number): Promise<void>;
  };
  downloads: {
    list(query?: string): Promise<DownloadEntry[]>;
    action(id: number, action: DownloadAction): Promise<void>;
    openFolder(): void;
    /** Quita de la lista las descargas terminadas (los archivos no se tocan). */
    clear(): Promise<void>;
  };
  bookmarks: {
    folders(): Promise<FolderOption[]>;
    children(folderId: number): Promise<BookmarkNode[]>;
    search(query: string): Promise<BookmarkNode[]>;
    /** Agrega una página (con dirección) o una carpeta (sin dirección). Devuelve el id o un mensaje de error. */
    add(parentId: number, title: string, url: string | null, index?: number): Promise<{ id?: number; error?: string }>;
    update(id: number, patch: { title?: string; url?: string }): Promise<{ error?: string }>;
    move(id: number, parentId: number, index?: number): Promise<{ error?: string }>;
    /** Borra un favorito o una carpeta con su contenido. */
    remove(id: number): Promise<void>;
    open(url: string, where: 'current' | 'new-tab' | 'background-tab' | 'new-window'): void;
  };
  profiles: {
    list(): Promise<ProfilesSnapshot>;
    /** Crea un perfil y abre una ventana con él. */
    create(name: string, color: ProfileColor): Promise<{ error?: string }>;
    update(id: string, patch: { name?: string; color?: ProfileColor }): Promise<{ error?: string }>;
    /** Elimina un perfil (Callisto pide confirmación). */
    remove(id: string): Promise<{ error?: string; cancelled?: boolean }>;
    open(id: string): void;
  };
  passwords: {
    list(query?: string): Promise<PasswordsSnapshot>;
    /** Muestra una contraseña (Windows verifica la identidad antes). */
    reveal(id: number): Promise<PasswordResult>;
    /** Copia una contraseña al portapapeles (Windows verifica la identidad antes). */
    copy(id: number): Promise<PasswordResult>;
    /** Cambia usuario y/o contraseña (Windows verifica la identidad antes). */
    update(id: number, patch: { username?: string; password?: string }): Promise<PasswordResult>;
    remove(id: number): Promise<void>;
    unblock(origin: string): Promise<void>;
    setOfferToSave(on: boolean): Promise<void>;
  };
  extensions: {
    list(): Promise<ExtensionsSnapshot>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    /** "Permitir scripts de usuario" (Tampermonkey, Violentmonkey): la extensión se vuelve a cargar. */
    setUserScriptsAllowed(id: string, allowed: boolean): Promise<void>;
    remove(id: string): Promise<void>;
    /** Abre la página de opciones de la extensión en una pestaña nueva. */
    options(id: string): void;
    /** Busca versiones nuevas en la Chrome Web Store; devuelve cuántas se actualizaron. */
    checkUpdates(): Promise<{ updated: number }>;
    /** Abre la Chrome Web Store (o la página de una extensión) en una pestaña nueva. */
    openStore(id?: string): void;
  };
  /** Abre otra página interna (p. ej. el historial desde la configuración) en esta pestaña. */
  openPage(page: 'history' | 'settings' | 'downloads' | 'bookmarks' | 'profiles' | 'passwords' | 'extensions'): void;
}
