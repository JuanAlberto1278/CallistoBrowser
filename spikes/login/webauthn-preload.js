// Callisto V0.1 — Corrección de capacidades WebAuthn.
// Electron anuncia "conditional mediation" (autocompletado de passkeys) e "immediate mediation", pero no tiene la
// interfaz de Chrome que las implementa: en Windows la petición termina abriendo el diálogo modal del sistema
// (llave de seguridad USB) sin que el usuario lo haya pedido. Callisto anuncia solo lo que soporta:
//  - isConditionalMediationAvailable() -> false; getClientCapabilities(): conditionalGet/conditionalCreate/immediateGet -> false
//  - get({ mediation: 'conditional' }) queda pendiente (igual que Chrome mientras el usuario no elige nada)
//  - get({ mediation: 'immediate' }) se rechaza con NotAllowedError (lo que la especificación indica si no hay credencial inmediata)
// El inicio de sesión con passkey EXPLÍCITO (el usuario elige "Usar llave de acceso") sigue funcionando con el diálogo de Windows.
'use strict';
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return;
    try {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
      if (PublicKeyCredential.getClientCapabilities) {
        const original = PublicKeyCredential.getClientCapabilities.bind(PublicKeyCredential);
        PublicKeyCredential.getClientCapabilities = async () => ({ ...(await original()), conditionalGet: false, conditionalCreate: false, immediateGet: false });
      }
      const get = navigator.credentials.get.bind(navigator.credentials);
      const create = navigator.credentials.create.bind(navigator.credentials);
      const pendingUntilAbort = (signal) => new Promise((_, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
      });
      navigator.credentials.get = (options = {}) => {
        if (options.publicKey && options.mediation === 'conditional') return pendingUntilAbort(options.signal);
        if (options.publicKey && options.mediation === 'immediate') return Promise.reject(new DOMException('No immediate credential', 'NotAllowedError'));
        return get(options);
      };
      navigator.credentials.create = (options = {}) => {
        if (options.publicKey && options.mediation === 'conditional') return pendingUntilAbort(options.signal);
        return create(options);
      };
    } catch (e) {
      console.error('callisto webauthn patch failed', e);
    }
  },
});
