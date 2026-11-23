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
  bookmarks: {
    folders: () => ipcRenderer.invoke(INTERNAL_IPC.bookmarksFolders),
    children: (folderId) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksChildren, Number(folderId)),
    search: (query) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksSearch, String(query)),
    add: (parentId, title, url, index) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksAdd, Number(parentId), String(title), url === null ? null : String(url), index === undefined ? undefined : Number(index)),
    update: (id, patch) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksUpdate, Number(id), { title: patch.title === undefined ? undefined : String(patch.title), url: patch.url === undefined ? undefined : String(patch.url) }),
    move: (id, parentId, index) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksMove, Number(id), Number(parentId), index === undefined ? undefined : Number(index)),
    remove: (id) => ipcRenderer.invoke(INTERNAL_IPC.bookmarksRemove, Number(id)),
    open: (url, where) => ipcRenderer.send(INTERNAL_IPC.bookmarksOpen, String(url), String(where)),
  },
  profiles: {
    list: () => ipcRenderer.invoke(INTERNAL_IPC.profilesList),
    create: (name, color) => ipcRenderer.invoke(INTERNAL_IPC.profilesCreate, String(name), String(color)),
    update: (id, patch) => ipcRenderer.invoke(INTERNAL_IPC.profilesUpdate, String(id), { name: patch.name === undefined ? undefined : String(patch.name), color: patch.color === undefined ? undefined : String(patch.color) }),
    remove: (id) => ipcRenderer.invoke(INTERNAL_IPC.profilesRemove, String(id)),
    open: (id) => ipcRenderer.send(INTERNAL_IPC.profilesOpen, String(id)),
  },
  passwords: {
    list: (query) => ipcRenderer.invoke(INTERNAL_IPC.passwordsList, query === undefined ? undefined : String(query)),
    reveal: (id) => ipcRenderer.invoke(INTERNAL_IPC.passwordsReveal, Number(id)),
    copy: (id) => ipcRenderer.invoke(INTERNAL_IPC.passwordsCopy, Number(id)),
    update: (id, patch) =>
      ipcRenderer.invoke(INTERNAL_IPC.passwordsUpdate, Number(id), {
        username: patch.username === undefined ? undefined : String(patch.username),
        password: patch.password === undefined ? undefined : String(patch.password),
      }),
    remove: (id) => ipcRenderer.invoke(INTERNAL_IPC.passwordsRemove, Number(id)),
    unblock: (origin) => ipcRenderer.invoke(INTERNAL_IPC.passwordsUnblock, String(origin)),
    setOfferToSave: (on) => ipcRenderer.invoke(INTERNAL_IPC.passwordsSetOffer, on === true),
  },
  openPage: (page) => ipcRenderer.send(INTERNAL_IPC.openPage, String(page)),
};

contextBridge.exposeInMainWorld('callistoInternal', api);
