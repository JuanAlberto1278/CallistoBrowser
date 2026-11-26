import { describe, expect, it } from 'vitest';
import { dnrDefaultsPlan, ruleResourcesOf } from '../../src/shared/dnr-defaults';

const resources = [
  { id: 'activas', enabled: true },
  { id: 'otras', enabled: true },
  { id: 'apagadas', enabled: false },
];

describe('reglas de bloqueo del manifiesto (1.6.1)', () => {
  it('al instalar y al actualizar: lo del manifiesto (activa las activas, apaga las demás)', () => {
    const plan = { enableRulesetIds: ['activas', 'otras'], disableRulesetIds: ['apagadas'] };
    expect(dnrDefaultsPlan('install', resources)).toEqual(plan);
    expect(dnrDefaultsPlan('update', resources, ['apagadas'])).toEqual(plan);
  });

  it('anteriores a la 1.6.1: si la extensión ya maneja sus conjuntos, no se tocan', () => {
    expect(dnrDefaultsPlan('legacy', resources, ['otras', 'spa-0'])).toBeNull();
    expect(dnrDefaultsPlan('legacy', resources, [])).toEqual({ enableRulesetIds: ['activas', 'otras'], disableRulesetIds: ['apagadas'] });
  });

  it('nada que hacer: sin paso o sin conjuntos en el manifiesto', () => {
    expect(dnrDefaultsPlan(null, resources)).toBeNull();
    expect(dnrDefaultsPlan('install', [])).toBeNull();
  });

  it('lee los conjuntos del manifiesto', () => {
    expect(ruleResourcesOf({ declarative_net_request: { rule_resources: [{ id: 'a', enabled: true, path: 'a.json' }, { id: 'b', path: 'b.json' }, { path: 'sin-id.json' }, null] } })).toEqual([
      { id: 'a', enabled: true },
      { id: 'b', enabled: false },
    ]);
    expect(ruleResourcesOf({})).toEqual([]);
    expect(ruleResourcesOf(null)).toEqual([]);
  });
});
