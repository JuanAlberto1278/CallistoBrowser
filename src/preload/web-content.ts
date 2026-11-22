// Preload que corre en TODAS las páginas web (y sus iframes). No expone nada a la página.
//
// Corrección de capacidades WebAuthn (docs/01-v0.1-resultados.md §5.4):
// Electron anuncia autocompletado de passkeys ("conditional mediation") e "immediate mediation", pero no tiene la
// interfaz de Chrome que las implementa; en Windows la petición termina abriendo, sin que el usuario lo pida, el
// diálogo del sistema de llave de seguridad USB. Callisto anuncia solo lo que soporta. El inicio de sesión con passkey
// que el usuario elige explícitamente sigue funcionando con el diálogo de Windows.
import { contextBridge } from 'electron';

contextBridge.executeInMainWorld({
  func: () => {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return;
    try {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
      const pkc = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
      if (pkc.getClientCapabilities) {
        const original = pkc.getClientCapabilities.bind(PublicKeyCredential);
        pkc.getClientCapabilities = async () => ({ ...(await original()), conditionalGet: false, conditionalCreate: false, immediateGet: false });
      }
      const get = navigator.credentials.get.bind(navigator.credentials);
      const create = navigator.credentials.create.bind(navigator.credentials);
      const pendingUntilAbort = (signal?: AbortSignal | null) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
        });
      type Opts = { publicKey?: unknown; mediation?: string; signal?: AbortSignal | null };
      navigator.credentials.get = (options?: CredentialRequestOptions) => {
        const o = (options ?? {}) as Opts;
        if (o.publicKey && o.mediation === 'conditional') return pendingUntilAbort(o.signal);
        if (o.publicKey && o.mediation === 'immediate') return Promise.reject(new DOMException('No immediate credential', 'NotAllowedError'));
        return get(options);
      };
      navigator.credentials.create = (options?: CredentialCreationOptions) => {
        const o = (options ?? {}) as Opts;
        if (o.publicKey && o.mediation === 'conditional') return pendingUntilAbort(o.signal);
        return create(options);
      };
    } catch (e) {
      console.error('callisto: webauthn patch failed', e);
    }
  },
});
