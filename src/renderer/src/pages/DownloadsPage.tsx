import { useCallback, useEffect, useState } from 'react';
import type { DownloadEntry } from '../../../shared/downloads';
import { DownloadRow } from '../Downloads';

const dayFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function groupByDay(list: DownloadEntry[]) {
  const groups: Array<{ key: string; label: string; items: DownloadEntry[] }> = [];
  const today = new Date().toDateString();
  for (const d of list) {
    const date = new Date(d.startTime);
    const key = date.toDateString();
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(d);
    else {
      const full = dayFmt.format(date);
      groups.push({ key, label: key === today ? `Hoy — ${full}` : full.charAt(0).toUpperCase() + full.slice(1), items: [d] });
    }
  }
  return groups;
}

export function DownloadsPage() {
  const api = window.callistoInternal.downloads;
  const [query, setQuery] = useState('');
  const [list, setList] = useState<DownloadEntry[] | null>(null);

  const load = useCallback(() => void api.list(query || undefined).then(setList), [api, query]);

  useEffect(() => {
    const t = setTimeout(load, query ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Mientras hay descargas en curso, la lista se actualiza cada segundo
  const live = list?.some((d) => d.state === 'in_progress' || d.state === 'starting' || d.state === 'paused' || d.state === 'waiting_click');
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [live, load]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Descargas</h1>
        <input className="search" type="search" data-testid="downloads-search" aria-label="Buscar en las descargas" placeholder="Buscar en las descargas" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" data-testid="downloads-open-folder" onClick={() => api.openFolder()}>
          Abrir carpeta de descargas
        </button>
        <button className="btn" data-testid="downloads-clear" onClick={() => void api.clear().then(load)}>
          Borrar lista
        </button>
      </div>
      {list && list.length === 0 && (
        <div className="empty" data-testid="downloads-empty">
          {query ? `No se encontró nada para «${query}».` : 'Todavía no hay descargas. Callisto te pregunta antes de guardar cada archivo.'}
        </div>
      )}
      {list &&
        groupByDay(list).map((g) => (
          <section className="card day" key={g.key} aria-label={g.label}>
            <h2 className="day-title">{g.label}</h2>
            {g.items.map((d) => (
              <DownloadRow key={d.id} d={d} onAction={(a) => void api.action(d.id, a).then(() => setTimeout(load, 150))} />
            ))}
          </section>
        ))}
    </div>
  );
}
