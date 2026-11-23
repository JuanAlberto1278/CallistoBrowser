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

// <browser-action-list> de electron-chrome-extensions (botones de las extensiones)
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': { partition?: string; alignment?: string; tab?: string; class?: string; ref?: unknown; 'data-testid'?: string };
    }
  }
}
