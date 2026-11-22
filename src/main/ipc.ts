import { ipcMain, type IpcMainEvent } from 'electron';
import { BrowserWindowController } from './window';
import { IPC, MAX_ADDRESS_INPUT, MAX_FIND_INPUT } from '../shared/ipc';

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * Toda petición IPC debe venir del webContents de la interfaz de una ventana conocida y de un frame cuyo origen
 * sea el de la interfaz. Cualquier otro remitente (una página web, un frame inyectado) se ignora.
 * Los ids de pestaña solo se aceptan si la pestaña pertenece a la ventana que envía el mensaje.
 */
export function registerIpc(isTrustedUiUrl: (url: string) => boolean): void {
  const from = (e: IpcMainEvent): BrowserWindowController | undefined => {
    const c = BrowserWindowController.fromUi(e.sender);
    if (!c) return undefined;
    const frameUrl = e.senderFrame?.url ?? '';
    if (!isTrustedUiUrl(frameUrl) || e.senderFrame !== e.sender.mainFrame) return undefined;
    return c;
  };
  const tabOf = (c: BrowserWindowController, id: unknown) => (isId(id) ? c.tabs.find((t) => t.id === id) : undefined);

  ipcMain.on(IPC.uiReady, (e) => from(e)?.onUiReady());
  ipcMain.on(IPC.navigate, (e, input: unknown) => {
    const c = from(e);
    if (!c || typeof input !== 'string') return;
    if (c.active.navigate(input.slice(0, MAX_ADDRESS_INPUT))) c.active.webContents.focus();
  });
  ipcMain.on(IPC.goBack, (e) => from(e)?.active.goBack());
  ipcMain.on(IPC.goForward, (e) => from(e)?.active.goForward());
  ipcMain.on(IPC.reload, (e, ignoreCache: unknown) => from(e)?.active.reload(ignoreCache === true));
  ipcMain.on(IPC.stop, (e) => from(e)?.active.stop());
  ipcMain.on(IPC.dismissNotice, (e, id: unknown) => {
    if (typeof id === 'number') from(e)?.active.dismissNotice(id);
  });

  ipcMain.on(IPC.newTab, (e) => from(e)?.newTab());
  ipcMain.on(IPC.closeTab, (e, id: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab) c.closeTab(tab);
  });
  ipcMain.on(IPC.activateTab, (e, id: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab) c.activate(tab);
  });
  ipcMain.on(IPC.moveTab, (e, id: unknown, index: unknown) => {
    const c = from(e);
    const tab = c && tabOf(c, id);
    if (tab && typeof index === 'number' && Number.isSafeInteger(index)) c.moveTab(tab, index);
  });
  ipcMain.on(IPC.tabMenu, (e, id: unknown) => {
    const c = from(e);
    if (!c) return;
    if (id === null) return c.showTabMenu(null);
    const tab = tabOf(c, id);
    if (tab) c.showTabMenu(tab);
  });

  ipcMain.on(IPC.find, (e, query: unknown, forward: unknown, newSession: unknown) => {
    const c = from(e);
    if (!c || typeof query !== 'string') return;
    c.active.find(query.slice(0, MAX_FIND_INPUT), forward !== false, newSession === true);
  });
  ipcMain.on(IPC.closeFind, (e) => from(e)?.closeFind());
  ipcMain.on(IPC.resetZoom, (e) => from(e)?.active.zoom('reset'));
}
