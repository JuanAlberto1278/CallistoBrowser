// Administrador de tareas de Callisto (Shift+Esc, 1.4.0): memoria y CPU de cada proceso, con sus pestañas y extensiones,
// en su propia ventana (como en Chrome y Edge). La página es callisto://tasks (también se puede abrir en una pestaña).
//
// Con el aislamiento de sitios, las pestañas del mismo sitio pueden compartir un proceso: se muestra por proceso, con
// sus pestañas, no una cifra inventada por pestaña.
import { app, BrowserWindow, ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import { INTERNAL_IPC, type TaskRow, type TaskSnapshot } from '../shared/internal-api';
import { internalPageOf, internalUrl } from '../shared/internal-pages';
import { memorySavings } from './memory-savings';
import { resources } from './resource-monitor';
import { describeProcess, sortRows, type Owner } from './task-rows';
import { Tab } from './tab';
import { showWindow } from './test-mode';
import { BrowserWindowController } from './window';

interface Config {
  /** Sesión de las páginas internas (donde se sirve callisto://tasks). */
  session: Session;
  preload: string;
  /** Sesión de la interfaz de las ventanas: su proceso nunca se puede finalizar desde acá. */
  uiSession: Session;
}

let config: Config | null = null;
let win: BrowserWindow | null = null;

export function configureTaskManager(c: Config): void {
  config = c;
}

/** Abre el Administrador de tareas, o lo trae al frente si ya está abierto. */
export function openTaskManager(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    showWindow(win);
    win.focus();
    return;
  }
  if (!config) return;
  const w = new BrowserWindow({
    width: 780,
    height: 500,
    minWidth: 480,
    minHeight: 280,
    title: 'Administrador de tareas - Callisto',
    show: false,
    backgroundColor: '#f7f7f7',
    autoHideMenuBar: true,
    webPreferences: {
      session: config.session,
      preload: config.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win = w;
  w.setMenu(null);
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('closed', () => {
    if (win === w) win = null;
  });
  // Solo esta página: nada de navegar a otro lado ni abrir ventanas
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => showWindow(w));
  void w.loadURL(internalUrl('tasks'));
}

export function closeTaskManager(): void {
  if (win && !win.isDestroyed()) win.close();
}

export function taskManagerContents(): WebContents | null {
  return win && !win.isDestroyed() ? win.webContents : null;
}

const isTaskManager = (wc: WebContents) => taskManagerContents() === wc;

// ---------------------------------------------------------------- qué es cada proceso

function ownerOf(wc: WebContents): Owner {
  if (isTaskManager(wc)) return { kind: 'ui', label: 'Administrador de tareas' };
  if (config && wc.session === config.uiSession) return { kind: 'ui', label: 'Interfaz de Callisto' };
  const tab = Tab.fromWebContents(wc);
  if (tab?.kind === 'internal') return { kind: 'internal', label: `Página de Callisto: ${tab.state.title}` };
  if (tab) return { kind: 'tabs', label: `Pestaña: ${tab.state.title || tab.url}` };
  const url = wc.getURL();
  if (url.startsWith('chrome-extension://')) {
    const id = new URL(url).host;
    const name = wc.session.extensions.getExtension(id)?.name;
    return { kind: 'extension', label: `Extensión: ${name ?? id}` };
  }
  if (url.startsWith('devtools://')) return { kind: 'devtools', label: 'Herramientas para desarrolladores' };
  return { kind: 'other', label: wc.getTitle() || url || 'Página' };
}

function ownersByPid(): Map<number, WebContents[]> {
  const map = new Map<number, WebContents[]>();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const pid = wc.getOSProcessId();
    if (!pid) continue;
    const list = map.get(pid) ?? [];
    list.push(wc);
    map.set(pid, list);
  }
  return map;
}

function snapshot(): { rows: TaskRow[]; byPid: Map<number, WebContents[]> } {
  const samples = resources.sample();
  const byPid = ownersByPid();
  const rows = sortRows(samples.map((s) => describeProcess(s, (byPid.get(s.pid) ?? []).map(ownerOf))));
  return { rows, byPid };
}

// ---------------------------------------------------------------- IPC de la página

/** Solo callisto://tasks (en la ventana del administrador o en una pestaña interna), desde su frame principal. */
function allowed(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (e.senderFrame !== e.sender.mainFrame || internalPageOf(e.senderFrame?.url ?? '') !== 'tasks') return false;
  return isTaskManager(e.sender) || Tab.fromWebContents(e.sender)?.kind === 'internal';
}

export function registerTaskManagerIpc(): void {
  ipcMain.handle(INTERNAL_IPC.tasksList, (e): TaskSnapshot => {
    if (!allowed(e)) throw new Error('No permitido');
    const { rows } = snapshot();
    const tabs = [...BrowserWindowController.all].flatMap((w) => w.tabs);
    return {
      rows,
      totalMb: rows.reduce((sum, r) => sum + r.memoryMb, 0),
      asleepTabs: tabs.filter((t) => t.asleep).length,
      savedTodayMb: memorySavings().todayMb,
    };
  });
  ipcMain.handle(INTERNAL_IPC.tasksEnd, (e, pid: unknown) => {
    if (!allowed(e)) throw new Error('No permitido');
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) return;
    const { rows, byPid } = snapshot();
    if (!rows.some((r) => r.pid === pid && r.canEnd)) return;
    // Termina el proceso de renderizado: todas sus páginas muestran "La página dejó de funcionar"
    const wc = (byPid.get(pid) ?? []).find((w) => !w.isDestroyed());
    wc?.forcefullyCrashRenderer();
  });
}
