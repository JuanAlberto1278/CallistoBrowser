// Contrato IPC entre la interfaz del navegador (renderer privilegiado) y el proceso principal.
// La interfaz solo puede pedir estas acciones; el proceso principal valida remitente y argumentos.

import type { SecurityLevel } from './url-security';

export interface TabState {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  security: SecurityLevel;
}

export interface Notice {
  id: number;
  kind: 'info' | 'warning';
  text: string;
}

export interface WindowState {
  tab: TabState;
  notice: Notice | null;
}

export const IPC = {
  // interfaz -> principal
  navigate: 'callisto:navigate',
  goBack: 'callisto:go-back',
  goForward: 'callisto:go-forward',
  reload: 'callisto:reload',
  stop: 'callisto:stop',
  dismissNotice: 'callisto:dismiss-notice',
  uiReady: 'callisto:ui-ready',
  // principal -> interfaz
  state: 'callisto:state',
  focusAddressBar: 'callisto:focus-address-bar',
} as const;

export const MAX_ADDRESS_INPUT = 8192;

export interface CallistoUiApi {
  navigate(input: string): void;
  goBack(): void;
  goForward(): void;
  reload(ignoreCache: boolean): void;
  stop(): void;
  dismissNotice(id: number): void;
  ready(): void;
  onState(cb: (state: WindowState) => void): void;
  onFocusAddressBar(cb: () => void): void;
}
