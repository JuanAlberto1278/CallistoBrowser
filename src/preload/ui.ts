// Preload de la interfaz del navegador: expone a la interfaz una API mínima y tipada.
// No expone ipcRenderer ni nada de Node.
import { contextBridge, ipcRenderer } from 'electron';
// Botones de las extensiones (<browser-action-list>): el elemento y su API, de electron-chrome-extensions
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action';
import { IPC, type CallistoUiApi, type WindowState } from '../shared/ipc';

const api: CallistoUiApi = {
  navigate: (input) => ipcRenderer.send(IPC.navigate, String(input)),
  goBack: () => ipcRenderer.send(IPC.goBack),
  goForward: () => ipcRenderer.send(IPC.goForward),
  reload: (ignoreCache) => ipcRenderer.send(IPC.reload, ignoreCache === true),
  stop: () => ipcRenderer.send(IPC.stop),
  dismissNotice: (id) => ipcRenderer.send(IPC.dismissNotice, Number(id)),
  ready: () => ipcRenderer.send(IPC.uiReady),
  newTab: () => ipcRenderer.send(IPC.newTab),
  closeTab: (id) => ipcRenderer.send(IPC.closeTab, Number(id)),
  activateTab: (id) => ipcRenderer.send(IPC.activateTab, Number(id)),
  moveTab: (id, index, groupId) => ipcRenderer.send(IPC.moveTab, Number(id), Number(index), groupId === undefined ? undefined : groupId === null ? null : Number(groupId)),
  showTabMenu: (id) => ipcRenderer.send(IPC.tabMenu, id === null ? null : Number(id)),
  find: (query, forward, newSession) => ipcRenderer.send(IPC.find, String(query), forward === true, newSession === true),
  closeFind: () => ipcRenderer.send(IPC.closeFind),
  resetZoom: () => ipcRenderer.send(IPC.resetZoom),
  suggest: (text) => ipcRenderer.invoke(IPC.suggest, String(text)),
  setOverlayHeight: (px) => ipcRenderer.send(IPC.overlayHeight, Number(px)),
  respondPermission: (id, allow, remember) => ipcRenderer.send(IPC.respondPermission, Number(id), allow === true, remember === true),
  showAppMenu: () => ipcRenderer.send(IPC.appMenu),
  answerDownload: (id, answer) => ipcRenderer.send(IPC.answerDownload, Number(id), String(answer)),
  downloadAction: (id, action) => ipcRenderer.send(IPC.downloadAction, Number(id), String(action)),
  setDownloadsPanel: (open) => ipcRenderer.send(IPC.downloadsPanel, open === true),
  openDownloadsPage: () => ipcRenderer.send(IPC.openDownloadsPage),
  topSites: () => ipcRenderer.invoke(IPC.topSites),
  hideTopSite: (host, hide) => ipcRenderer.send(IPC.hideTopSite, String(host), hide !== false),
  restoreTopSites: () => ipcRenderer.send(IPC.restoreTopSites),
  toggleStar: () => ipcRenderer.send(IPC.toggleStar),
  bookmarkEditorSave: (v) => ipcRenderer.send(IPC.bookmarkEditorSave, { title: String(v.title), url: String(v.url), parentId: Number(v.parentId) }),
  bookmarkEditorRemove: () => ipcRenderer.send(IPC.bookmarkEditorRemove),
  bookmarkEditorClose: () => ipcRenderer.send(IPC.bookmarkEditorClose),
  openBookmark: (id, where) => ipcRenderer.send(IPC.openBookmark, Number(id), String(where)),
  showBookmarkMenu: (id) => ipcRenderer.send(IPC.bookmarkMenu, id === null ? null : Number(id)),
  showBookmarkFolder: (id) => ipcRenderer.send(IPC.bookmarkFolderMenu, Number(id)),
  showBookmarkOverflow: (fromIndex) => ipcRenderer.send(IPC.bookmarkOverflowMenu, Number(fromIndex)),
  moveBookmark: (id, parentId, index) => ipcRenderer.send(IPC.moveBookmark, Number(id), Number(parentId), Number(index)),
  showProfileMenu: () => ipcRenderer.send(IPC.profileMenu),
  editGroup: (id) => ipcRenderer.send(IPC.groupEditor, id === null ? null : Number(id)),
  updateGroup: (id, patch) =>
    ipcRenderer.send(IPC.updateGroup, Number(id), {
      title: patch.title === undefined ? undefined : String(patch.title),
      color: patch.color === undefined ? undefined : String(patch.color),
      collapsed: patch.collapsed === undefined ? undefined : patch.collapsed === true,
    }),
  groupAction: (id, action) => ipcRenderer.send(IPC.groupAction, Number(id), String(action)),
  moveGroup: (id, index) => ipcRenderer.send(IPC.moveGroup, Number(id), Number(index)),
  answerExtensionInstall: (id, allow) => ipcRenderer.send(IPC.answerExtensionInstall, Number(id), allow === true),
  showExtensionMenu: (extensionId) => ipcRenderer.send(IPC.extensionMenu, String(extensionId)),
  answerPasswordOffer: (id, answer, username) => ipcRenderer.send(IPC.answerPasswordOffer, Number(id), String(answer), username === undefined ? undefined : String(username)),
  onState: (cb) => {
    ipcRenderer.on(IPC.state, (_e, state: WindowState) => cb(state));
  },
  onFavicons: (cb) => {
    ipcRenderer.on(IPC.favicons, (_e, favicons: Record<string, string>) => cb(favicons));
  },
  onFocusAddressBar: (cb) => {
    ipcRenderer.on(IPC.focusAddressBar, () => cb());
  },
  onFocusFind: (cb) => {
    ipcRenderer.on(IPC.focusFind, () => cb());
  },
};

contextBridge.exposeInMainWorld('callisto', api);
injectBrowserAction();
