import { execFile } from 'node:child_process';
import { shell } from 'electron';

// Navegador predeterminado (V1.0). El instalador registra a Callisto como navegador para el usuario (build/installer.nsh);
// elegirlo como predeterminado lo hace el usuario en la Configuración de Windows: Windows 10 y 11 no permiten que un
// programa se ponga solo. Acá solo se LEE el registro (qué eligió el usuario) y se abre esa página de Windows.

function regQuery(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`).exec(String(stdout));
      resolve(m ? m[1]!.trim() : null);
    });
  });
}

export interface DefaultBrowserStatus {
  /** Callisto está registrado como navegador (instalado con el instalador). */
  registered: boolean;
  /** Es el que abre los enlaces https. */
  isDefault: boolean;
}

export async function defaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (process.platform !== 'win32') return { registered: false, isDefault: false };
  const [registered, progId] = await Promise.all([
    regQuery('HKCU\\Software\\RegisteredApplications', 'Callisto'),
    regQuery('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId'),
  ]);
  return { registered: registered !== null, isDefault: progId === 'CallistoURL' };
}

/** Abre "Aplicaciones predeterminadas" de Windows (en la ficha de Callisto si está registrado). */
export function openDefaultAppsSettings(registered: boolean): Promise<void> {
  return shell.openExternal(registered ? 'ms-settings:defaultapps?registeredAppUser=Callisto' : 'ms-settings:defaultapps');
}
