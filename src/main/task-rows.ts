// Filas del Administrador de tareas: qué es cada proceso y en qué orden se muestra (sin Electron: lo prueban las pruebas
// unitarias).
import type { TaskKind, TaskRow } from '../shared/internal-api';
import type { ProcessSample } from './resource-monitor';

const UTILITY_NAMES: Record<string, string> = {
  'Network Service': 'Servicio de red',
  'Audio Service': 'Servicio de audio',
  'Storage Service': 'Servicio de almacenamiento',
  'Video Capture': 'Servicio de captura de video',
  'Data Decoder Service': 'Decodificador de datos',
  'Unzip Service': 'Descompresor',
  'Image Decoder Service': 'Decodificador de imágenes',
};

export interface Owner {
  kind: TaskKind;
  label: string;
}

const KIND_ORDER: TaskKind[] = ['browser', 'gpu', 'ui', 'utility', 'tabs', 'internal', 'extension', 'devtools', 'other'];

/** Fila del Administrador de tareas para un proceso y las páginas que viven en él. */
export function describeProcess(s: ProcessSample, owners: readonly Owner[]): TaskRow {
  const base = { pid: s.pid, memoryMb: Math.round(s.memoryKb / 1024), cpu: Math.round(s.cpu * 10) / 10 };
  if (s.type === 'Browser') return { ...base, kind: 'browser', title: 'Callisto (proceso principal)', members: [], canEnd: false };
  if (s.type === 'GPU') return { ...base, kind: 'gpu', title: 'Proceso de la GPU', members: [], canEnd: false };
  if (s.type === 'Utility') {
    const name = s.name ?? s.serviceName ?? '';
    return { ...base, kind: 'utility', title: UTILITY_NAMES[name] ?? (name ? `Servicio: ${name}` : 'Servicio de Callisto'), members: [], canEnd: false };
  }
  if (s.type !== 'Tab') return { ...base, kind: 'other', title: 'Otro proceso de Callisto', members: [], canEnd: false };
  if (!owners.length) return { ...base, kind: 'other', title: 'Páginas en segundo plano (service workers)', members: [], canEnd: false };

  // La interfaz (o este mismo administrador) en el proceso: nunca se finaliza desde acá
  const ui = owners.filter((o) => o.kind === 'ui');
  if (ui.length) {
    const windows = ui.filter((o) => o.label === 'Interfaz de Callisto').length;
    const title = windows ? (windows === 1 ? 'Interfaz de Callisto' : `Interfaz de Callisto (${windows} ventanas)`) : ui[0]!.label;
    return { ...base, kind: 'ui', title, members: [], canEnd: false };
  }
  const kind = KIND_ORDER.find((k) => owners.some((o) => o.kind === k))!;
  const labels = owners.map((o) => o.label);
  if (labels.length === 1) return { ...base, kind, title: labels[0]!, members: [], canEnd: true };
  const tabs = owners.filter((o) => o.kind === 'tabs').length;
  const title = tabs === owners.length ? `${tabs} pestañas del mismo sitio` : `${owners.length} páginas`;
  return { ...base, kind, title, members: labels, canEnd: true };
}

/** Procesos de Callisto, del principal a los de las páginas; dentro de cada tipo, los que más memoria usan primero. */
export function sortRows(rows: TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.memoryMb - a.memoryMb || a.pid - b.pid);
}

