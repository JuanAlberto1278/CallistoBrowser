import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ClearPeriod, HistoryEntry } from '../../../shared/internal-api';
import { CloseIcon, GlobeIcon } from '../icons';

const PAGE = 100;

const PERIODS: Array<{ id: ClearPeriod; label: string }> = [
  { id: 'hour', label: 'Última hora' },
  { id: 'day', label: 'Últimas 24 horas' },
  { id: 'week', label: 'Últimos 7 días' },
  { id: 'month', label: 'Últimas 4 semanas' },
  { id: 'all', label: 'Todo el historial' },
];

const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function dayLabel(time: number): string {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const full = dayFmt.format(d);
  if (same(d, today)) return `Hoy — ${full}`;
  if (same(d, yesterday)) return `Ayer — ${full}`;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

function groupByDay(entries: HistoryEntry[]): Array<{ label: string; key: string; items: HistoryEntry[] }> {
  const groups: Array<{ label: string; key: string; items: HistoryEntry[] }> = [];
  for (const e of entries) {
    const key = new Date(e.time).toDateString();
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(e);
    else groups.push({ key, label: dayLabel(e.time), items: [e] });
  }
  return groups;
}

export function HistoryPage() {
  const api = window.callistoInternal.history;
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [period, setPeriod] = useState<ClearPeriod>('hour');
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (q: string, append: boolean, current: HistoryEntry[] = []) => {
      const id = ++seq.current;
      const last = append ? current[current.length - 1] : undefined;
      const page = await api.query({ query: q || undefined, before: last ? { time: last.time, id: last.id } : undefined, limit: PAGE });
      if (id !== seq.current) return; // llegó una búsqueda más nueva
      setEntries(append ? [...current, ...page] : page);
      setHasMore(page.length === PAGE);
      setLoaded(true);
    },
    [api],
  );

  // Búsqueda: espera a que se deje de escribir un momento
  useEffect(() => {
    const t = setTimeout(() => void load(query, false), query ? 200 : 0);
    return () => clearTimeout(t);
  }, [query, load]);

  // Más resultados al llegar al final de la lista
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver((list) => {
      if (list.some((i) => i.isIntersecting)) void load(query, true, entries);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, entries, query, load]);

  const open = (e: MouseEvent, entry: HistoryEntry) => {
    if (e.button === 1 || e.ctrlKey || e.metaKey) api.open(entry.url, 'background-tab');
    else if (e.shiftKey) api.open(entry.url, 'new-tab');
    else api.open(entry.url, 'current');
  };

  const remove = async (entry: HistoryEntry) => {
    await api.deleteVisit(entry.id);
    setEntries((list) => list.filter((e) => e.id !== entry.id));
  };

  const clear = async () => {
    await api.clear(period);
    setClearing(false);
    await load(query, false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Historial</h1>
        <input
          className="search"
          type="search"
          data-testid="history-search"
          aria-label="Buscar en el historial"
          placeholder="Buscar en el historial"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" data-testid="history-clear-open" onClick={() => setClearing((v) => !v)}>
          Borrar datos de navegación…
        </button>
      </div>

      {clearing && (
        <div className="card clear-panel" role="dialog" aria-label="Borrar historial">
          <span>Borrar el historial de:</span>
          <select data-testid="history-clear-period" value={period} onChange={(e) => setPeriod(e.target.value as ClearPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button className="btn primary" data-testid="history-clear-confirm" onClick={() => void clear()}>
            Borrar
          </button>
          <button className="btn" onClick={() => setClearing(false)}>
            Cancelar
          </button>
          <span className="muted">Se borran las páginas visitadas. Las cookies y los datos de los sitios no se tocan.</span>
        </div>
      )}

      {loaded && entries.length === 0 && (
        <div className="empty" data-testid="history-empty">
          {query ? `No se encontró nada para «${query}».` : 'Todavía no hay páginas en el historial.'}
        </div>
      )}

      {groupByDay(entries).map((g) => (
        <section className="card day" key={g.key} aria-label={g.label}>
          <h2 className="day-title">{g.label}</h2>
          {g.items.map((entry) => (
            <div
              key={entry.id}
              className="visit"
              role="link"
              tabIndex={0}
              data-testid="history-item"
              title={entry.url}
              onClick={(e) => open(e, entry)}
              onAuxClick={(e) => {
                if (e.button === 1) open(e, entry);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') api.open(entry.url, e.ctrlKey ? 'background-tab' : 'current');
                if (e.key === 'Delete') void remove(entry);
              }}
            >
              <span className="visit-time">{timeFmt.format(entry.time)}</span>
              <span className="visit-icon" aria-hidden="true">
                {entry.icon ? <img src={entry.icon} alt="" /> : <GlobeIcon />}
              </span>
              <span className="visit-title" data-testid="history-title">{entry.title || entry.url}</span>
              <span className="visit-host">{entry.host}</span>
              <button
                className="icon-btn"
                data-testid="history-delete"
                aria-label={`Quitar «${entry.title || entry.url}» del historial`}
                title="Quitar del historial"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(entry);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </section>
      ))}
      <div ref={sentinel} />
    </div>
  );
}
