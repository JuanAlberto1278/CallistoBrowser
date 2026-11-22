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
  onState: (cb) => {
    ipcRenderer.on(IPC.state, (_e, state: WindowState) => cb(state));
  },
  onFocusAddressBar: (cb) => {
    ipcRenderer.on(IPC.focusAddressBar, () => cb());
  },
};

contextBridge.exposeInMainWorld('callisto', api);
