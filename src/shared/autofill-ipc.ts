// Canales entre el menú de sugerencias de contraseñas (su propia vista de la interfaz) y el proceso principal.
//
// Módulo aparte a propósito: cada preload en sandbox tiene que compilarse en un solo archivo, y un módulo con código
// que importen dos preloads distintos termina en un archivo compartido que el preload no puede cargar (le pasó a
// shared/passwords en la V0.9). Este lo usan solo el preload del menú y el proceso principal.

export const AUTOFILL_IPC = {
  state: 'callisto-autofill:state',
  choose: 'callisto-autofill:choose',
  manage: 'callisto-autofill:manage',
  ready: 'callisto-autofill:ready',
} as const;
