import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectEventually, launchCallisto, typeAddress, type Callisto } from './fixtures';

// Un servidor local que imita la API de GitHub Releases (CALLISTO_TEST_UPDATE_BASE, solo sin empaquetar).
let server: Server;
let base = '';
let release: { version: string; installer: Buffer; ymlSha?: string };
let c: Callisto;
let dir: string;

const current = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const name = `Callisto-Setup-${release.version}.exe`;
    if (req.url === '/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: `v${release.version}`, assets: [{ name: 'latest.yml', browser_download_url: `${base}/dl/latest.yml` }, { name, browser_download_url: `${base}/dl/${name}` }] }));
    }
    if (req.url === '/dl/latest.yml') {
      const sha = release.ymlSha ?? createHash('sha512').update(release.installer).digest('base64');
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      return res.end(`version: ${release.version}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${release.installer.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '2026-12-01T10:00:00.000Z'\n`);
    }
    if (req.url === `/dl/${name}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(release.installer);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callisto-upd-'));
  c = await launchCallisto([], dir, { CALLISTO_TEST_UPDATE_BASE: base });
});
test.afterEach(async () => {
  await c.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function about(): Promise<Page> {
  await typeAddress(c.ui, 'callisto://settings');
  await expectEventually(() => c.app.windows().some((w) => w.url().startsWith('callisto://settings')));
  const p = c.app.windows().find((w) => w.url().startsWith('callisto://settings'))!;
  await p.waitForLoadState('domcontentloaded');
  return p;
}

test('hay una versión nueva: se descarga, se verifica y se instala al confirmar', async () => {
  release = { version: '99.0.0', installer: randomBytes(200_000) };
  const p = await about();
  await p.getByTestId('update-check').click();
  await expect(p.getByTestId('update-status')).toHaveText('La versión 99.0.0 está lista para instalarse.');
  await p.getByTestId('update-install').click();
  await expectEventually(async () => !!(await c.app.evaluate(() => (globalThis as unknown as { __callistoUpdateInstalled?: string }).__callistoUpdateInstalled)));
  const file = await c.app.evaluate(() => (globalThis as unknown as { __callistoUpdateInstalled: string }).__callistoUpdateInstalled);
  expect(file.endsWith('Callisto-Setup-99.0.0.exe')).toBe(true);
  expect(readFileSync(file).equals(release.installer)).toBe(true);
});

test('misma versión: está actualizado', async () => {
  release = { version: current, installer: randomBytes(1000) };
  const p = await about();
  await p.getByTestId('update-check').click();
  await expect(p.getByTestId('update-status')).toContainText('Callisto está actualizado');
});

test('instalador que no coincide con el publicado: no se ofrece', async () => {
  release = { version: '99.0.0', installer: randomBytes(5000), ymlSha: createHash('sha512').update('otra cosa').digest('base64') };
  const p = await about();
  await p.getByTestId('update-check').click();
  await expect(p.getByTestId('update-status')).toContainText('no coincide con el publicado');
  await expect(p.getByTestId('update-install')).toHaveCount(0);
});
