import { ipcMain, type IpcMainEvent } from 'electron';
import { BrowserWindowController } from './window';
import { IPC, MAX_ADDRESS_INPUT } from '../shared/ipc';

/**
 * Toda petición IPC debe venir del webContents de la interfaz de una ventana conocida y de un frame cuyo origen
 * sea el de la interfaz. Cualquier otro remitente (una página web, un frame inyectado) se ignora.
 */
export function registerIpc(isTrustedUiUrl: (url: string) => boolean): void {
  const from = (e: IpcMainEvent): BrowserWindowController | undefined => {
    const c = BrowserWindowController.fromUi(e.sender);
    if (!c) return undefined;
    const frameUrl = e.senderFrame?.url ?? '';
    if (!isTrustedUiUrl(frameUrl) || e.senderFrame !== e.sender.mainFrame) return undefined;
    return c;
  };

  ipcMain.on(IPC.uiReady, (e) => from(e)?.onUiReady());
  ipcMain.on(IPC.navigate, (e, input: unknown) => {
    const c = from(e);
    if (!c || typeof input !== 'string') return;
    if (c.tab.navigate(input.slice(0, MAX_ADDRESS_INPUT))) c.tab.webContents.focus();
  });
  ipcMain.on(IPC.goBack, (e) => from(e)?.tab.goBack());
  ipcMain.on(IPC.goForward, (e) => from(e)?.tab.goForward());
  ipcMain.on(IPC.reload, (e, ignoreCache: unknown) => from(e)?.tab.reload(ignoreCache === true));
  ipcMain.on(IPC.stop, (e) => from(e)?.tab.stop());
  ipcMain.on(IPC.dismissNotice, (e, id: unknown) => {
    if (typeof id === 'number') from(e)?.dismissNotice(id);
  });
}
