import type { CallistoUiApi } from '../../shared/ipc';

declare global {
  interface Window {
    callisto: CallistoUiApi;
  }
}

export {};
