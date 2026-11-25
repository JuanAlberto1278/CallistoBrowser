import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, ipcMain, nativeImage, webContents as allWebContents, type BaseWindow, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { installChromeWebStore } from 'electron-chrome-web-store';
import { compareVersions, downloadCrx, ExtensionRegistry, InstallError, parseUpdateCheck, unpackCrx, updateCheckUrl, type ExtensionRecord, type Fetcher } from './installer';
import { CrxError } from './crx';
import type { BrowserApis } from './browser-apis';
import type { UserScripts } from './user-scripts';
import { ZipError } from './unzip';
import type { Profile } from '../profile';
import { invisibleForTests } from '../test-mode';
import { WEBSTORE_ORIGIN, isExtensionId, localizedText, permissionWarnings, unsupportedPermissions, type ExtensionInfo, type ExtensionInstallPrompt, type ExtensionManifest } from '../../shared/extensions';

// Extensiones de un perfil (V0.10). Ver docs/10-v0.10-extensiones.md.
//
// - electron-chrome-extensions da las APIs chrome.* (pestañas, ventanas, botones y popups, menús…) sobre las pestañas y
//   ventanas de Callisto (ver `ExtensionHost`).
// - electron-chrome-web-store hace funcionar el botón "Agregar a Chrome" de la Chrome Web Store. Pero la instalación la
//   hace Callisto: descarga, verifica las firmas del CRX (desarrollador y Chrome Web Store), extrae con su extractor y
//   la registra. Cuando la librería llega a su propio instalador, la extensión ya está cargada y no extrae nada.
// - Lo instalado se guarda en <perfil>/Extensions/<id>/<versión>_<al azar> y en la tabla `extensions`.
// - Sin extensiones en las ventanas privadas (Electron no las permite en sesiones en memoria; Chrome las desactiva).

/** Lo que el administrador necesita de las ventanas de Callisto (lo implementa profiles.ts). */
export interface ExtensionHost {
  createTab(profile: Profile, details: { url?: string; active?: boolean; windowId?: number; index?: number }): Promise<[WebContents, BaseWindow]>;
  selectTab(tab: WebContents): void;
  removeTab(tab: WebContents): void;
  createWindow(profile: Profile, details: { url?: string | string[]; focused?: boolean }): Promise<BaseWindow>;
  removeWindow(win: BaseWindow): void;
  /** Pregunta en la ventana de `source` (o en la del perfil) si se instala; resuelve con la respuesta. */
  confirmInstall(profile: Profile, source: WebContents | null, prompt: Omit<ExtensionInstallPrompt, 'id'>): Promise<boolean>;
  /** Ventana para los cuadros de diálogo del sistema (quitar, permisos). */
  parentWindow(profile: Profile, source: WebContents | null): BaseWindow | null;
  /** Aviso en la pestaña de `source` (p. ej. un error al instalar). */
  notify(source: WebContents | null, text: string): void;
  /** Detalles extra de una pestaña para las extensiones (grupo). */
  assignTabDetails?(details: chrome.tabs.Tab, tab: WebContents): void;
}

/**
 * Solo para las pruebas automáticas, y SOLO sin empaquetar: una "tienda" local (CALLISTO_TEST_EXTENSION_STORE =
 * {"base": "http://127.0.0.1:…/crx/", "publisherKeyHash": "…"}) con CRX firmados por una clave de prueba.
 */
function testStore(): { base: string; publisherKeyHash: string } | null {
  if (app.isPackaged || !process.env.CALLISTO_TEST_EXTENSION_STORE) return null;
  try {
    const v = JSON.parse(process.env.CALLISTO_TEST_EXTENSION_STORE) as { base?: unknown; publisherKeyHash?: unknown };
    return typeof v.base === 'string' && typeof v.publisherKeyHash === 'string' ? { base: v.base, publisherKeyHash: v.publisherKeyHash } : null;
  } catch {
    return null;
  }
}

const UPDATE_INTERVAL = 5 * 60 * 60 * 1000;

const managers = new Map<Session, ExtensionManager>();
let uninstallOverridden = false;

/** "Quitar" desde la página de la Chrome Web Store: pasa por Callisto (con confirmación), no por la librería. */
function overrideStoreUninstall(): void {
  if (uninstallOverridden) return;
  uninstallOverridden = true;
  ipcMain.removeHandler('chrome.management.uninstall');
  ipcMain.handle('chrome.management.uninstall', async (event: IpcMainInvokeEvent, id: unknown) => {
    if (!event.senderFrame?.origin.startsWith(WEBSTORE_ORIGIN)) return;
    const m = managers.get(event.sender.session);
    if (!m || !isExtensionId(id)) return 'unknown_error';
    const removed = await m.removeWithConfirmation(id, event.sender);
    if (removed) queueMicrotask(() => event.sender.send('chrome.management.onUninstalled', id));
    return removed ? '' : 'user_cancelled';
  });
}

export class ExtensionManager extends EventEmitter<{
  changed: [];
  'groups-maybe-changed': [];
  /** Se instaló (previousVersion null) o se actualizó una extensión: para chrome.runtime.onInstalled. */
  installed: [id: string, previousVersion: string | null];
  /** Extensiones cargadas al abrir el perfil: para chrome.runtime.onStartup. */
  started: [ids: string[]];
}> {
  static fromSession(session: Session): ExtensionManager | undefined {
    return managers.get(session);
  }

  readonly chrome: ElectronChromeExtensions;
  /** APIs que Callisto agrega en la 1.4.2 (atajos, palabra clave en la barra, menú del botón): ver browser-apis.ts. */
  browser: BrowserApis | null = null;
  /** Scripts de usuario (1.4.4): ver user-scripts.ts. */
  userScripts: UserScripts | null = null;
  readonly registry: ExtensionRegistry;
  private readonly errors = new Map<string, string>();
  private readonly installing = new Set<string>();
  private readonly fetcher: Fetcher;
  private readonly store = testStore();
  private updateTimer: NodeJS.Timeout | null = null;
  /** Callisto le está avisando a la librería un cambio de pestañas (no es un pedido de una extensión). */
  private syncing = false;
  readonly ready: Promise<void>;

  constructor(readonly profile: Profile, readonly dir: string, private readonly host: ExtensionHost, opts: { apiPreload: string }) {
    super();
    const ses = profile.session;
    managers.set(ses, this);
    this.registry = new ExtensionRegistry(profile.db);
    this.fetcher = (url) => ses.fetch(url, { cache: 'no-store' });
    // `browser` = `chrome` y las APIs que agrega Callisto (bookmarks, tabGroups), en páginas y service workers de
    // extensiones. ANTES que el preload de la librería: al final hace Object.freeze(chrome) y ya no se podría agregar nada.
    ses.registerPreloadScript({ id: 'callisto-extension-apis-sw', type: 'service-worker', filePath: opts.apiPreload });
    ses.registerPreloadScript({ id: 'callisto-extension-apis-frame', type: 'frame', filePath: opts.apiPreload });
    this.chrome = new ElectronChromeExtensions({
      session: ses,
      createTab: (d) => host.createTab(profile, d),
      // Solo cuando lo pide una extensión (chrome.tabs.update/remove). La librería también los llama cuando Callisto le
      // avisa que agregó, activó o sacó una pestaña: ahí no hay que hacer nada (cerraría pestañas que se mueven de ventana).
      selectTab: (tab) => {
        if (!this.syncing) host.selectTab(tab);
      },
      removeTab: (tab) => {
        if (!this.syncing) host.removeTab(tab);
      },
      createWindow: (d) => host.createWindow(profile, d),
      removeWindow: (w) => host.removeWindow(w),
      requestPermissions: (ext, perms) => this.requestPermissions(ext, perms),
      assignTabDetails: (details, tab) => host.assignTabDetails?.(details, tab),
    });
    const webStore = installChromeWebStore({
      session: ses,
      extensionsPath: dir,
      loadExtensions: false,
      autoUpdate: false,
      minimumManifestVersion: 3,
      beforeInstall: (details) => this.beforeInstall(details),
    });
    overrideStoreUninstall();
    // Pruebas automáticas: los popups de las extensiones también son invisibles y no roban el foco
    if (invisibleForTests) {
      this.chrome.on('browser-action-popup-created', (popup: { browserWindow?: Electron.BrowserWindow }) => {
        const w = popup.browserWindow;
        if (!w) return;
        w.setOpacity(0);
        w.setIgnoreMouseEvents(true);
        w.setSkipTaskbar(true);
        w.setFocusable(false);
      });
    }
    if (this.store) this.exposeTestInstall();
    ses.extensions.on('extension-loaded', () => this.emit('changed'));
    ses.extensions.on('extension-unloaded', () => this.emit('changed'));
    this.ready = webStore.then(() => this.loadAll());
  }

  private sync(fn: () => void): void {
    this.syncing = true;
    try {
      fn();
    } finally {
      this.syncing = false;
    }
  }

  /** Una pestaña web del perfil entró en una ventana (las extensiones la ven en chrome.tabs). */
  tabAdded(tab: WebContents, win: BaseWindow): void {
    this.sync(() => this.chrome.addTab(tab, win));
  }

  /** La pestaña salió de la ventana (se cerró o se movió a otra). */
  tabRemoved(tab: WebContents): void {
    if (!tab.isDestroyed()) this.sync(() => this.chrome.removeTab(tab));
  }

  tabSelected(tab: WebContents): void {
    this.sync(() => this.chrome.selectTab(tab));
  }

  /** Router de mensajes de la librería (para registrar APIs propias: ver extension-apis.ts). Interno de la 4.10.0. */
  get router(): { handle(name: string, cb: (event: { extension?: Electron.Extension; sender?: WebContents }, ...args: unknown[]) => unknown, opts?: { permission?: string }): void; broadcastEvent(name: string, ...args: unknown[]): void } {
    return (this.chrome as unknown as { ctx: { router: ExtensionManager['router'] } }).ctx.router;
  }

  private path(r: ExtensionRecord): string {
    return join(this.dir, r.id, r.dir);
  }

  private async loadOne(r: ExtensionRecord): Promise<void> {
    const ses = this.profile.session;
    if (ses.extensions.getExtension(r.id)) return;
    try {
      await ses.extensions.loadExtension(this.path(r), { allowFileAccess: false });
      this.errors.delete(r.id);
    } catch (e) {
      this.errors.set(r.id, e instanceof Error ? e.message : String(e));
    }
  }

  private async loadAll(): Promise<void> {
    for (const r of this.registry.all()) if (r.enabled) await this.loadOne(r);
    this.emit('started', this.registry.all().filter((r) => r.enabled && this.profile.session.extensions.getExtension(r.id)).map((r) => r.id));
    this.emit('changed');
    if (!this.store && !process.env.CALLISTO_TEST_INVISIBLE) this.scheduleUpdates();
  }

  private scheduleUpdates(): void {
    const run = () => void this.checkUpdates().catch(() => {});
    setTimeout(run, 60_000).unref();
    this.updateTimer = setInterval(run, UPDATE_INTERVAL);
    this.updateTimer.unref();
  }

  // ------------------------------------------------------------ instalar

  /** Descarga, verifica, extrae, registra y carga. Si ya estaba, la reemplaza por la versión nueva. */
  async install(id: string): Promise<ExtensionRecord> {
    if (!isExtensionId(id)) throw new InstallError('ID de extensión no válido.');
    if (this.installing.has(id)) throw new InstallError('La extensión ya se está instalando.');
    this.installing.add(id);
    try {
      const buf = this.store ? await this.downloadTest(id) : await downloadCrx(this.fetcher, id, process.versions.chrome);
      const unpacked = unpackCrx(buf, id, this.dir, this.store?.publisherKeyHash);
      const name = localizedText(unpacked.manifest.name, this.messages(join(this.dir, id, unpacked.dir), unpacked.manifest)) || id;
      const ses = this.profile.session;
      if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
      const previousVersion = this.registry.get(id)?.version ?? null;
      const previous = this.registry.put(id, name, unpacked.version, unpacked.dir);
      const record = this.registry.get(id)!;
      this.emit('installed', id, previousVersion);
      await this.loadOne(record);
      if (previous) rmSync(join(this.dir, id, previous), { recursive: true, force: true });
      this.emit('changed');
      return record;
    } finally {
      this.installing.delete(id);
    }
  }

  /**
   * Solo con la tienda de prueba (sin empaquetar): `__callistoTestStoreInstall(perfil, id, webContentsId)` recorre el
   * mismo camino que "Agregar a Chrome" en la Chrome Web Store (confirmación incluida), con el manifiesto que sirve la
   * tienda de prueba. Resuelve con lo que la tienda recibiría ('allow' o 'deny').
   */
  private exposeTestInstall(): void {
    const g = globalThis as unknown as { __callistoTestStoreInstall?: (profileId: string, id: string, wcId: number) => Promise<string> };
    const previous = g.__callistoTestStoreInstall;
    g.__callistoTestStoreInstall = async (profileId, id, wcId) => {
      if (profileId !== this.profile.id) return previous ? previous(profileId, id, wcId) : 'deny';
      const res = await this.fetcher(`${this.store!.base}${id}.json`);
      const manifest = (await res.json()) as chrome.runtime.Manifest;
      const wc = allWebContents.fromId(wcId);
      if (!wc) return 'deny';
      const r = await this.beforeInstall({ id, localizedName: String(manifest.name), manifest, icon: nativeImage.createEmpty(), frame: wc.mainFrame });
      return r.action;
    };
  }

  private async downloadTest(id: string): Promise<Buffer> {
    const res = await this.fetcher(`${this.store!.base}${id}.crx`);
    if (!res.ok) throw new InstallError(`La tienda de prueba respondió ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** "Agregar a Chrome" en la Chrome Web Store: pregunta en la ventana de la pestaña y, si se acepta, instala. */
  private async beforeInstall(details: { id: string; localizedName: string; manifest: chrome.runtime.Manifest; icon: Electron.NativeImage; frame: Electron.WebFrameMain }): Promise<{ action: 'allow' | 'deny' }> {
    const id = details.id;
    if (!isExtensionId(id)) return { action: 'deny' };
    const source = allWebContents.fromFrame(details.frame) ?? null;
    const manifest = details.manifest as unknown as ExtensionManifest;
    const existing = this.registry.get(id);
    const ok = await this.host.confirmInstall(this.profile, source, {
      extensionId: id,
      name: String(details.localizedName || manifest.name || id).slice(0, 200),
      icon: details.icon.isEmpty() ? null : details.icon.resize({ width: 48 }).toDataURL(),
      warnings: permissionWarnings(manifest),
      unsupported: unsupportedPermissions(manifest),
      reenable: !!existing && !existing.enabled,
    });
    if (!ok) return { action: 'deny' };
    try {
      if (existing && !existing.enabled) await this.setEnabled(id, true);
      else await this.install(id);
      if (!this.profile.session.extensions.getExtension(id)) throw new InstallError(this.errors.get(id) ?? 'No se pudo cargar la extensión.');
      return { action: 'allow' };
    } catch (e) {
      this.host.notify(source, `No se pudo agregar «${details.localizedName}»: ${installMessage(e)}`);
      return { action: 'deny' };
    }
  }

  // ------------------------------------------------------------ activar, quitar, actualizar

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const r = this.registry.get(id);
    if (!r) return;
    this.registry.setEnabled(id, enabled);
    const ses = this.profile.session;
    if (enabled) await this.loadOne({ ...r, enabled });
    else if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
    this.emit('changed');
  }

  /** Vuelve a cargar una extensión (p. ej. al permitir o no sus scripts de usuario, como en Chrome). */
  async reload(id: string): Promise<void> {
    const r = this.registry.get(id);
    const ses = this.profile.session;
    if (!r || !r.enabled) return;
    if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
    await this.loadOne(r);
    this.emit('changed');
  }

  remove(id: string): void {
    const ses = this.profile.session;
    if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
    this.registry.remove(id);
    this.errors.delete(id);
    rmSync(join(this.dir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    this.emit('changed');
  }

  /** Quitar con un cuadro de confirmación de Windows (desde el botón de la barra o la Chrome Web Store). */
  async removeWithConfirmation(id: string, source: WebContents | null): Promise<boolean> {
    const r = this.registry.get(id);
    if (!r) return false;
    const parent = this.host.parentWindow(this.profile, source);
    const opts = { type: 'question' as const, buttons: ['Quitar', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Quitar extensión', message: `¿Quitar «${r.name}» de Callisto?`, detail: 'Se borran la extensión y sus datos de este perfil.', noLink: true };
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    if (response !== 0) return false;
    this.remove(id);
    return true;
  }

  /** Busca versiones nuevas en la Chrome Web Store e instala las que haya. Devuelve los IDs actualizados. */
  async checkUpdates(): Promise<string[]> {
    const updated: string[] = [];
    for (const r of this.registry.all()) {
      try {
        let available: string | null = null;
        if (this.store) {
          const res = await this.fetcher(`${this.store.base}${r.id}.version`);
          available = res.ok ? (await res.text()).trim() : null;
        } else {
          const res = await this.fetcher(updateCheckUrl(r.id, r.version, process.versions.chrome));
          available = res.ok ? parseUpdateCheck(await res.text(), r.id) : null;
        }
        if (available && compareVersions(available, r.version) > 0) {
          const wasEnabled = r.enabled;
          await this.install(r.id);
          if (!wasEnabled) await this.setEnabled(r.id, false);
          updated.push(r.id);
        }
      } catch {
        /* sin conexión o paquete inválido: se reintenta en la próxima búsqueda */
      }
    }
    return updated;
  }

  /** Permisos opcionales que pide una extensión en uso (chrome.permissions.request): se le pregunta al usuario. */
  private async requestPermissions(ext: Electron.Extension, perms: chrome.permissions.Permissions): Promise<boolean> {
    const asked = permissionWarnings({ permissions: perms.permissions ?? [], host_permissions: perms.origins ?? [] });
    const parent = this.host.parentWindow(this.profile, null);
    const opts = {
      type: 'question' as const,
      buttons: ['Permitir', 'Denegar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permiso de una extensión',
      message: `«${ext.name}» pide permiso para:`,
      detail: asked.length ? asked.map((t) => `• ${t}`).join('\n') : (perms.permissions ?? []).join(', ') || 'funciones adicionales',
      noLink: true,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    return response === 0;
  }

  // ------------------------------------------------------------ información para la interfaz y la página

  private manifestOf(r: ExtensionRecord): ExtensionManifest | null {
    try {
      return JSON.parse(readFileSync(join(this.path(r), 'manifest.json'), 'utf8').replace(/^﻿/, '')) as ExtensionManifest;
    } catch {
      return null;
    }
  }

  /** Mensajes traducidos de la extensión: español si los trae, si no los del idioma por defecto. */
  private messages(path: string, manifest: ExtensionManifest): Record<string, { message?: string }> | null {
    for (const locale of ['es_419', 'es', manifest.default_locale].filter((l): l is string => !!l && /^[\w-]+$/.test(l))) {
      const f = join(path, '_locales', locale, 'messages.json');
      if (!existsSync(f)) continue;
      try {
        return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
      } catch {
        /* siguiente */
      }
    }
    return null;
  }

  private iconOf(path: string, manifest: ExtensionManifest): string | null {
    const icons = manifest.icons ?? {};
    const sizes = Object.keys(icons).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    const size = sizes.find((s) => s >= 32) ?? sizes.at(-1);
    const file = size !== undefined ? icons[String(size)] : undefined;
    if (!file || file.includes('..')) return null;
    const img = nativeImage.createFromPath(join(path, file));
    return img.isEmpty() ? null : img.resize({ width: 32 }).toDataURL();
  }

  list(): ExtensionInfo[] {
    const ses = this.profile.session;
    return this.registry.all().map((r) => {
      const manifest = this.manifestOf(r) ?? {};
      const path = this.path(r);
      const messages = this.messages(path, manifest);
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        description: localizedText(manifest.description, messages).slice(0, 300),
        enabled: r.enabled,
        loaded: !!ses.extensions.getExtension(r.id),
        error: r.enabled ? (this.errors.get(r.id) ?? null) : null,
        icon: this.iconOf(path, manifest),
        warnings: permissionWarnings(manifest),
        unsupported: unsupportedPermissions(manifest),
        userScripts: (manifest.permissions ?? []).includes('userScripts') || (manifest.optional_permissions ?? []).includes('userScripts') ? { allowed: this.userScripts?.isAllowed(r.id) ?? false } : null,
        hasOptions: !!(manifest.options_ui?.page || manifest.options_page),
        storeUrl: `${WEBSTORE_ORIGIN}/detail/${r.id}`,
        installed: r.installed,
        updated: r.updated,
      };
    });
  }

  /** Página de opciones (chrome-extension://…), si la extensión tiene. */
  optionsUrl(id: string): string | null {
    const r = this.registry.get(id);
    const m = r && this.manifestOf(r);
    const page = m?.options_ui?.page || m?.options_page;
    return page && !page.includes('..') ? `chrome-extension://${id}/${page.replace(/^\/+/, '')}` : null;
  }

  dispose(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    managers.delete(this.profile.session);
  }
}

/** Mensaje para el usuario de un error de instalación. */
export function installMessage(e: unknown): string {
  if (e instanceof InstallError || e instanceof CrxError || e instanceof ZipError) return e.message;
  return 'no se pudo descargar de la Chrome Web Store (¿hay conexión?).';
}
