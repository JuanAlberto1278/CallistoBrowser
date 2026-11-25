import { app, type BaseWindow } from 'electron';
import { disableChromiumFeatures } from './chromium-flags';

/**
 * Modo de pruebas automáticas sin ventanas a la vista: lo activan las pruebas end-to-end con CALLISTO_TEST_INVISIBLE=1,
 * y SOLO funciona sin empaquetar (el ejecutable lo ignora). Las ventanas siguen existiendo y dibujándose (las pruebas
 * las necesitan), pero son transparentes, dejan pasar los clics, no aparecen en la barra de tareas y no roban el foco.
 */
export const invisibleForTests = !app.isPackaged && process.env.CALLISTO_TEST_INVISIBLE === '1';

/**
 * Duración de un "minuto" para dormir pestañas: en las pruebas automáticas (CALLISTO_TEST_MINUTE_MS, solo sin
 * empaquetar) se acorta para no esperar minutos reales.
 */
export const SLEEP_MINUTE_MS = !app.isPackaged && Number(process.env.CALLISTO_TEST_MINUTE_MS) > 0 ? Number(process.env.CALLISTO_TEST_MINUTE_MS) : 60_000;

/**
 * Respuesta al "¿Cerrar N pestañas?" en las pruebas automáticas (solo sin empaquetar): CALLISTO_TEST_CLOSE_ANSWER =
 * close | cancel. Sin la variable, en modo de pruebas se cierra (como si el usuario aceptara).
 */
export const TEST_CLOSE_ANSWER: 'close' | 'cancel' | null = app.isPackaged
  ? null
  : process.env.CALLISTO_TEST_CLOSE_ANSWER === 'cancel'
    ? 'cancel'
    : process.env.CALLISTO_TEST_CLOSE_ANSWER === 'close' || invisibleForTests
      ? 'close'
      : null;

/** Las pruebas simulan que a Windows le falta memoria (solo sin empaquetar): CALLISTO_TEST_LOW_MEMORY=1. */
export const TEST_LOW_MEMORY = !app.isPackaged && process.env.CALLISTO_TEST_LOW_MEMORY === '1';

/** Debe llamarse antes de `app.whenReady()`. */
export function configureTestMode(): void {
  if (!invisibleForTests) return;
  // Que Chromium no deje de dibujar ni frene las ventanas por considerarlas tapadas o en segundo plano
  disableChromiumFeatures('CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/** Muestra la ventana; en modo de pruebas, invisible y sin quitarle el foco a lo que el usuario esté usando. */
export function showWindow(win: BaseWindow): void {
  if (!invisibleForTests) {
    win.show();
    return;
  }
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setSkipTaskbar(true);
  win.showInactive();
}
