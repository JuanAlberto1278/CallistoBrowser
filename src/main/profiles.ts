import { existsSync, rmSync } from 'node:fs';
import { clearOnExit, clearOnExitPending, markClearOnExit } from './browsing-data';
import { hasClearOnExit } from '../shared/settings';
import { importSources } from './importer';
import { BROWSER_NAMES } from '../shared/import';
import { join } from 'node:path';
import { webContents, type BaseWindow, type Session, type WebContents } from 'electron';
import { ExtensionManager, type ExtensionHost } from './extensions/manager';
import { registerCallistoApis } from './extensions/callisto-apis';
import { registerBrowserApis } from './extensions/browser-apis';
import { registerNativeMessaging } from './extensions/native-messaging';
import { UserScripts } from './extensions/user-scripts';
import { matchShortcut } from './shortcuts';
import { Profile, type InternalPages } from './profile';
import { ProfileRegistry } from './profile-registry';
import { SessionStore } from './session-store';
import { NO_SESSION_SAVER, SessionSaver } from './session-saver';
import { ClosedTabs } from './closed-tabs';
import { Tab } from './tab';
import { BrowserWindowController, type ProfilesApi, type SessionSaver as WindowSessionSaver, type WindowContext } from './window';
import type { ProfileColor, ProfileInfo, WindowProfile } from '../shared/profiles';

export interface ProfileManagerConfig {
  userDataDir: string;
  userAgent: string;
  webContentPreload: string;
  internal: InternalPages;
  defaultDownloadDir: string;
  uiSession: Session;
  uiUrl: string;
  uiPreload: string;
  /** Preload de las páginas y service workers de las extensiones (`browser` = `chrome`, APIs de Callisto). */
  extensionApiPreload: string;
}

interface Runtime {
  ctx: WindowContext;
  saver: WindowSessionSaver & { resume(): void; disable(): void };
  store: SessionStore | null;
  /** El aviso de base dañada ya se mostró. */
  noticeShown: boolean;
}

/**
 * Perfiles abiertos y sus ventanas. Cada perfil se abre la primera vez que se necesita (su sesión de Chromium, su base,
 * su guardado de sesión) y queda abierto hasta salir. Las ventanas privadas de un perfil comparten un perfil privado
 * efímero, que se descarta al cerrar la última.
 */
export class ProfileManager implements ProfilesApi {
  private readonly runtimes = new Map<string, Runtime>();
  /** Perfil privado de cada perfil (por id del perfil de origen). */
  private readonly privates = new Map<string, Runtime>();
  private privateSeq = 0;
  /** Callisto está saliendo: las ventanas se cierran una por una y no deben cambiar qué perfiles estaban abiertos. */
  private quitting = false;

  constructor(private readonly cfg: ProfileManagerConfig, readonly registry: ProfileRegistry) {}

  /** Borra los archivos de los perfiles eliminados (al arrancar, antes de abrir ninguna sesión). */
  cleanupDeleted(): void {
    const done: string[] = [];
    for (const id of this.registry.pendingDelete) {
      try {
        for (const dir of [join(this.cfg.userDataDir, 'Profiles', id), join(this.cfg.userDataDir, 'Partitions', `profile-${id}`)]) {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
        done.push(id);
      } catch {
        /* se reintenta en el próximo arranque */
      }
    }
    if (done.length) this.registry.deleted(done);
  }

  // ---------------------------------------------------------------- perfiles abiertos

  private runtime(id: string): Runtime {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const info = this.registry.get(id);
    if (!info) throw new Error(`perfil desconocido: ${id}`);
    const profile = new Profile(id, {
      userAgent: this.cfg.userAgent,
      webContentPreload: this.cfg.webContentPreload,
      dataDir: join(this.cfg.userDataDir, 'Profiles', id),
      internal: this.cfg.internal,
      defaultDownloadDir: this.cfg.defaultDownloadDir,
      name: info.name,
      color: info.color,
    });
    profile.history.expire();
    // "Al cerrar Callisto, borrar" (1.5): si la última vez se cerró de golpe, se borra ahora
    if (clearOnExitPending(profile)) void clearOnExit(profile).finally(() => markClearOnExit(profile));
    else markClearOnExit(profile);
    this.wire(profile);
    profile.extensions = new ExtensionManager(profile, join(this.cfg.userDataDir, 'Profiles', id, 'Extensions'), this.extensionHost, { apiPreload: this.cfg.extensionApiPreload });
    profile.extensions.on('changed', () => BrowserWindowController.refreshAll());
    registerCallistoApis(profile.extensions, { windows: () => this.windowsOf(profile) });
    const extensions = profile.extensions;

    const store = new SessionStore(profile.kv);
    const closedTabs = new ClosedTabs(store.load().closed);
    const windowsOf = () => [...BrowserWindowController.all].filter((w) => w.ctx.profile === profile);
    const saver = new SessionSaver(
      store,
      () => {
        const wins = windowsOf();
        return { version: 1, windows: wins.filter((w) => !w.closing || wins.length === 1).map((w) => w.saved()), closed: closedTabs.entries() };
      },
      (w) => {
        const wins = windowsOf();
        return wins.length === 1 && wins[0] === w;
      },
    );
    closedTabs.onChange = () => saver.markDirty();
    // APIs de extensiones sobre el historial, las cerradas, las descargas, la barra y los atajos (1.4.2)
    extensions.browser = registerBrowserApis(extensions, {
      windows: () => this.windowsOf(profile),
      current: () => this.windowFor(profile, null),
      closedTabs,
      newWindow: (url) => void new BrowserWindowController(this.runtime(profile.id).ctx, { url }),
      isBrowserShortcut,
    });
    // Programas instalados (1.4.3): se pregunta la primera vez
    registerNativeMessaging(extensions, { parentWindow: () => this.windowFor(profile, null)?.win ?? null });
    // Scripts de usuario (1.4.4): solo con "Permitir scripts de usuario" activado para la extensión
    extensions.userScripts = new UserScripts(extensions);
    const rt: Runtime = { ctx: this.makeContext(profile, closedTabs, saver), saver, store, noticeShown: false };
    this.runtimes.set(id, rt);
    return rt;
  }

  private makeContext(profile: Profile, closedTabs: ClosedTabs, saver: WindowSessionSaver): WindowContext {
    return { profile, uiSession: this.cfg.uiSession, uiUrl: this.cfg.uiUrl, uiPreload: this.cfg.uiPreload, closedTabs, session: saver, profiles: this };
  }

  /** Eventos de un perfil hacia sus ventanas (descargas, permisos, cambios de configuración y favoritos). */
  private wire(profile: Profile): void {
    profile.downloads.on('request', (req) => {
      const wc = req.sourceId !== null ? webContents.fromId(req.sourceId) : undefined;
      const tab = wc ? Tab.fromWebContents(wc) : undefined;
      const ownWindows = () => [...BrowserWindowController.all].filter((w) => w.ctx.profile === profile && !w.closing);
      let win = tab ? BrowserWindowController.ofTab(tab) : undefined;
      // Un enlace que abrió una pestaña vacía solo para descargar (target=_blank): se cierra, como en Chrome
      if (tab && win && tab.isBlank && !tab.newTabPage && tab.openerId !== null && tab.webContents.navigationHistory.length() <= 1) {
        const opener = win.tabs.find((t) => t.id === tab.openerId);
        if (opener) req.sourceId = opener.webContents.id;
        win.closeTab(tab);
        if (win.closing) win = undefined;
      }
      // Siempre en una ventana del mismo perfil
      const current = BrowserWindowController.current();
      win ??= current?.ctx.profile === profile ? current : ownWindows().at(-1);
      if (!win) {
        profile.downloads.deny(req.id);
        return;
      }
      req.windowId = win.id;
      win.onDownloadRequest();
    });
    profile.downloads.on('changed', () => BrowserWindowController.refreshAll());
    profile.on('permission-request', (wc, request) => {
      const tab = Tab.fromWebContents(wc);
      if (tab) tab.requestPermission(request);
      else request.respond(false, false);
    });
    profile.on('settings-changed', () => {
      markClearOnExit(profile);
      BrowserWindowController.settingsChanged();
    });
    profile.on('bookmarks-changed', () => BrowserWindowController.refreshAll());
    // Un ajuste del sitio cambió (1.5): el sonido se aplica ya; JavaScript e imágenes, al recargar la página
    profile.on('site-settings-changed', () => {
      for (const w of this.windowsOf(profile)) for (const t of w.tabs) t.applySiteSound();
      BrowserWindowController.refreshAll();
    });
  }

  private windowsOf(profile: Profile): BrowserWindowController[] {
    return [...BrowserWindowController.all].filter((w) => w.ctx.profile === profile && !w.closing);
  }

  /** La ventana de la pestaña `source`; si no, la actual (si es del perfil) o la última del perfil. */
  private windowFor(profile: Profile, source: WebContents | null): BrowserWindowController | undefined {
    const tab = source ? Tab.fromWebContents(source) : undefined;
    const own = tab ? BrowserWindowController.ofTab(tab) : undefined;
    if (own && !own.closing) return own;
    const current = BrowserWindowController.current();
    return current && current.ctx.profile === profile && !current.closing ? current : this.windowsOf(profile).at(-1);
  }

  /** Lo que las extensiones de un perfil pueden pedirle a las ventanas de Callisto. */
  private readonly extensionHost: ExtensionHost = {
    createTab: async (profile, d) => {
      const target = d.windowId !== undefined ? this.windowsOf(profile).find((w) => w.win.id === d.windowId) : undefined;
      const win = target ?? this.windowFor(profile, null) ?? this.openProfile(profile.id);
      const url = typeof d.url === 'string' && d.url ? d.url : undefined;
      const tab = win.newTab({ url, activate: d.active !== false, index: typeof d.index === 'number' ? d.index : undefined });
      return [tab.webContents, win.win];
    },
    selectTab: (wc) => {
      const tab = Tab.fromWebContents(wc);
      const win = tab && BrowserWindowController.ofTab(tab);
      if (!tab || !win) return;
      win.activate(tab);
      win.focus();
    },
    removeTab: (wc) => {
      const tab = Tab.fromWebContents(wc);
      const win = tab && BrowserWindowController.ofTab(tab);
      if (tab && win) win.closeTab(tab);
    },
    createWindow: async (profile, d) => {
      const url = Array.isArray(d.url) ? d.url[0] : d.url;
      const w = new BrowserWindowController(this.runtime(profile.id).ctx, { url: typeof url === 'string' && url ? url : undefined });
      return w.win;
    },
    removeWindow: (win: BaseWindow) => {
      for (const w of BrowserWindowController.all) if (w.win === win && !win.isDestroyed()) w.forceClose();
    },
    confirmInstall: (profile, source, prompt) => this.windowFor(profile, source)?.askExtensionInstall(prompt) ?? Promise.resolve(false),
    parentWindow: (profile, source) => this.windowFor(profile, source)?.win ?? null,
    notify: (source, text) => {
      const tab = source ? Tab.fromWebContents(source) : undefined;
      if (tab) tab.showNotice('warning', text);
    },
    assignTabDetails: (details, wc) => {
      const tab = Tab.fromWebContents(wc);
      if (!tab) return;
      (details as chrome.tabs.Tab & { groupId: number }).groupId = tab.groupId ?? -1;
      details.pinned = tab.pinned;
      // La posición real en la ventana (la librería deja -1) y "resaltada" como la activa (1.4.2)
      const win = BrowserWindowController.ofTab(tab);
      if (win) details.index = win.tabs.indexOf(tab);
      details.highlighted = details.active;
      details.discarded = false;
    },
  };

  /**
   * Abre (o muestra) un perfil. Si ya tiene ventanas, enfoca la última. Si no, restaura su sesión (según su
   * configuración) o abre una ventana nueva.
   */
  openProfile(id: string, opts: { url?: string } = {}): BrowserWindowController {
    const rt = this.runtime(id);
    const existing = this.windowsOf(rt.ctx.profile);
    if (existing.length) {
      const w = existing.at(-1)!;
      if (opts.url) w.newTab({ url: opts.url });
      w.focus();
      return w;
    }
    rt.saver.resume();
    const saved = rt.store?.load();
    const settings = rt.ctx.profile.settings;
    const restore = settings.startup === 'restore' ? (saved?.windows ?? []) : [];
    let last: BrowserWindowController | undefined;
    for (const w of restore) {
      last = new BrowserWindowController(rt.ctx, { restore: { tabs: w.tabs, active: w.active, groups: w.groups }, bounds: w.bounds, maximized: w.maximized });
    }
    // Páginas específicas (1.5): la primera queda al frente; una dirección recibida (desde otro programa), al final
    const pages = !last && settings.startup === 'pages' ? settings.startupPages : [];
    if (pages.length) {
      last = new BrowserWindowController(rt.ctx, { url: pages[0] });
      for (const url of pages.slice(1)) last.newTab({ url, index: last.tabs.length, activate: false });
      if (opts.url) last.newTab({ url: opts.url, index: last.tabs.length });
    } else if (!last) last = new BrowserWindowController(rt.ctx, { url: opts.url });
    else if (opts.url) last.newTab({ url: opts.url });

    this.offerImport(rt.ctx.profile, last);
    if (rt.ctx.profile.recoveredDatabase && !rt.noticeShown) {
      rt.noticeShown = true;
      last.active.showNotice('warning', 'Los datos de este perfil (historial, sesión) estaban dañados y se empezó de nuevo. La copia dañada se guardó aparte.');
    }
    return last;
  }

  /**
   * La primera vez que se abre un perfil nuevo (sin historial), si hay Chrome o Edge en la computadora: un aviso que
   * ofrece importar (1.6). Una sola vez por perfil; los perfiles que ya se usaban no lo ven.
   */
  private offerImport(profile: Profile, win: BrowserWindowController): void {
    if (profile.isPrivate || profile.kv.get('import.offered') === true) return;
    profile.kv.set('import.offered', true);
    if (profile.history.count() > 0) return;
    const browsers = [...new Set(importSources().map((s) => BROWSER_NAMES[s.browser]))];
    if (!browsers.length) return;
    win.active.showNotice('info', `Encontramos ${browsers.join(' y ')} en esta computadora. ¿Querés traer tus favoritos, historial y contraseñas?`, [{ id: 'open-import', label: 'Importar…' }]);
  }

  /** Ventana privada del perfil de `from` (o del mismo perfil de origen, si `from` ya es privada). */
  openPrivateWindow(from: WindowContext, url?: string): BrowserWindowController {
    const parent = from.profile.parent ?? from.profile;
    let rt = this.privates.get(parent.id);
    if (!rt) {
      const profile = new Profile(`${parent.id}-privado`, {
        userAgent: this.cfg.userAgent,
        webContentPreload: this.cfg.webContentPreload,
        dataDir: '',
        internal: this.cfg.internal,
        defaultDownloadDir: this.cfg.defaultDownloadDir,
        name: parent.name,
        color: parent.color,
        // Partición nueva cada vez: nada de una sesión privada anterior llega a la siguiente
        private: { parent, partition: `callisto-private-${++this.privateSeq}` },
      });
      this.wire(profile);
      rt = { ctx: this.makeContext(profile, new ClosedTabs(), NO_SESSION_SAVER), saver: NO_SESSION_SAVER, store: null, noticeShown: true };
      this.privates.set(parent.id, rt);
    }
    return new BrowserWindowController(rt.ctx, { url });
  }

  // ---------------------------------------------------------------- ciclo de vida de las ventanas

  windowOpened(w: BrowserWindowController): void {
    if (!w.ctx.profile.isPrivate) this.registry.setLastUsed(w.ctx.profile.id);
    this.updateLastActive();
  }

  windowClosed(w: BrowserWindowController): void {
    const profile = w.ctx.profile;
    if (profile.isPrivate && this.windowsOf(profile).length === 0) {
      // Última ventana privada: se descarta todo lo de esa sesión
      this.privates.delete(profile.parent!.id);
      void profile.discard();
    }
    this.updateLastActive();
  }

  /** Perfiles con ventanas abiertas (los que se vuelven a abrir al arrancar). Al cerrar la última ventana se conserva. */
  private updateLastActive(): void {
    if (this.quitting) return;
    const ids = [...new Set(this.openWindows().filter((w) => !w.ctx.profile.isPrivate).map((w) => w.ctx.profile.id))];
    if (ids.length) this.registry.setLastActive(ids);
  }

  private openWindows(): BrowserWindowController[] {
    return [...BrowserWindowController.all].filter((w) => !w.closing);
  }

  /** Al salir de Callisto (1.5): lo elegido en "Al cerrar Callisto, borrar", en cada perfil abierto. */
  async clearOnExitAll(): Promise<void> {
    const pending = [...this.runtimes.values()].map((rt) => rt.ctx.profile).filter((p) => hasClearOnExit(p.settings));
    await Promise.allSettled(pending.map((p) => clearOnExit(p)));
  }

  needsClearOnExit(): boolean {
    return [...this.runtimes.values()].some((rt) => hasClearOnExit(rt.ctx.profile.settings));
  }

  /** Al salir de Callisto: cada perfil guarda sus ventanas. */
  finalSaveAll(): void {
    this.updateLastActive();
    this.quitting = true;
    for (const rt of this.runtimes.values()) rt.saver.finalSave();
  }

  // ---------------------------------------------------------------- administrar perfiles

  list(): ProfileInfo[] {
    return [...this.registry.profiles];
  }

  windowProfile(ctx: WindowContext): WindowProfile {
    const p = ctx.profile;
    return { id: (p.parent ?? p).id, name: p.name, color: p.color, private: p.isPrivate, several: this.registry.profiles.length > 1 };
  }

  /** Cantidad de ventanas abiertas de un perfil (sin contar las privadas). */
  windowCount(id: string): number {
    const rt = this.runtimes.get(id);
    return rt ? this.windowsOf(rt.ctx.profile).length : 0;
  }

  create(name: unknown, color: unknown): ProfileInfo {
    const info = this.registry.create(name, color);
    this.openProfile(info.id);
    BrowserWindowController.refreshAll();
    return info;
  }

  update(id: string, patch: { name?: unknown; color?: unknown }): ProfileInfo {
    const info = this.registry.update(id, patch);
    const rt = this.runtimes.get(id);
    const priv = this.privates.get(id);
    for (const p of [rt?.ctx.profile, priv?.ctx.profile]) {
      if (!p) continue;
      p.name = info.name;
      p.color = info.color as ProfileColor;
    }
    BrowserWindowController.refreshAll();
    return info;
  }

  /**
   * Elimina un perfil: cierra sus ventanas (también las privadas), borra sus cookies y datos de sitios de inmediato, y
   * sus archivos en el próximo arranque. Si no quedan otras ventanas, antes abre otro perfil (Callisto no se cierra).
   */
  async remove(id: string): Promise<void> {
    if (this.registry.profiles.length <= 1) throw new Error('Tiene que quedar al menos un perfil.');
    const rt = this.runtimes.get(id);
    const priv = this.privates.get(id);
    const doomed = this.openWindows().filter((w) => w.ctx === rt?.ctx || w.ctx === priv?.ctx);
    rt?.saver.disable();
    this.registry.remove(id);
    if (this.openWindows().length === doomed.length) this.openProfile(this.registry.lastUsed);
    for (const w of doomed) w.forceClose();
    if (rt) {
      this.runtimes.delete(id);
      await Promise.allSettled([rt.ctx.profile.session.clearStorageData(), rt.ctx.profile.session.clearCache()]);
    }
    BrowserWindowController.refreshAll();
  }
}

/** ¿Un atajo de extensión ("Ctrl+Shift+Y") ya lo usa Callisto? Entonces la extensión no lo recibe, como en Chrome. */
function isBrowserShortcut(shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  const named: Record<string, [string, string]> = {
    Comma: [',', 'Comma'],
    Period: ['.', 'Period'],
    Home: ['Home', 'Home'],
    End: ['End', 'End'],
    PageUp: ['PageUp', 'PageUp'],
    PageDown: ['PageDown', 'PageDown'],
    Space: [' ', 'Space'],
    Insert: ['Insert', 'Insert'],
    Delete: ['Delete', 'Delete'],
    Up: ['ArrowUp', 'ArrowUp'],
    Down: ['ArrowDown', 'ArrowDown'],
    Left: ['ArrowLeft', 'ArrowLeft'],
    Right: ['ArrowRight', 'ArrowRight'],
  };
  const [k, code] = /^[A-Z]$/.test(key) ? [key.toLowerCase(), `Key${key}`] : /^[0-9]$/.test(key) ? [key, `Digit${key}`] : (named[key] ?? [key, key]);
  const input = { type: 'keyDown', key: k, code, control: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: false, isAutoRepeat: false } as unknown as Electron.Input;
  return matchShortcut(input, { fromPage: true, isLoading: false }) !== null || matchShortcut(input, { fromPage: false, isLoading: false }) !== null;
}
