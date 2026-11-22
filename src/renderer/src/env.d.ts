import type { CallistoUiApi } from '../../shared/ipc';
import type { CallistoInternalApi } from '../../shared/internal-api';

declare global {
  interface Window {
    /** Interfaz del navegador (callisto://ui). */
    callisto: CallistoUiApi;
    /** Páginas internas (callisto://history, callisto://settings). */
    callistoInternal: CallistoInternalApi;
  }
}

export {};
