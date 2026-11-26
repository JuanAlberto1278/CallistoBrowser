// Reglas de bloqueo activas por defecto (1.6.1): canales y decisión, compartidos por el preload de las extensiones y el
// proceso principal. Ver src/main/extensions/dnr-defaults.ts.

export const DNR_IPC = {
  /** Síncrono: ¿qué paso toca para esta versión de la extensión? */
  step: 'callisto-dnr:step',
  /** Ya se aplicó para esta versión. */
  done: 'callisto-dnr:done',
} as const;

/**
 * 'install': instalación nueva; 'update': se aplicó para otra versión (Chrome vuelve a los valores del manifiesto al
 * actualizar); 'legacy': instalada antes de la 1.6.1 (no se sabe si la extensión ya maneja sus reglas); null: nada.
 */
export type DnrDefaultsStep = 'install' | 'update' | 'legacy' | null;

export interface RuleResource {
  id: string;
  enabled: boolean;
}

/**
 * Qué conjuntos activar y apagar: los del manifiesto (los que no vienen activos se apagan), como Chrome al instalar o
 * actualizar. Una extensión instalada antes de la 1.6.1 que ya tiene alguno activo los maneja ella (como uBlock Origin
 * Lite): no se toca. `currentlyEnabled` solo hace falta para 'legacy'.
 */
export function dnrDefaultsPlan(step: DnrDefaultsStep, resources: readonly RuleResource[], currentlyEnabled: readonly string[] = []): { enableRulesetIds: string[]; disableRulesetIds: string[] } | null {
  if (!step || !resources.length) return null;
  if (step === 'legacy' && currentlyEnabled.length) return null;
  const enableRulesetIds = resources.filter((r) => r.enabled).map((r) => r.id);
  const disableRulesetIds = resources.filter((r) => !r.enabled).map((r) => r.id);
  return { enableRulesetIds, disableRulesetIds };
}

/** Los conjuntos de reglas del manifiesto (declarative_net_request.rule_resources). */
export function ruleResourcesOf(manifest: unknown): RuleResource[] {
  const dnr = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>).declarative_net_request : null;
  const list = dnr && typeof dnr === 'object' ? (dnr as Record<string, unknown>).rule_resources : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is { id: string; enabled?: unknown } => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    .map((r) => ({ id: r.id, enabled: r.enabled === true }));
}
