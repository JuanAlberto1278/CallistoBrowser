// API de las páginas internas (callisto://history, callisto://settings). Cada página solo puede usar su parte:
// el proceso principal comprueba qué página envía cada pedido.

import type { DownloadAction, PromptPermission } from './ipc';
import type { DownloadEntry } from './downloads';
import type { SearchEngineId, Settings } from './settings';

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
} as const;

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
  };
  downloads: {
    list(query?: string): Promise<DownloadEntry[]>;
    action(id: number, action: DownloadAction): Promise<void>;
    openFolder(): void;
    /** Quita de la lista las descargas terminadas (los archivos no se tocan). */
    clear(): Promise<void>;
  };
  /** Abre otra página interna (p. ej. el historial desde la configuración) en esta pestaña. */
  openPage(page: 'history' | 'settings' | 'downloads'): void;
}
