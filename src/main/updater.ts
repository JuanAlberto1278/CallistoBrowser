import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { app, net } from 'electron';
import { UPDATE_REPO, compareSemver, isSemver, parseLatestYml, type UpdateStatus } from '../shared/updates';

// Actualizaciones de Callisto (V1.0) desde GitHub Releases, sin dependencias nuevas.
//
// 1. Consulta la última versión publicada (al arrancar, a los 30 s, y cada 6 horas; o a pedido).
// 2. Si es más nueva, descarga su latest.yml y el instalador, y verifica el SHA-512 del instalador con el del yml.
// 3. Avisa (Configuración > Acerca de). Solo cuando el usuario elige "Reiniciar y actualizar", Callisto se cierra y el
//    instalador corre en silencio y vuelve a abrir Callisto.
//
// Sin firma de código (decisión de la V1.0): la verificación protege de descargas dañadas, y la autenticidad depende de
// GitHub y de HTTPS. Solo en el ejecutable empaquetado (en desarrollo no hay nada que actualizar), salvo la prueba
// automática con CALLISTO_TEST_UPDATE_BASE (un servidor local que imita a GitHub; solo sin empaquetar).

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;

const testBase = !app.isPackaged ? process.env.CALLISTO_TEST_UPDATE_BASE : undefined;

class Updater extends EventEmitter<{ status: [UpdateStatus] }> {
  private statusValue: UpdateStatus = { state: 'idle' };
  private installer: string | null = null;
  private running: Promise<void> | null = null;

  get status(): UpdateStatus {
    return this.statusValue;
  }

  get enabled(): boolean {
    return app.isPackaged || !!testBase;
  }

  private set(s: UpdateStatus): void {
    this.statusValue = s;
    this.emit('status', s);
  }

  private get dir(): string {
    return join(app.getPath('userData'), 'Updates');
  }

  start(): void {
    if (!this.enabled || process.env.CALLISTO_TEST_INVISIBLE === '1') return;
    // Instaladores de una actualización anterior: ya no hacen falta
    try {
      for (const f of readdirSync(this.dir)) rmSync(join(this.dir, f), { force: true });
    } catch {
      /* no hay carpeta */
    }
    setTimeout(() => void this.check(), 30_000).unref();
    setInterval(() => void this.check(), CHECK_EVERY).unref();
  }

  /** Busca (y descarga) una versión nueva. Si ya hay una en curso, espera esa. */
  check(): Promise<void> {
    if (!this.enabled || this.statusValue.state === 'ready') return Promise.resolve();
    this.running ??= this.doCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async fetch(url: string): Promise<Response> {
    const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Callisto/${app.getVersion()}` }, cache: 'no-store' });
    if (!res.ok) throw new Error(`respuesta ${res.status}`);
    return res;
  }

  private async doCheck(): Promise<void> {
    this.set({ state: 'checking' });
    try {
      const base = testBase ?? `https://api.github.com/repos/${UPDATE_REPO}`;
      const release = (await (await this.fetch(`${base}/releases/latest`)).json()) as { tag_name?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown }> };
      const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
      if (!isSemver(version) || compareSemver(version, app.getVersion()) <= 0) {
        this.set({ state: 'up-to-date', checkedAt: Date.now() });
        return;
      }
      const asset = (name: string) => {
        const a = release.assets?.find((x) => x.name === name);
        const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
        if (!/^https:\/\/github\.com\//.test(url) && !(testBase && url.startsWith(testBase))) throw new Error(`falta ${name} en la versión publicada`);
        return url;
      };
      const yml = parseLatestYml(await (await this.fetch(asset('latest.yml'))).text());
      if (!yml || yml.version !== version) throw new Error('el latest.yml de la versión publicada no es válido');
      this.set({ state: 'downloading', version });
      const res = await this.fetch(asset(yml.path));
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_INSTALLER_BYTES) throw new Error('el instalador es demasiado grande');
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_INSTALLER_BYTES) throw new Error('el instalador es demasiado grande');
      if (createHash('sha512').update(data).digest('base64') !== yml.sha512) throw new Error('el instalador descargado no coincide con el publicado (SHA-512)');
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, yml.path);
      writeFileSync(file, data);
      this.installer = file;
      this.set({ state: 'ready', version });
    } catch (e) {
      this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Cierra Callisto e instala (en silencio; el instalador vuelve a abrir Callisto). */
  installAndRestart(): boolean {
    if (this.statusValue.state !== 'ready' || !this.installer) return false;
    if (testBase) {
      // Prueba automática: no se ejecuta nada
      (globalThis as unknown as { __callistoUpdateInstalled?: string }).__callistoUpdateInstalled = this.installer;
      return true;
    }
    spawn(this.installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    return true;
  }
}

export const updater = new Updater();
