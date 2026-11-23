import { app, WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import type { Tab } from './tab';
import { AUTOFILL_IPC } from '../shared/autofill-ipc';
import { themeVars } from '../shared/themes';
import { PW_IPC, autofillBounds, hostOf, type AutofillPopupState, type FieldRect, type LoginSummary } from '../shared/passwords';

export interface AutofillPopupOptions {
  session: Session;
  /** callisto://ui/autofill.html (o el servidor de desarrollo). */
  url: string;
  preload: string;
  /** "Administrar contraseñas": abre callisto://passwords. */
  onManage(): void;
}

/**
 * Menú de sugerencias de contraseñas de una ventana: una vista propia de la interfaz (sesión interna, sin acceso a la
 * web) que se ubica debajo del campo enfocado, encima de la página, sin tapar el resto de la página. Rellena el
 * formulario SOLO cuando el usuario elige una sugerencia.
 */
export class AutofillPopup {
  private static readonly byContents = new Map<number, AutofillPopup>();

  static fromContents(wc: WebContents): AutofillPopup | undefined {
    return this.byContents.get(wc.id);
  }

  private view: WebContentsView | null = null;
  private contents: WebContents | null = null;
  private tab: Tab | null = null;
  private origin = '';
  private items: LoginSummary[] = [];
  private selected = -1;
  private blurTimer: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;
  /** Si el menú no se vuelve a usar en un rato, se libera su proceso (ahorro de memoria). */
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly win: BaseWindow, private readonly opts: AutofillPopupOptions) {}

  get openFor(): Tab | null {
    return this.tab;
  }

  private ensureView(): WebContentsView {
    if (this.view && this.contents && !this.contents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.opts.session,
        preload: this.opts.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    const wc = view.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const id = wc.id;
    AutofillPopup.byContents.set(id, this);
    wc.on('destroyed', () => AutofillPopup.byContents.delete(id));
    void wc.loadURL(this.opts.url);
    this.view = view;
    this.contents = wc;
    return view;
  }

  /** Muestra las sugerencias de `origin` debajo del campo `field` de la pestaña. */
  show(tab: Tab, origin: string, field: FieldRect, items: LoginSummary[]): void {
    if (!items.length || this.win.isDestroyed()) return this.hide();
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    const page = tab.view.getBounds();
    const { width, height } = this.win.getContentBounds();
    const bounds = autofillBounds(field, tab.webContents.getZoomFactor(), page, { width, height }, items.length);
    if (!bounds) return this.hide();
    this.cancelBlur();
    if (this.tab !== tab) {
      this.detach?.();
      // Si la pestaña navega o se cierra, el menú se va
      const close = () => this.hide();
      const onNav = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) close();
      };
      tab.webContents.on('did-start-navigation', onNav);
      tab.webContents.once('destroyed', close);
      this.detach = () => {
        if (!tab.webContents.isDestroyed()) {
          tab.webContents.off('did-start-navigation', onNav);
          tab.webContents.off('destroyed', close);
        }
      };
    }
    this.tab = tab;
    this.origin = origin;
    this.items = items;
    this.selected = -1;
    const view = this.ensureView();
    view.setBounds(bounds);
    this.win.contentView.addChildView(view); // arriba de todo
    view.setVisible(true);
    this.sendState();
    tab.webContents.mainFrame.send(PW_IPC.popup, { open: true, count: items.length });
  }

  sendState(): void {
    if (!this.contents || this.contents.isDestroyed()) return;
    const theme = this.tab ? themeVars(this.tab.profile.theme) : null;
    const state: AutofillPopupState = {
      items: this.items.map((l) => ({ id: l.id, username: l.username, host: hostOf(l.origin) })),
      selected: this.selected,
      theme: { vars: theme?.ui ?? null, mode: theme?.mode ?? 'light' },
    };
    this.contents.send(AUTOFILL_IPC.state, state);
  }

  select(tab: Tab, index: number): void {
    if (tab !== this.tab) return;
    this.selected = index >= 0 && index < this.items.length ? index : -1;
    this.sendState();
  }

  /** El campo perdió el foco: se cierra, salvo que sea porque el usuario está haciendo clic en el menú. */
  blurSoon(tab: Tab): void {
    if (tab !== this.tab) return;
    this.cancelBlur();
    this.blurTimer = setTimeout(() => this.hide(), 200);
  }

  private cancelBlur(): void {
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = null;
  }

  hide(): void {
    this.cancelBlur();
    this.detach?.();
    this.detach = null;
    const tab = this.tab;
    this.tab = null;
    this.items = [];
    this.selected = -1;
    if (this.view && !this.win.isDestroyed()) this.view.setVisible(false);
    if (tab && !tab.webContents.isDestroyed()) tab.webContents.mainFrame.send(PW_IPC.popup, { open: false, count: 0 });
    if (this.view && !this.releaseTimer) {
      this.releaseTimer = setTimeout(() => this.release(), 60_000);
      this.releaseTimer.unref();
    }
  }

  /** Cierra la vista del menú (y su proceso); se vuelve a crear la próxima vez que haga falta. */
  private release(): void {
    this.releaseTimer = null;
    if (this.tab || !this.view) return;
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view);
    if (this.contents && !this.contents.isDestroyed()) this.contents.close();
    this.view = null;
    this.contents = null;
  }

  /** El usuario eligió una sugerencia (clic en el menú, o flechas + Enter en el campo): rellena el formulario. */
  async choose(tab: Tab | null, index: number): Promise<void> {
    const target = tab ?? this.tab;
    if (!target || target !== this.tab) return;
    const item = this.items[index];
    const origin = this.origin;
    this.hide();
    if (!item) return;
    const wc = target.webContents;
    // El sitio se vuelve a comprobar antes y después de descifrar: si la página navegó, no se rellena nada
    if (wc.isDestroyed() || wc.mainFrame.origin !== origin) return;
    let password: string;
    try {
      password = await target.profile.passwords.password(item.id);
    } catch {
      return;
    }
    if (wc.isDestroyed() || wc.mainFrame.origin !== origin) return;
    wc.mainFrame.send(PW_IPC.fill, { origin, username: item.username, password });
    target.profile.passwords.markUsed(item.id);
    wc.focus();
  }

  manage(): void {
    this.hide();
    this.opts.onManage();
  }

  destroy(): void {
    this.hide();
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (this.contents && !this.contents.isDestroyed()) this.contents.close();
    this.view = null;
    this.contents = null;
  }
}
