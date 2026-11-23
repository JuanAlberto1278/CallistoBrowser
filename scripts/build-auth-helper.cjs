// Compila el ayudante de verificación de identidad (native/auth-helper/CallistoAuth.cs) con el compilador de C# que
// trae Windows (.NET Framework 4.x). No descarga ni instala nada. Salida: build-native/callisto-auth.exe
// (electron-builder lo copia a resources/ del ejecutable empaquetado).
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const source = join(root, 'native', 'auth-helper', 'CallistoAuth.cs');
const outDir = join(root, 'build-native');
const out = join(outDir, 'callisto-auth.exe');

if (process.platform !== 'win32') {
  console.log('[auth-helper] solo se compila en Windows; se omite.');
  process.exit(0);
}

const windir = process.env.WINDIR || 'C:\\Windows';
const framework = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = join(framework, 'csc.exe');
const winmd = join(windir, 'System32', 'WinMetadata');
for (const f of [csc, join(winmd, 'Windows.Foundation.winmd'), join(winmd, 'Windows.Security.winmd')]) {
  if (!existsSync(f)) {
    console.error(`[auth-helper] falta ${f} (.NET Framework 4 / metadatos de Windows).`);
    process.exit(1);
  }
}

// Ya compilado y al día: nada que hacer
if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs && statSync(out).mtimeMs >= statSync(__filename).mtimeMs) process.exit(0);

mkdirSync(outDir, { recursive: true });
execFileSync(
  csc,
  [
    '-nologo',
    '-optimize+',
    '-platform:anycpu',
    '-target:exe',
    `-out:${out}`,
    `-r:${join(winmd, 'Windows.Foundation.winmd')}`,
    `-r:${join(winmd, 'Windows.Security.winmd')}`,
    `-r:${join(framework, 'System.Runtime.WindowsRuntime.dll')}`,
    `-r:${join(framework, 'System.Runtime.dll')}`,
    source,
  ],
  { stdio: 'inherit' },
);
console.log(`[auth-helper] ${out}`);
