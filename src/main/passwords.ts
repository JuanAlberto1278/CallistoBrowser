import { ipcMain, type IpcMainEvent } from 'electron';
import { Tab, type PendingLogin } from './tab';
import { BrowserWindowController } from './window';
import { AutofillPopup } from './autofill-popup';
import { AUTOFILL_IPC } from '../shared/autofill-ipc';
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, PW_IPC, isLoginOrigin, type FieldRect } from '../shared/passwords';

// Contraseñas en las páginas web (V0.9): sugerencias, relleno y oferta de guardar. Ver docs/09-v0.9-contrasenas.md.
//
// Reglas:
// - Solo se atiende al frame principal de una pestaña web, y el sitio es SIEMPRE el origen real de ese frame según
//   Chromium (nunca un dato que mande la página).
// - Se rellena solo cuando el usuario elige una sugerencia; se sugieren solo las del sitio exacto.
// - Nada se guarda sin que el usuario lo acepte, y nada se ofrece en una ventana privada.
// - La contraseña enviada vive solo en la memoria del proceso principal hasta que el usuario decide (o vence).

/** Cuánto se espera a saber si el inicio de sesión funcionó. */
const LOGIN_TIMEOUT = 60_000;
/** Cuánto vale el usuario de un primer paso (inicio de sesión en dos pasos). */
const USERNAME_TIMEOUT = 5 * 60_000;

let nextOfferId = 1;
const watchedTabs = new WeakSet<Tab>();

interface PageContext {
  tab: Tab;
  win: BrowserWindowController;
  origin: string;
}

function fromPage(e: IpcMainEvent): PageContext | undefined {
  const tab = Tab.fromWebContents(e.sender);
  if (!tab || tab.kind !== 'web' || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return undefined;
  const origin = e.senderFrame.origin;
  if (!isLoginOrigin(origin)) return undefined;
  const win = BrowserWindowController.ofTab(tab);
  return win ? { tab, win, origin } : undefined;
}

const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function isRect(v: unknown): v is FieldRect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return finite(r.x, -1e5, 1e5) && finite(r.y, -1e5, 1e5) && finite(r.width, 0, 1e5) && finite(r.height, 0, 1e5);
}

/** Muestra la oferta de guardar o actualizar (o nada, si ya estaba guardado igual). */
async function offer(tab: Tab, p: PendingLogin): Promise<void> {
  if (tab.pendingLogin === p) tab.pendingLogin = null;
  const vault = tab.profile.passwords;
  if ((await vault.open()) !== 'ready') return;
  const check = await vault.check(p.origin, p.username, p.password);
  if (check.kind === 'same') {
    vault.markUsed(check.id);
    return;
  }
  if (tab.webContents.isDestroyed()) return;
  tab.setPasswordOffer({
    offer: { id: nextOfferId++, mode: check.kind === 'update' ? 'update' : 'save', origin: p.origin, username: p.username, passwordLength: Math.min(p.password.length, 24) },
    password: p.password,
    loginId: check.kind === 'update' ? check.id : null,
  });
}

function onSubmit(c: PageContext, data: unknown): void {
  const { tab, origin } = c;
  const profile = tab.profile;
  if (profile.isPrivate || !profile.settings.offerPasswords) return;
  if (!data || typeof data !== 'object') return;
  const { username, password } = data as Record<string, unknown>;
  if (typeof username !== 'string' || username.length > MAX_USERNAME_LENGTH) return;
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return;
  if (profile.passwords.isBlocked(origin)) return;
  let user = username;
  const candidate = tab.usernameCandidate;
  if (!user && candidate && candidate.origin === origin && Date.now() - candidate.at < USERNAME_TIMEOUT) user = candidate.username;
  const pending: PendingLogin = { origin, username: user, password, at: Date.now(), navigated: false };
  tab.pendingLogin = pending;
  if (!watchedTabs.has(tab)) {
    watchedTabs.add(tab);
    tab.on('navigated', () => {
      if (tab.pendingLogin) tab.pendingLogin.navigated = true;
    });
  }
  setTimeout(() => {
    if (tab.pendingLogin === pending) tab.pendingLogin = null;
  }, LOGIN_TIMEOUT).unref();
}

/** La interfaz respondió a la oferta de guardar. */
export async function answerPasswordOffer(tab: Tab, id: number, answer: 'save' | 'never' | 'dismiss', username?: string): Promise<void> {
  const current = tab.passwordOffer;
  if (!current || current.offer.id !== id) return;
  tab.setPasswordOffer(null);
  const vault = tab.profile.passwords;
  const { origin } = current.offer;
  if (answer === 'never') return vault.block(origin);
  if (answer !== 'save') return;
  try {
    if (current.offer.mode === 'update' && current.loginId !== null) await vault.update(current.loginId, { password: current.password });
    else await vault.save(origin, typeof username === 'string' ? username.trim().slice(0, MAX_USERNAME_LENGTH) : current.offer.username, current.password);
  } catch {
    /* sin cifrado disponible o dato inválido: no se guarda */
  }
}

export function registerPasswordIpc(isTrustedUiUrl: (url: string) => boolean): void {
  ipcMain.on(PW_IPC.focus, (e, rect: unknown) => {
    const c = fromPage(e);
    if (!c || !isRect(rect) || c.win.active !== c.tab) return;
    c.win.autofill.show(c.tab, c.origin, rect, c.tab.profile.passwords.forOrigin(c.origin));
  });
  ipcMain.on(PW_IPC.blur, (e) => {
    const c = fromPage(e);
    if (c) c.win.autofill.blurSoon(c.tab);
  });
  ipcMain.on(PW_IPC.select, (e, index: unknown) => {
    const c = fromPage(e);
    if (c && typeof index === 'number' && Number.isSafeInteger(index)) c.win.autofill.select(c.tab, index);
  });
  ipcMain.on(PW_IPC.choose, (e, index: unknown) => {
    const c = fromPage(e);
    if (c && typeof index === 'number' && Number.isSafeInteger(index)) void c.win.autofill.choose(c.tab, index);
  });
  ipcMain.on(PW_IPC.submit, (e, data: unknown) => {
    const c = fromPage(e);
    if (c) onSubmit(c, data);
  });
  ipcMain.on(PW_IPC.username, (e, username: unknown) => {
    const c = fromPage(e);
    if (!c || typeof username !== 'string' || !username || username.length > MAX_USERNAME_LENGTH) return;
    c.tab.usernameCandidate = { origin: c.origin, username, at: Date.now() };
  });
  // El formulario desapareció después de enviarlo (páginas que no recargan): el inicio de sesión funcionó
  ipcMain.on(PW_IPC.gone, (e) => {
    const c = fromPage(e);
    const p = c?.tab.pendingLogin;
    if (c && p && p.origin === c.origin) void offer(c.tab, p);
  });
  // Página nueva después de enviar: si vuelve a pedir la contraseña, el inicio de sesión falló
  ipcMain.on(PW_IPC.page, (e, hasPasswordForm: unknown) => {
    const c = fromPage(e);
    const p = c?.tab.pendingLogin;
    if (!c || !p || !p.navigated) return;
    if (hasPasswordForm === true) c.tab.pendingLogin = null;
    else void offer(c.tab, p);
  });

  // Menú de sugerencias (su propia vista de la interfaz)
  const fromPopup = (e: IpcMainEvent) => {
    const popup = AutofillPopup.fromContents(e.sender);
    if (!popup || e.senderFrame !== e.sender.mainFrame || !isTrustedUiUrl(e.senderFrame?.url ?? '')) return undefined;
    return popup;
  };
  ipcMain.on(AUTOFILL_IPC.ready, (e) => fromPopup(e)?.sendState());
  ipcMain.on(AUTOFILL_IPC.choose, (e, index: unknown) => {
    if (typeof index === 'number' && Number.isSafeInteger(index)) void fromPopup(e)?.choose(null, index);
  });
  ipcMain.on(AUTOFILL_IPC.manage, (e) => fromPopup(e)?.manage());
}
