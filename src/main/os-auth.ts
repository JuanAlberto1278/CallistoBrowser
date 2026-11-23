import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { app, type BaseWindow } from 'electron';

// Verificación de identidad con Windows (Windows Hello, o la contraseña de la cuenta si Hello no está configurado), a
// través del ayudante native/auth-helper (ver docs/09). Se pide antes de mostrar, copiar o editar una contraseña.

/** Ruta del ayudante: junto a los recursos del ejecutable, o compilado en build-native/ durante el desarrollo. */
export function authHelperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'callisto-auth.exe') : join(app.getAppPath(), 'build-native', 'callisto-auth.exe');
}

/**
 * Solo para las pruebas automáticas, y SOLO sin empaquetar: CALLISTO_TEST_AUTH=allow|deny reemplaza el cuadro de
 * Windows (que una prueba no puede contestar). El ejecutable empaquetado lo ignora.
 */
const testAnswer = !app.isPackaged ? process.env.CALLISTO_TEST_AUTH : undefined;

function nativeHandle(win: BaseWindow): string {
  const buf = win.getNativeWindowHandle();
  return (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
}

/** 'verified': Windows confirmó la identidad; 'rejected': el usuario canceló o no pasó; 'error': no se pudo preguntar. */
export type VerifyResult = 'verified' | 'rejected' | 'error';

let inFlight: Promise<VerifyResult> | null = null;

/**
 * Pide a Windows que verifique al usuario, con el cuadro sobre `win`. Si ya hay una verificación en curso, se espera
 * esa misma (nunca dos cuadros a la vez). Solo 'verified' habilita mostrar una contraseña.
 */
export function verifyUser(win: BaseWindow, message: string): Promise<VerifyResult> {
  if (testAnswer === 'allow' || testAnswer === 'deny') {
    const g = globalThis as unknown as { __callistoAuthRequests?: number };
    g.__callistoAuthRequests = (g.__callistoAuthRequests ?? 0) + 1;
    return Promise.resolve(testAnswer === 'allow' ? 'verified' : 'rejected');
  }
  if (inFlight) return inFlight;
  const args = ['verify', nativeHandle(win), message];
  // Para probar a mano el cuadro de contraseña de Windows en un equipo con Windows Hello (nunca es menos seguro)
  if (process.env.CALLISTO_AUTH_MODE === 'password') args.push('password');
  inFlight = new Promise<VerifyResult>((resolve) => {
    execFile(authHelperPath(), args, { windowsHide: true, timeout: 5 * 60_000 }, (error, _stdout, stderr) => {
      // Código de salida 0 = verificado, 1 = cancelado o rechazado; cualquier otra cosa (error, ayudante ausente) = error
      if (!error) return resolve('verified');
      if (error.code === 1) return resolve('rejected');
      console.error(`callisto: verificación de Windows no disponible (${error.code ?? error.message}) ${String(stderr).trim()}`);
      resolve('error');
    });
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
