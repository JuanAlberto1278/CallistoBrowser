// Preload del menú de sugerencias de contraseñas (vista propia de la interfaz, sesión interna).
// Expone solo lo que el menú necesita: recibir la lista (usuarios y sitios, nunca contraseñas) y avisar la elección.
import { contextBridge, ipcRenderer } from 'electron';
// Solo tipos de shared/passwords (sin código): ver la nota de shared/autofill-ipc.ts
import type { AutofillPopupState } from '../shared/passwords';
import { AUTOFILL_IPC } from '../shared/autofill-ipc';

export interface CallistoAutofillApi {
  onState(cb: (state: AutofillPopupState) => void): void;
  choose(index: number): void;
  manage(): void;
}

const api: CallistoAutofillApi = {
  onState: (cb) => {
    ipcRenderer.on(AUTOFILL_IPC.state, (_e, state: AutofillPopupState) => cb(state));
    ipcRenderer.send(AUTOFILL_IPC.ready);
  },
  choose: (index) => ipcRenderer.send(AUTOFILL_IPC.choose, Number(index)),
  manage: () => ipcRenderer.send(AUTOFILL_IPC.manage),
};

contextBridge.exposeInMainWorld('callistoAutofill', api);
