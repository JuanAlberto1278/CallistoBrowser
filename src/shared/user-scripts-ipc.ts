// Canales entre el preload de las páginas y el proceso principal para los scripts de usuario (1.4.4). Ver
// src/main/extensions/user-scripts.ts.

/** Lo que el preload de la página recibe para un frame. */
export interface UserScriptPlan {
  extensionId: string;
  /** Mundo aislado de Electron (número); 0 = el de la página (MAIN). */
  world: number;
  csp: string | null;
  messaging: boolean;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  code: string;
  name: string;
}

export const US_IPC = {
  plan: 'callisto-us:plan',
  message: 'callisto-us:message',
  connect: 'callisto-us:connect',
  portPost: 'callisto-us:port-post',
  portClose: 'callisto-us:port-close',
  /** Del proceso principal al frame: mensajes y cierre de un puerto, y scripts para ejecutar ya (execute). */
  port: 'callisto-us:port',
  execute: 'callisto-us:execute',
  executed: 'callisto-us:executed',
  /** De la extensión (tabs.sendMessage) al mundo del script (runtime.onMessage), y la respuesta. */
  tabMessage: 'callisto-us:tab-message',
  tabResponse: 'callisto-us:tab-response',
} as const;
