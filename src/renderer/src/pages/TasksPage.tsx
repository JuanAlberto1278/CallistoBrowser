import { useCallback, useEffect, useState } from 'react';
import type { TaskRow, TaskSnapshot } from '../../../shared/internal-api';

type SortKey = 'type' | 'memory' | 'cpu';

const sorters: Record<SortKey, ((a: TaskRow, b: TaskRow) => number) | null> = {
  type: null, // el orden que da Callisto: proceso principal, GPU, interfaz, servicios, pestañas…
  memory: (a, b) => b.memoryMb - a.memoryMb || a.pid - b.pid,
  cpu: (a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb || a.pid - b.pid,
};

const formatCpu = (cpu: number) => (cpu < 0.1 ? '0' : cpu.toLocaleString('es', { maximumFractionDigits: 1 }));

/** Administrador de tareas de Callisto (Shift+Esc): se actualiza cada 1,5 s mientras está a la vista. */
export function TasksPage() {
  const api = window.callistoInternal.tasks;
  const [snap, setSnap] = useState<TaskSnapshot | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey>('type');

  const load = useCallback(() => {
    if (!document.hidden) void api.list().then(setSnap);
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 1500);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, [load]);

  if (!snap) return null;
  const sorter = sorters[sort];
  const rows = sorter ? [...snap.rows].sort(sorter) : snap.rows;
  const chosen = rows.find((r) => r.pid === selected) ?? null;
  const end = () => {
    if (!chosen?.canEnd) return;
    void api.end(chosen.pid).then(() => {
      setSelected(null);
      load();
    });
  };
  const header = (key: SortKey, label: string, className = '') => (
    <th className={className} aria-sort={sort === key && key !== 'type' ? 'descending' : 'none'}>
      <button className="th-sort" data-testid={`tasks-sort-${key}`} onClick={() => setSort(key)}>
        {label}
        {sort === key && key !== 'type' ? ' ▾' : ''}
      </button>
    </th>
  );

  return (
    <div className="tasks">
      <div className="tasks-table">
        <table data-testid="tasks">
          <thead>
            <tr>
              {header('type', 'Tarea')}
              {header('memory', 'Memoria', 'num')}
              {header('cpu', 'CPU', 'num')}
              <th className="num">Proceso</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.pid}
                data-testid="task-row"
                data-pid={r.pid}
                data-kind={r.kind}
                className={r.pid === selected ? 'selected' : ''}
                aria-selected={r.pid === selected}
                tabIndex={0}
                onClick={() => setSelected(r.pid)}
                onKeyDown={(e) => {
                  if (e.key === 'Delete') end();
                }}
              >
                <td>
                  <span className="task-title" data-testid="task-title">
                    {r.title}
                  </span>
                  {r.members.map((m, i) => (
                    <span key={i} className="task-member muted small" data-testid="task-member">
                      {m}
                    </span>
                  ))}
                </td>
                <td className="num" data-testid="task-memory">
                  {r.memoryMb.toLocaleString('es')} MB
                </td>
                <td className="num" data-testid="task-cpu">
                  {formatCpu(r.cpu)} %
                </td>
                <td className="num muted">{r.pid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="tasks-footer">
        <span className="muted small">
          <span data-testid="tasks-total">
            {snap.totalMb.toLocaleString('es')} MB en {snap.rows.length} procesos
          </span>
          {' · '}
          {snap.asleepTabs} {snap.asleepTabs === 1 ? 'pestaña dormida' : 'pestañas dormidas'} (sin proceso)
          {snap.savedTodayMb > 0 && (
            <>
              {' · '}
              <span data-testid="tasks-saved">hoy liberaron al menos {snap.savedTodayMb.toLocaleString('es')} MB</span>
            </>
          )}
          <br />
          Las pestañas del mismo sitio pueden compartir un proceso: se muestran juntas.
        </span>
        <button className="btn" data-testid="task-end" disabled={!chosen?.canEnd} onClick={end} title={chosen && !chosen.canEnd ? 'Este proceso es parte de Callisto y no se puede finalizar' : undefined}>
          Finalizar proceso
        </button>
      </footer>
    </div>
  );
}
