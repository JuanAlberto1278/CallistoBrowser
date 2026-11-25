// Scripts de usuario (chrome.userScripts, 1.4.4): lo que necesitan Tampermonkey y Violentmonkey.
//
// - La extensión registra scripts (se guardan por perfil, como en Chrome) y Callisto los inyecta desde el preload de las
//   páginas (src/preload/web-content.ts), que corre en todos los frames antes que la página: así funciona
//   "document_start". Cada extensión tiene sus mundos aislados (USER_SCRIPT, configurables con configureWorld) o corre en
//   el de la página (MAIN).
// - Solo con "Permitir scripts de usuario" activado en callisto://extensions para esa extensión (como Chrome 138+;
//   decisión del usuario): apagado al instalar.
// - Desde un mundo USER_SCRIPT con mensajería, runtime.sendMessage / connect llegan a runtime.onUserScriptMessage /
//   onUserScriptConnect de la extensión.
import { ipcMain, webContents as allWebContents, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents, type WebFrameMain } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ExtensionManager } from './manager';
import { matchesPattern, scriptMatches, validateUserScript, type RegisteredUserScript, type UserScriptSource, type WorldConfig } from './user-scripts-core';
import { Tab } from '../tab';
import { US_IPC, type UserScriptPlan } from '../../shared/user-scripts-ipc';

const NOT_ALLOWED = 'The userScripts API is only available for users who have enabled "Permitir scripts de usuario" for this extension in callisto://extensions.';

/** Un perfil por sesión: el canal del preload es uno solo para todos. */
const bySession = new Map<Session, UserScripts>();
let ipcReady = false;

function registerGlobalIpc(): void {
  if (ipcReady) return;
  ipcReady = true;
  // Síncrono: el preload lo pide antes de que corra la página. Siempre responde (si no, el frame quedaría trabado).
  ipcMain.on(US_IPC.plan, (e) => {
    try {
      e.returnValue = bySession.get(e.sender.session)?.planFor(e) ?? [];
    } catch {
      e.returnValue = [];
    }
  });
  const of = (e: IpcMainEvent | IpcMainInvokeEvent) => bySession.get(e.sender.session);
  ipcMain.handle(US_IPC.message, (e, extensionId: unknown, message: unknown) => {
    const us = of(e);
    if (!us) throw new Error('Could not establish connection. Receiving end does not exist.');
    return us.messageFromScript(e, extensionId, message);
  });
  ipcMain.on(US_IPC.connect, (e, extensionId: unknown, portId: unknown, name: unknown) => of(e)?.connectFromScript(e, extensionId, portId, name));
  ipcMain.on(US_IPC.portPost, (e, portId: unknown, message: unknown) => of(e)?.portFromScript(portId, 'message', message));
  ipcMain.on(US_IPC.portClose, (e, portId: unknown) => of(e)?.portFromScript(portId, 'disconnect'));
  ipcMain.on(US_IPC.executed, (e, requestId: unknown, results: unknown) => of(e)?.executed(requestId, results));
  ipcMain.on(US_IPC.tabResponse, (e, requestId: unknown, response: unknown, none: unknown) => of(e)?.tabResponse(requestId, response, none === true));
  // ¿Permitido? (síncrono, desde las páginas de la extensión; los service workers tienen el suyo, ver el constructor)
  ipcMain.on(ALLOWED, (e, extensionId: unknown) => {
    const origin = e.senderFrame?.origin ?? '';
    e.returnValue = typeof extensionId === 'string' && origin === `chrome-extension://${extensionId}` && (bySession.get(e.sender.session)?.isAllowed(extensionId) ?? false);
  });
}

const ALLOWED = 'callisto-us:allowed';

type Router = ExtensionManager['router'] & {
  sendEvent(id: string, name: string, ...args: unknown[]): void;
  listeners: Map<string, Array<{ extensionId: string }>>;
};

export class UserScripts {
  private readonly allowed: Set<string>;
  private readonly scripts: Map<string, RegisteredUserScript[]>;
  private readonly worlds: Map<string, Record<string, WorldConfig>>;
  private readonly worldNumbers = new Map<string, number>();
  private nextWorld = 5000;
  private seq = 0;
  private readonly pendingMessages = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; expected: number; none: number; timer: NodeJS.Timeout }>();
  /** Puertos abiertos por scripts: a qué frame van los mensajes de la extensión. */
  private readonly ports = new Map<string, { extensionId: string; frame: WebFrameMain }>();
  private readonly executions = new Map<number, { resolve(v: unknown): void; results: unknown[]; waiting: number; timer: NodeJS.Timeout }>();
  /** Frames donde execute() inyectó un script con mensajería. */
  private readonly executedFrames = new Set<string>();
  /** Frames con scripts de cada extensión en un mundo con mensajería (para su tabs.sendMessage). */
  private readonly messagingFrames = new Map<string, Map<string, { wcId: number; frameId: number; frame: WebFrameMain }>>();
  private readonly tabMessages = new Map<number, { resolve(v: { delivered: boolean; response?: unknown }): void; expected: number; none: number; timer: NodeJS.Timeout }>();

  constructor(private readonly manager: ExtensionManager) {
    const kv = manager.profile.kv;
    this.allowed = new Set(kv.get<string[]>('userScripts.allowed') ?? []);
    this.scripts = new Map(Object.entries(kv.get<Record<string, RegisteredUserScript[]>>('userScripts.scripts') ?? {}));
    this.worlds = new Map(Object.entries(kv.get<Record<string, Record<string, WorldConfig>>>('userScripts.worlds') ?? {}));
    bySession.set(manager.profile.session, this);
    registerGlobalIpc();
    // Los service workers de las extensiones preguntan por su propio canal (se registra al arrancar, antes de su preload)
    const workers = manager.profile.session.serviceWorkers;
    const watched = new WeakSet<object>();
    workers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus !== 'starting') return;
      const worker = workers.getWorkerFromVersionID(versionId);
      const m = worker ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(worker.scope) : null;
      if (!worker || !m || watched.has(worker)) return;
      watched.add(worker);
      const id = m[1]!;
      worker.ipc.on(ALLOWED, (e, extensionId: unknown) => {
        e.returnValue = extensionId === id && this.allowed.has(id);
      });
    });
    this.registerApi();
    // Al quitar una extensión se olvidan sus scripts, sus mundos y el permiso
    manager.on('changed', () => {
      const installed = new Set(manager.registry.all().map((r) => r.id));
      let dirty = false;
      for (const map of [this.scripts, this.worlds]) for (const id of [...map.keys()]) if (!installed.has(id)) dirty = map.delete(id) || dirty;
      for (const id of [...this.allowed]) if (!installed.has(id)) dirty = this.allowed.delete(id) || dirty;
      if (dirty) this.save();
    });
  }

  private get router(): Router {
    return this.manager.router as Router;
  }

  private save(): void {
    const kv = this.manager.profile.kv;
    kv.set('userScripts.allowed', [...this.allowed]);
    kv.set('userScripts.scripts', Object.fromEntries(this.scripts));
    kv.set('userScripts.worlds', Object.fromEntries(this.worlds));
  }

  isAllowed(extensionId: string): boolean {
    return this.allowed.has(extensionId);
  }

  /** "Permitir scripts de usuario" (callisto://extensions). La extensión se vuelve a cargar, como en Chrome. */
  async setAllowed(extensionId: string, on: boolean): Promise<void> {
    if (on === this.allowed.has(extensionId)) return;
    if (on) this.allowed.add(extensionId);
    else this.allowed.delete(extensionId);
    this.save();
    await this.manager.reload(extensionId);
  }

  // ------------------------------------------------------------ mundos

  private worldKey(worldId: string | undefined): string {
    return worldId ?? '';
  }

  private worldNumber(extensionId: string, worldId: string | undefined): number {
    const key = `${extensionId}|${this.worldKey(worldId)}`;
    let n = this.worldNumbers.get(key);
    if (n === undefined) this.worldNumbers.set(key, (n = this.nextWorld++));
    return n;
  }

  private worldConfig(extensionId: string, worldId: string | undefined): WorldConfig {
    const worlds = this.worlds.get(extensionId) ?? {};
    // Un mundo sin configuración propia usa la del mundo predeterminado (como en Chrome)
    return worlds[this.worldKey(worldId)] ?? worlds[''] ?? {};
  }

  // ------------------------------------------------------------ código de los scripts

  private code(extension: Electron.Extension, sources: UserScriptSource[]): string {
    const root = resolve(extension.path);
    return sources
      .map((s) => {
        if (s.code !== undefined) return s.code;
        const file = resolve(root, s.file!);
        if (!file.startsWith(root + sep)) return '';
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n;\n');
  }

  /** ¿La extensión tiene acceso a esa dirección? (host_permissions o permisos opcionales concedidos) */
  private hasHostAccess(extensionId: string, url: string): boolean {
    const permissions = (this.manager.chrome as unknown as { api: { permissions: { permissionMap: Map<string, { origins: string[] }> } } }).api.permissions.permissionMap.get(extensionId);
    return (permissions?.origins ?? []).some((p) => matchesPattern(p, url));
  }

  /** Scripts para un frame que empieza a cargar (lo pide el preload de la página). */
  planFor(e: IpcMainEvent): UserScriptPlan[] {
    const frame = e.senderFrame;
    if (!frame || !Tab.fromWebContents(e.sender)) return [];
    const url = frame.url;
    if (!/^(https?|file|ftp):/i.test(url)) return [];
    const top = frame === e.sender.mainFrame;
    const out: UserScriptPlan[] = [];
    for (const [extensionId, list] of this.scripts) {
      if (!this.allowed.has(extensionId)) continue;
      const extension = this.manager.profile.session.extensions.getExtension(extensionId);
      if (!extension || !this.hasHostAccess(extensionId, url)) continue;
      for (const s of list) {
        if (!scriptMatches(s, url, top)) continue;
        const plan = this.plan(extension, s.js, s.world ?? 'USER_SCRIPT', s.worldId, s.runAt ?? 'document_idle');
        if (plan.messaging) this.rememberFrame(extensionId, e.sender.id, top ? 0 : frame.frameTreeNodeId, frame);
        out.push(plan);
      }
    }
    return out;
  }

  private plan(extension: Electron.Extension, js: UserScriptSource[], world: 'MAIN' | 'USER_SCRIPT', worldId: string | undefined, runAt: UserScriptPlan['runAt']): UserScriptPlan {
    const config = this.worldConfig(extension.id, worldId);
    const main = world === 'MAIN';
    return {
      extensionId: extension.id,
      world: main ? 0 : this.worldNumber(extension.id, worldId),
      csp: main ? null : (config.csp ?? null),
      messaging: !main && config.messaging === true,
      runAt,
      code: this.code(extension, js),
      name: extension.name,
    };
  }

  // ------------------------------------------------------------ API para la extensión

  private registerApi(): void {
    const handle = (name: string, fn: (extension: Electron.Extension, ...args: unknown[]) => unknown, opts: { permission?: string } = { permission: 'userScripts' }) =>
      this.router.handle(name, ({ extension }, ...args) => fn(extension!, ...args), opts);
    const guard = (extension: Electron.Extension) => {
      if (!this.allowed.has(extension.id)) throw new Error(NOT_ALLOWED);
    };
    const idsOf = (filter: unknown) => {
      const ids = (filter as { ids?: unknown } | undefined)?.ids;
      return Array.isArray(ids) ? new Set(ids.filter((i): i is string => typeof i === 'string')) : null;
    };

    handle('userScripts.isAllowed', (extension) => this.allowed.has(extension.id));
    handle('userScripts.register', (extension, scripts) => {
      guard(extension);
      const list = (Array.isArray(scripts) ? scripts : []).map((s) => validateUserScript(s) as RegisteredUserScript);
      const existing = this.scripts.get(extension.id) ?? [];
      const ids = new Set(existing.map((s) => s.id));
      for (const s of list) {
        if (ids.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        ids.add(s.id);
      }
      this.scripts.set(extension.id, [...existing, ...list]);
      this.save();
    });
    handle('userScripts.update', (extension, scripts) => {
      guard(extension);
      const list = (Array.isArray(scripts) ? scripts : []).map((s) => validateUserScript(s, true));
      const existing = [...(this.scripts.get(extension.id) ?? [])];
      for (const patch of list) {
        const i = existing.findIndex((s) => s.id === patch.id);
        if (i < 0) throw new Error(`Script with ID '${patch.id}' does not exist.`);
        existing[i] = { ...existing[i]!, ...patch };
      }
      this.scripts.set(extension.id, existing);
      this.save();
    });
    handle('userScripts.unregister', (extension, filter) => {
      guard(extension);
      const ids = idsOf(filter);
      const existing = this.scripts.get(extension.id) ?? [];
      if (ids) for (const id of ids) if (!existing.some((s) => s.id === id)) throw new Error(`Nonexistent script ID '${id}'`);
      this.scripts.set(extension.id, ids ? existing.filter((s) => !ids.has(s.id)) : []);
      this.save();
    });
    handle('userScripts.getScripts', (extension, filter) => {
      guard(extension);
      const ids = idsOf(filter);
      return (this.scripts.get(extension.id) ?? []).filter((s) => !ids || ids.has(s.id));
    });
    handle('userScripts.configureWorld', (extension, props) => {
      guard(extension);
      const p = (props ?? {}) as { csp?: unknown; messaging?: unknown; worldId?: unknown };
      if (p.worldId !== undefined && (typeof p.worldId !== 'string' || p.worldId.startsWith('_') || p.worldId.length > 256)) throw new Error('Invalid worldId.');
      const config: WorldConfig = {};
      if (typeof p.csp === 'string') config.csp = p.csp.slice(0, 10_000);
      if (typeof p.messaging === 'boolean') config.messaging = p.messaging;
      const worlds = { ...(this.worlds.get(extension.id) ?? {}) };
      worlds[this.worldKey(p.worldId as string | undefined)] = config;
      this.worlds.set(extension.id, worlds);
      this.save();
    });
    handle('userScripts.getWorldConfigurations', (extension) => {
      guard(extension);
      return Object.entries(this.worlds.get(extension.id) ?? {}).map(([key, c]) => ({ ...(key ? { worldId: key } : {}), ...c, messaging: c.messaging === true }));
    });
    handle('userScripts.resetWorldConfiguration', (extension, worldId) => {
      guard(extension);
      const worlds = { ...(this.worlds.get(extension.id) ?? {}) };
      delete worlds[this.worldKey(typeof worldId === 'string' ? worldId : undefined)];
      this.worlds.set(extension.id, worlds);
      this.save();
    });
    handle('userScripts.execute', (extension, injection) => {
      guard(extension);
      return this.execute(extension, injection);
    });
    // Respuestas de la extensión a los scripts
    handle('runtime.userScriptResponse', (_extension, requestId, response, none) => this.respond(requestId, response, none === true), {});
    handle('runtime.userScriptPortPost', (extension, portId, message) => this.portToScript(extension.id, portId, 'message', message), {});
    // tabs.sendMessage a los scripts (runtime.onMessage en su mundo); si no hay ninguno, la extensión usa el de Chromium
    handle('tabs.sendMessageToUserScripts', (extension, tabId, message, options) => this.tabMessage(extension.id, tabId, message, options), {});
    handle('runtime.userScriptPortClose', (extension, portId) => this.portToScript(extension.id, portId, 'disconnect'), {});
  }

  // ------------------------------------------------------------ execute(): inyectar ya en una pestaña

  private execute(extension: Electron.Extension, injection: unknown): Promise<unknown> {
    const inj = (injection ?? {}) as { target?: { tabId?: unknown; frameIds?: unknown; allFrames?: unknown }; js?: unknown; world?: unknown; worldId?: unknown };
    const wc = typeof inj.target?.tabId === 'number' ? allWebContents.fromId(inj.target.tabId) : undefined;
    if (!wc || !Tab.fromWebContents(wc)) throw new Error(`No tab with id: ${String(inj.target?.tabId)}.`);
    const checked = validateUserScript({ id: 'x', matches: ['<all_urls>'], js: inj.js, world: inj.world, worldId: inj.worldId });
    const frameIds = Array.isArray(inj.target?.frameIds) ? (inj.target!.frameIds as unknown[]).filter((n): n is number => typeof n === 'number') : null;
    const frames = wc.mainFrame.framesInSubtree.filter((f) => {
      const id = f === wc.mainFrame ? 0 : f.frameTreeNodeId;
      if (frameIds) return frameIds.includes(id);
      return inj.target?.allFrames === true || f === wc.mainFrame;
    });
    const targets = frames.filter((f) => this.hasHostAccess(extension.id, f.url));
    if (!targets.length) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
    const plan = this.plan(extension, checked.js!, checked.world ?? 'USER_SCRIPT', checked.worldId, 'document_start');
    const requestId = ++this.seq;
    return new Promise((resolve) => {
      const results: unknown[] = [];
      const timer = setTimeout(() => {
        this.executions.delete(requestId);
        resolve(results);
      }, 10_000);
      this.executions.set(requestId, { resolve, results, waiting: targets.length, timer });
      for (const f of targets) {
        if (plan.messaging) this.executedFrames.add(`${wc.id}:${f.frameTreeNodeId}`);
        f.send(US_IPC.execute, requestId, f === wc.mainFrame ? 0 : f.frameTreeNodeId, plan);
      }
    });
  }

  executed(requestId: unknown, result: unknown): void {
    const ex = typeof requestId === 'number' ? this.executions.get(requestId) : undefined;
    if (!ex) return;
    ex.results.push(result);
    if (--ex.waiting > 0) return;
    clearTimeout(ex.timer);
    this.executions.delete(requestId as number);
    ex.resolve(ex.results);
  }

  private rememberFrame(extensionId: string, wcId: number, frameId: number, frame: WebFrameMain): void {
    const frames = this.messagingFrames.get(extensionId) ?? new Map<string, { wcId: number; frameId: number; frame: WebFrameMain }>();
    frames.set(`${wcId}:${frameId}`, { wcId, frameId, frame });
    this.messagingFrames.set(extensionId, frames);
  }

  private tabMessage(extensionId: string, tabId: unknown, message: unknown, options: unknown): Promise<{ delivered: boolean; response?: unknown }> {
    const frameId = (options as { frameId?: unknown } | undefined)?.frameId;
    const frames = [...(this.messagingFrames.get(extensionId)?.values() ?? [])].filter((f) => {
      if (f.wcId !== tabId || (typeof frameId === 'number' && f.frameId !== frameId)) return false;
      try {
        return !f.frame.detached && !f.frame.isDestroyed();
      } catch {
        return false;
      }
    });
    if (!frames.length) return Promise.resolve({ delivered: false });
    const requestId = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.tabMessages.delete(requestId);
        resolve({ delivered: true, response: undefined });
      }, 5 * 60_000);
      this.tabMessages.set(requestId, { resolve, expected: frames.length, none: 0, timer });
      for (const f of frames) {
        try {
          f.frame.send(US_IPC.tabMessage, requestId, extensionId, message, { id: extensionId, origin: `chrome-extension://${extensionId}` });
        } catch {
          this.tabResponse(requestId, undefined, true);
        }
      }
    });
  }

  tabResponse(requestId: unknown, response: unknown, none: boolean): void {
    const p = typeof requestId === 'number' ? this.tabMessages.get(requestId) : undefined;
    if (!p) return;
    if (none && ++p.none < p.expected) return;
    clearTimeout(p.timer);
    this.tabMessages.delete(requestId as number);
    p.resolve({ delivered: true, response: none ? undefined : response });
  }

  // ------------------------------------------------------------ mensajes y puertos desde los scripts

  /** ¿Este frame puede mandarle mensajes a la extensión? (tiene un script suyo en un mundo con mensajería) */
  private canMessage(e: IpcMainEvent | IpcMainInvokeEvent, extensionId: string): boolean {
    const frame = e.senderFrame;
    if (!frame || !this.allowed.has(extensionId)) return false;
    if (this.executedFrames.has(`${e.sender.id}:${frame.frameTreeNodeId}`)) return true;
    const top = frame === e.sender.mainFrame;
    return (this.scripts.get(extensionId) ?? []).some((s) => (s.world ?? 'USER_SCRIPT') === 'USER_SCRIPT' && this.worldConfig(extensionId, s.worldId).messaging === true && scriptMatches(s, frame.url, top));
  }

  private sender(e: IpcMainEvent | IpcMainInvokeEvent, extensionId: string): Record<string, unknown> {
    const frame = e.senderFrame!;
    const tab = (this.manager.chrome as unknown as { api: { tabs: { createTabDetails(wc: WebContents): unknown } } }).api.tabs.createTabDetails(e.sender);
    return { id: extensionId, url: frame.url, origin: frame.origin, frameId: frame === e.sender.mainFrame ? 0 : frame.frameTreeNodeId, tab };
  }

  private listenerCount(extensionId: string, event: string): number {
    return (this.router.listeners.get(event) ?? []).filter((l) => l.extensionId === extensionId).length;
  }

  messageFromScript(e: IpcMainInvokeEvent, extensionId: unknown, message: unknown): Promise<unknown> {
    if (typeof extensionId !== 'string' || !this.canMessage(e, extensionId)) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const expected = this.listenerCount(extensionId, 'runtime.onUserScriptMessage');
    if (!expected) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const requestId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(requestId);
        resolve(undefined);
      }, 5 * 60_000);
      this.pendingMessages.set(requestId, { resolve, reject, expected, none: 0, timer });
      this.router.sendEvent(extensionId, 'runtime.onUserScriptMessage', message, this.sender(e, extensionId), requestId);
    });
  }

  private respond(requestId: unknown, response: unknown, none: boolean): void {
    const p = typeof requestId === 'number' ? this.pendingMessages.get(requestId) : undefined;
    if (!p) return;
    // "Sin respuesta" de un contexto: se espera a los demás que escuchan (Chrome responde undefined si nadie responde)
    if (none && ++p.none < p.expected) return;
    clearTimeout(p.timer);
    this.pendingMessages.delete(requestId as number);
    p.resolve(none ? undefined : response);
  }

  connectFromScript(e: IpcMainEvent, extensionId: unknown, portId: unknown, name: unknown): void {
    if (typeof extensionId !== 'string' || typeof portId !== 'string' || !e.senderFrame) return;
    if (!this.canMessage(e, extensionId) || !this.listenerCount(extensionId, 'runtime.onUserScriptConnect')) {
      e.senderFrame.send(US_IPC.port, portId, 'disconnect', 'Could not establish connection. Receiving end does not exist.');
      return;
    }
    this.ports.set(portId, { extensionId, frame: e.senderFrame });
    this.router.sendEvent(extensionId, 'runtime.onUserScriptConnect', portId, typeof name === 'string' ? name : '', this.sender(e, extensionId));
  }

  portFromScript(portId: unknown, kind: 'message' | 'disconnect', message?: unknown): void {
    const port = typeof portId === 'string' ? this.ports.get(portId) : undefined;
    if (!port) return;
    if (kind === 'disconnect') this.ports.delete(portId as string);
    this.router.sendEvent(port.extensionId, 'runtime.userScriptPortEvent', portId, kind, message);
  }

  private portToScript(extensionId: string, portId: unknown, kind: 'message' | 'disconnect', message?: unknown): void {
    const port = typeof portId === 'string' ? this.ports.get(portId) : undefined;
    if (!port || port.extensionId !== extensionId) return;
    if (kind === 'disconnect') this.ports.delete(portId as string);
    try {
      port.frame.send(US_IPC.port, portId, kind, message);
    } catch {
      this.ports.delete(portId as string);
    }
  }
}
