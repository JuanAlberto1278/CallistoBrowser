# Callisto — pruebas de concepto (V0.1)

Código de validación técnica, **no es el producto**. Cada prueba es una mini-app de Electron independiente.
Los datos de ejecución van a `.runtime/` (ignorado) y los resultados a `results/`.

| Comando | Qué valida |
|---|---|
| `npx electron downloads/main.js` | 16 mecanismos de descarga × estrategias de autorización; qué llega a disco antes de autorizar |
| `npx electron downloads/main.js --placeholder-in-downloads --only=link-attachment,data-url` | Comportamiento por defecto de Chromium (marcador en la carpeta Descargas) |
| `npx electron profiles/main.js --phase=write` y luego `--phase=read` | Aislamiento entre perfiles, persistencia tras reinicio, modo privado |
| `node profiles/make-fused-electron.js` | Copia de Electron con el fuse `EnableCookieEncryption` (y fuses de endurecimiento) |
| `python -I profiles/inspect-disk.py .runtime/profiles` | Cifrado de cookies en disco y fugas de datos privados |
| `npx electron platform/main.js` | `node:sqlite` + FTS5, bóveda DPAPI + AES-256-GCM, user-agent |
| `npx electron extensions/main.js` | 16 extensiones reales desde Chrome Web Store: instalación, APIs, popups, pruebas funcionales |
| `npx electron extensions/diagnose.js [--alias]` | Diagnóstico aislado de extensiones que fallaban |
| `npx electron extensions/race-test/run.js` | Qué APIs ve un service worker de extensión (descubrió el problema de `browser`) |
| `npm run login` | **Prueba manual** de inicio de sesión (la hace el usuario). `-- --reset` borra los perfiles; `-- --ua=electron` cambia la identidad |
| `npx electron login/webauthn-check.js [--patched]` | Capacidades de passkeys que Electron anuncia, con y sin la corrección |

Informe de resultados: [`../docs/01-v0.1-resultados.md`](../docs/01-v0.1-resultados.md)
