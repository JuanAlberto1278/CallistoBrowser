import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';

/**
 * Debe llamarse antes de `app.whenReady()`.
 * - Producción: %APPDATA%\Callisto
 * - Desarrollo: %APPDATA%\Callisto-Dev (sin fuses: cookies sin cifrar; no se mezcla con el perfil real)
 * - CALLISTO_USER_DATA_DIR: carpeta explícita (pruebas automáticas)
 */
export function configureUserData(): void {
  const override = process.env.CALLISTO_USER_DATA_DIR;
  if (override) app.setPath('userData', override);
  else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Callisto-Dev'));
}

/**
 * Cuarentena privada de descargas (docs/01-v0.1-resultados.md §1.3): Chromium crea un archivo temporal en la carpeta
 * de descargas de la app ANTES de avisar a Callisto. Apuntarla aquí evita que toque la carpeta Descargas del usuario.
 */
export function quarantineDir(): string {
  return join(app.getPath('userData'), 'Quarantine');
}

export function prepareQuarantine(): string {
  const dir = quarantineDir();
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  app.setPath('downloads', dir);
  return dir;
}
