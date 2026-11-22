// Copia el binario de Electron y activa el fuse EnableCookieEncryption (más los fuses de endurecimiento
// previstos para Callisto) para verificar el cifrado de cookies en disco.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

(async () => {
  const src = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  const dst = path.join(__dirname, '..', '.runtime', 'electron-fused');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  const exe = path.join(dst, 'electron.exe');
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  const wire = await getCurrentFuseWire(exe);
  console.log('Fuses:', Object.fromEntries(Object.entries(wire).filter(([k]) => isNaN(Number(k)) === false).map(([k, v]) => [FuseV1Options[k] ?? k, v])));
  console.log(exe);
})();
