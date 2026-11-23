import { app } from 'electron';

// Funciones de Chromium que Callisto desactiva. Van todas en un solo --disable-features: si se agregara la opción dos
// veces, la segunda reemplazaría a la primera. Debe usarse antes de `app.whenReady()`.

const disabled = new Set<string>();

export function disableChromiumFeatures(...names: string[]): void {
  for (const n of names) disabled.add(n);
  app.commandLine.appendSwitch('disable-features', [...disabled].join(','));
}

/**
 * Ahorro de memoria (V1.0, medido): Chromium tiene siempre listo un proceso de renderizado de reserva para la próxima
 * pestaña (~13 MB). Sin él, abrir una pestaña nueva tarda unos milisegundos más.
 */
export function configureMemorySaving(): void {
  disableChromiumFeatures('SpareRendererForSitePerProcess');
}
