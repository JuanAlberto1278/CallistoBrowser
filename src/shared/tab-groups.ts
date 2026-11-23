// Grupos de pestañas: tipos y lógica pura (orden contiguo, colores).

/** Colores de grupo (los de Chrome). */
export const GROUP_COLORS = {
  grey: { name: 'Gris', hex: '#5f6368' },
  blue: { name: 'Azul', hex: '#1a73e8' },
  red: { name: 'Rojo', hex: '#d93025' },
  yellow: { name: 'Amarillo', hex: '#e8a400' },
  green: { name: 'Verde', hex: '#188038' },
  pink: { name: 'Rosa', hex: '#d01884' },
  purple: { name: 'Violeta', hex: '#a142f4' },
  cyan: { name: 'Turquesa', hex: '#007b83' },
  orange: { name: 'Naranja', hex: '#fa7b17' },
} as const;

export type GroupColor = keyof typeof GROUP_COLORS;
export const GROUP_COLOR_IDS = Object.keys(GROUP_COLORS) as GroupColor[];

export interface TabGroupState {
  id: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export type GroupAction = 'new-tab' | 'ungroup' | 'close' | 'move-to-window';

export const MAX_GROUP_TITLE = 60;

export function isGroupColor(v: unknown): v is GroupColor {
  return typeof v === 'string' && v in GROUP_COLORS;
}

export function sanitizeGroupTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trimStart().slice(0, MAX_GROUP_TITLE) : '';
}

/** Primer color que no usa ningún grupo de la ventana (como Chrome). */
export function nextGroupColor(used: Iterable<GroupColor>): GroupColor {
  const taken = new Set(used);
  return GROUP_COLOR_IDS.find((c) => !taken.has(c)) ?? GROUP_COLOR_IDS[0]!;
}

/**
 * Las pestañas de un grupo siempre van juntas: cada grupo queda donde aparece su primera pestaña, con todas las suyas en
 * el orden en que estaban. Las pestañas sin grupo no cambian de lugar relativo.
 */
export function keepGroupsTogether<T extends { groupId: number | null }>(list: readonly T[]): T[] {
  const out: T[] = [];
  const placed = new Set<number>();
  for (const item of list) {
    if (item.groupId === null) {
      out.push(item);
    } else if (!placed.has(item.groupId)) {
      placed.add(item.groupId);
      for (const member of list) if (member.groupId === item.groupId) out.push(member);
    }
  }
  return out;
}

/**
 * Grupo al que se une una pestaña soltada en la posición `index` (entre `list[index - 1]` y `list[index]`, sin contar la
 * pestaña que se mueve): el de sus vecinas si las dos son del mismo grupo; si no, ninguno.
 */
export function groupAtDrop<T extends { groupId: number | null }>(list: readonly T[], index: number): number | null {
  const left = list[index - 1];
  const right = list[index];
  return left && right && left.groupId !== null && left.groupId === right.groupId ? left.groupId : null;
}

/**
 * Posición válida para soltar un grupo entero: nunca en medio de otro grupo (si cae adentro, va después de ese grupo).
 * `list` no incluye las pestañas del grupo que se mueve.
 */
export function groupDropIndex<T extends { groupId: number | null }>(list: readonly T[], index: number): number {
  let i = Math.max(0, Math.min(index, list.length));
  const g = groupAtDrop(list, i);
  if (g === null) return i;
  while (i < list.length && list[i]!.groupId === g) i++;
  return i;
}
