// Preload de las páginas internas (callisto://history, callisto://settings).
// Solo corre en pestañas internas (sesión propia, sin acceso a la sesión web). No expone ipcRenderer ni Node.
import { contextBridge, ipcRenderer } from 'electron';
import { INTERNAL_IPC, type CallistoInternalApi } from '../shared/internal-api';

const api: CallistoInternalApi = {
  history: {
    query: (opts) => ipcRenderer.invoke(INTERNAL_IPC.historyQuery, opts),
    deleteVisit: (id) => ipcRenderer.invoke(INTERNAL_IPC.historyDeleteVisit, Number(id)),
    clear: (period) => ipcRenderer.invoke(INTERNAL_IPC.historyClear, String(period)),
    open: (url, where) => ipcRenderer.send(INTERNAL_IPC.historyOpen, String(url), String(where)),
  },
  settings: {
    get: () => ipcRenderer.invoke(INTERNAL_IPC.settingsGet),
    set: (partial) => ipcRenderer.invoke(INTERNAL_IPC.settingsSet, partial),
    removePermission: (origin, permission) => ipcRenderer.invoke(INTERNAL_IPC.settingsRemovePermission, String(origin), String(permission)),
    removeZoom: (host) => ipcRenderer.invoke(INTERNAL_IPC.settingsRemoveZoom, String(host)),
    chooseDownloadDir: () => ipcRenderer.invoke(INTERNAL_IPC.settingsChooseDownloadDir),
    resetDownloadDir: () => ipcRenderer.invoke(INTERNAL_IPC.settingsResetDownloadDir),
  },
  downloads: {
    list: (query) => ipcRenderer.invoke(INTERNAL_IPC.downloadsList, query === undefined ? undefined : String(query)),
    action: (id, action) => ipcRenderer.invoke(INTERNAL_IPC.downloadsAction, Number(id), String(action)),
    openFolder: () => ipcRenderer.send(INTERNAL_IPC.downloadsOpenFolder),
    clear: () => ipcRenderer.invoke(INTERNAL_IPC.downloadsClear),
  },
  openPage: (page) => ipcRenderer.send(INTERNAL_IPC.openPage, String(page)),
};

contextBridge.exposeInMainWorld('callistoInternal', api);
