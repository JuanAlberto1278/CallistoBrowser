// Preload de la interfaz del navegador: expone a la interfaz una API mínima y tipada.
// No expone ipcRenderer ni nada de Node.
import { contextBridge, ipcRenderer } from 'electron';
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
  moveTab: (id, index) => ipcRenderer.send(IPC.moveTab, Number(id), Number(index)),
  showTabMenu: (id) => ipcRenderer.send(IPC.tabMenu, id === null ? null : Number(id)),
  find: (query, forward, newSession) => ipcRenderer.send(IPC.find, String(query), forward === true, newSession === true),
  closeFind: () => ipcRenderer.send(IPC.closeFind),
  resetZoom: () => ipcRenderer.send(IPC.resetZoom),
  suggest: (text) => ipcRenderer.invoke(IPC.suggest, String(text)),
  setOverlayHeight: (px) => ipcRenderer.send(IPC.overlayHeight, Number(px)),
  respondPermission: (id, allow, remember) => ipcRenderer.send(IPC.respondPermission, Number(id), allow === true, remember === true),
  showAppMenu: () => ipcRenderer.send(IPC.appMenu),
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
