// Mensajería con programas instalados (chrome.runtime.connectNative / sendNativeMessage, 1.4.3). Reemplaza la de
// electron-chrome-extensions (que se colgaba si el programa no existía, medía los mensajes en caracteres en vez de bytes
// y no podía arrancar programas .bat ni con rutas relativas) usando el mismo protocolo con su preload:
//   crx-native-msg-<id>             mensajes en los dos sentidos
//   crx-native-msg-<id>-disconnect  el puerto se cerró
// Antes de arrancar un programa por primera vez, Callisto pregunta (decisión del usuario), con "Recordar".
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import type { ExtensionManager } from './manager';
import {
  encodeNativeMessage,
  isValidHostName,
  NativeMessageReader,
  needsShell,
  parseHostManifest,
  parseRegDefault,
  registryKeys,
  type NativeHostConfig,
} from './native-messaging-core';

/** Lo que el navegador le pasa a cada extensión (frame o service worker) en la librería. */
interface Sender {
  send(channel: string, ...args: unknown[]): void;
  ipc: { on(channel: string, fn: (e: unknown, message: unknown) => void): void; off(channel: string, fn: (e: unknown, message: unknown) => void): void };
  isDestroyed?(): boolean;
  once?(event: 'destroyed', fn: () => void): void;
}

export interface NativeMessagingDeps {
  /** Ventana para la pregunta. */
  parentWindow(): Electron.BaseWindow | null;
}

const NOT_FOUND = 'Specified native messaging host not found.';
const FORBIDDEN = 'Access to the specified native messaging host is forbidden.';
const EXITED = 'Native host has exited.';

/**
 * Solo sin empaquetar, para las pruebas: CALLISTO_TEST_NATIVE_HOSTS_DIR (carpeta con <nombre>.json, en vez del registro:
 * las pruebas no tocan el registro de Windows) y CALLISTO_TEST_NATIVE_ANSWER = allow | deny (responde la pregunta).
 */
const testHostsDir = !app.isPackaged ? (process.env.CALLISTO_TEST_NATIVE_HOSTS_DIR ?? null) : null;
const testAnswer = !app.isPackaged && (process.env.CALLISTO_TEST_NATIVE_ANSWER === 'allow' || process.env.CALLISTO_TEST_NATIVE_ANSWER === 'deny') ? process.env.CALLISTO_TEST_NATIVE_ANSWER : null;

function regQuery(key: string, view32: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg', ['query', key, '/ve', ...(view32 ? ['/reg:32'] : [])], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? parseRegDefault(out) : null));
  });
}

/** El manifiesto del programa: en el registro de Windows (como Chrome y Edge) o, en las pruebas, en una carpeta. */
async function findHost(name: string): Promise<NativeHostConfig | null> {
  const candidates: string[] = [];
  if (testHostsDir) candidates.push(join(testHostsDir, `${name}.json`));
  else {
    for (const key of registryKeys(name)) {
      const path = (await regQuery(key, false)) ?? (key.startsWith('HKLM') ? await regQuery(key, true) : null);
      if (path) candidates.push(path);
    }
  }
  for (const file of candidates) {
    try {
      const config = parseHostManifest(JSON.parse(await fs.readFile(file, 'utf8')), file, name);
      if (config && (await fs.stat(config.path)).isFile()) return config;
    } catch {
      /* el siguiente */
    }
  }
  return null;
}

/** Arranca el programa como Chrome: con el origen de la extensión y la ventana padre; los .bat y .cmd, con cmd.exe. */
function launch(config: NativeHostConfig, extensionId: string, hwnd: string): ChildProcess {
  const origin = `chrome-extension://${extensionId}/`;
  const args = [origin, `--parent-window=${hwnd}`];
  if (needsShell(config.path)) {
    const line = `"${config.path}" ${args.join(' ')}`;
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  }
  return spawn(config.path, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

/** Programas abiertos (se cierran al salir de Callisto). */
const running = new Set<ChildProcess>();
app.on('will-quit', () => {
  for (const p of running) p.kill();
});

export function registerNativeMessaging(manager: ExtensionManager, deps: NativeMessagingDeps): void {
  const profile = manager.profile;
  const DECISIONS = 'nativeMessaging.decisions';
  const asking = new Map<string, Promise<boolean>>();

  /** ¿El usuario permite que esta extensión use este programa? Se pregunta la primera vez. */
  const allowed = (extension: Electron.Extension, config: NativeHostConfig): Promise<boolean> => {
    const key = `${extension.id} ${config.name}`;
    const saved = profile.kv.get<Record<string, 'allow' | 'deny'>>(DECISIONS) ?? {};
    if (saved[key]) return Promise.resolve(saved[key] === 'allow');
    const pending = asking.get(key);
    if (pending) return pending;
    const ask = (async () => {
      let allow: boolean;
      let remember = true;
      if (testAnswer) {
        const g = globalThis as unknown as { __callistoNativeAsked?: string[] };
        (g.__callistoNativeAsked ??= []).push(key);
        allow = testAnswer === 'allow';
      } else {
        const opts = {
          type: 'question' as const,
          buttons: ['Permitir', 'No permitir'],
          defaultId: 1,
          cancelId: 1,
          title: 'Callisto',
          message: `¿Permitir que «${extension.name}» se comunique con un programa instalado?`,
          detail: `${config.description || config.name}\n${config.path}\n\nEl programa se abre con los permisos de tu usuario de Windows.`,
          checkboxLabel: 'Recordar mi decisión',
          checkboxChecked: true,
          noLink: true,
        };
        const parent = deps.parentWindow();
        const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        allow = r.response === 0;
        remember = r.checkboxChecked;
      }
      if (remember) profile.kv.set(DECISIONS, { ...(profile.kv.get<Record<string, 'allow' | 'deny'>>(DECISIONS) ?? {}), [key]: allow ? 'allow' : 'deny' });
      return allow;
    })().finally(() => asking.delete(key));
    asking.set(key, ask);
    return ask;
  };

  /** Busca, verifica (orígenes permitidos y decisión del usuario) y arranca el programa. */
  const open = async (extension: Electron.Extension, name: unknown): Promise<{ process: ChildProcess; config: NativeHostConfig }> => {
    if (!isValidHostName(name)) throw new Error('Invalid native messaging host name specified.');
    const config = await findHost(name);
    if (!config) throw new Error(NOT_FOUND);
    if (!config.allowedOrigins.includes(`chrome-extension://${extension.id}/`)) throw new Error(FORBIDDEN);
    if (!(await allowed(extension, config))) throw new Error(FORBIDDEN);
    const win = deps.parentWindow();
    const hwnd = win && !win.isDestroyed() ? win.getNativeWindowHandle().readBigUInt64LE(0).toString() : '0';
    const child = launch(config, extension.id, hwnd);
    running.add(child);
    child.once('exit', () => running.delete(child));
    child.stdin?.on('error', () => {});
    return { process: child, config };
  };

  const router = manager.router;
  const ports = new Map<string, () => void>();

  // Puerto (connectNative): vive hasta que la extensión o el programa lo cierran
  router.handle(
    'runtime.connectNative',
    async ({ extension, sender }, connectionId, name) => {
      const s = sender as unknown as Sender;
      const id = String(connectionId);
      const channel = `crx-native-msg-${id}`;
      let child: ChildProcess | null = null;
      let closed = false;
      /** Por qué se cerró (para runtime.lastError en onDisconnect); null si lo cerró la extensión. */
      let reason: string | null = null;
      /** Lo que la extensión manda mientras el programa arranca (lo suele mandar enseguida de conectar). */
      const pending: unknown[] = [];
      const write = (message: unknown) => {
        try {
          child!.stdin?.write(encodeNativeMessage(message));
        } catch {
          close();
        }
      };
      const fromExtension = (_e: unknown, message: unknown) => {
        if (child) write(message);
        else pending.push(message);
      };
      const alive = () => !(s.isDestroyed?.() ?? false);
      const close = () => {
        if (closed) return;
        closed = true;
        ports.delete(id);
        child?.kill();
        try {
          s.ipc.off(channel, fromExtension);
          if (alive()) s.send(`${channel}-disconnect`, reason);
        } catch {
          /* la página o el service worker de la extensión ya no existe */
        }
      };
      ports.set(id, () => {
        reason = null;
        close();
      });
      s.ipc.on(channel, fromExtension);
      s.once?.('destroyed', close);
      try {
        const opened = await open(extension!, name);
        child = opened.process;
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
        close();
        return;
      }
      if (closed) {
        child.kill();
        return;
      }
      const reader = new NativeMessageReader();
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const message of reader.feed(chunk)) {
          try {
            if (alive()) s.send(channel, message);
          } catch {
            close();
          }
        }
        if (reader.error) {
          reason = reader.error;
          close();
        }
      });
      child.on('exit', () => {
        reason ??= EXITED;
        close();
      });
      child.on('error', () => {
        reason ??= NOT_FOUND;
        close();
      });
      for (const message of pending.splice(0)) write(message);
    },
    { permission: 'nativeMessaging' },
  );
  router.handle('runtime.disconnectNative', (_e, connectionId) => ports.get(String(connectionId))?.(), { permission: 'nativeMessaging' });

  // Un solo mensaje (sendNativeMessage): arranca, manda, espera la primera respuesta y cierra
  router.handle(
    'runtime.sendNativeMessage',
    async ({ extension }, name, message) => {
      const { process: child } = await open(extension!, name);
      return new Promise((resolve, reject) => {
        const reader = new NativeMessageReader();
        let done = false;
        const finish = (err: Error | null, value?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.kill();
          if (err) reject(err);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(EXITED)), 60_000);
        child.stdout?.on('data', (chunk: Buffer) => {
          const [first] = reader.feed(chunk);
          if (first !== undefined) finish(null, first);
          else if (reader.error) finish(new Error(reader.error));
        });
        child.on('exit', () => finish(new Error(EXITED)));
        child.on('error', () => finish(new Error(NOT_FOUND)));
        try {
          child.stdin?.write(encodeNativeMessage(message));
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    { permission: 'nativeMessaging' },
  );
}
