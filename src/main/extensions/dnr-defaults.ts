// Reglas de bloqueo que vienen activas en el manifiesto (declarativeNetRequest, 1.6.1).
//
// Chrome, al instalar o actualizar una extensión, activa los conjuntos de reglas que su manifiesto marca con
// "enabled": true. Electron se salta ese paso: quedaban apagados y la extensión no bloqueaba nada (salvo las que los
// activan por su cuenta, como uBlock Origin Lite). El motor de reglas sí funciona, así que Callisto hace ese paso: el
// preload del service worker de la extensión pregunta acá si corresponde y llama a updateEnabledRulesets antes que el
// código de la extensión. Ver docs/20-v1.6.1.md.
import type { ExtensionManager } from './manager';
import { DNR_IPC, type DnrDefaultsStep } from '../../shared/dnr-defaults';

/** Versión de cada extensión con la que ya se aplicaron las reglas por defecto. */
const KV_KEY = 'dnr.defaultsApplied';
/** Marca de las extensiones que ya estaban instaladas al llegar la 1.6.1. */
const LEGACY = '(anterior a 1.6.1)';

export function registerDnrDefaults(manager: ExtensionManager): void {
  const kv = manager.profile.kv;
  const applied = (): Record<string, string> => kv.get<Record<string, string>>(KV_KEY) ?? {};
  // Primera vez con la 1.6.1: las extensiones que ya estaban quedan como "anteriores" (ver dnrDefaultsPlan)
  if (kv.get(KV_KEY) === undefined) kv.set(KV_KEY, Object.fromEntries(manager.registry.all().map((r) => [r.id, LEGACY])));

  const workers = manager.profile.session.serviceWorkers;
  const watched = new WeakSet<object>();
  // El canal del service worker se registra al arrancar, antes de que corra su preload (como los scripts de usuario)
  workers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting') return;
    const worker = workers.getWorkerFromVersionID(versionId);
    const m = worker ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(worker.scope) : null;
    if (!worker || !m || watched.has(worker)) return;
    watched.add(worker);
    const id = m[1]!;
    worker.ipc.on(DNR_IPC.step, (e, extensionId: unknown, version: unknown) => {
      let step: DnrDefaultsStep = null;
      if (extensionId === id && typeof version === 'string') {
        const before = applied()[id];
        step = before === undefined ? 'install' : before === LEGACY ? 'legacy' : before !== version ? 'update' : null;
      }
      e.returnValue = step;
    });
    worker.ipc.on(DNR_IPC.done, (_e, extensionId: unknown, version: unknown) => {
      if (extensionId !== id || typeof version !== 'string') return;
      kv.set(KV_KEY, { ...applied(), [id]: version });
    });
  });

  // Al quitar una extensión se olvida (si se vuelve a instalar, es una instalación nueva)
  manager.on('changed', () => {
    const installed = new Set(manager.registry.all().map((r) => r.id));
    const current = applied();
    const kept = Object.fromEntries(Object.entries(current).filter(([id]) => installed.has(id)));
    if (Object.keys(kept).length !== Object.keys(current).length) kv.set(KV_KEY, kept);
  });
}
