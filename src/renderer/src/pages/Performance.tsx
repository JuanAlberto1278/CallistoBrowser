import { useEffect, useState } from 'react';
import type { MemoryUsage } from '../../../shared/internal-api';
import { MAX_NEVER_SLEEP_SITES, normalizeSite, type Settings } from '../../../shared/settings';

/** Memoria en uso ahora (se actualiza cada 5 segundos mientras la página está a la vista). */
export function MemoryNow() {
  const api = window.callistoInternal.settings;
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  useEffect(() => {
    const load = () => {
      if (!document.hidden) void api.memoryUsage().then(setUsage);
    };
    load();
    const t = setInterval(load, 5000);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, [api]);
  if (!usage) return null;
  return (
    <div className="row memory-now" data-testid="memory-now">
      <span>
        Callisto está usando <strong data-testid="memory-mb">{usage.mb} MB</strong>
        <br />
        <span className="muted small">
          {usage.processes} procesos · {usage.awakeTabs} {usage.awakeTabs === 1 ? 'pestaña despierta' : 'pestañas despiertas'} ·{' '}
          <span data-testid="memory-asleep">{usage.asleepTabs}</span> {usage.asleepTabs === 1 ? 'dormida' : 'dormidas'} · memoria reservada (el Administrador de
          tareas suele mostrar algo menos)
        </span>
      </span>
    </div>
  );
}

/** Sitios cuyas pestañas nunca se duermen solas. */
export function NeverSleepSites({ settings, update }: { settings: Settings; update: (partial: Partial<Settings>) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const list = settings.neverSleepSites;
  const add = () => {
    const site = normalizeSite(input);
    if (!site) return setError('Escribí un sitio, por ejemplo music.youtube.com');
    if (list.includes(site)) return setError('Ese sitio ya está en la lista.');
    update({ neverSleepSites: [...list, site] });
    setInput('');
    setError('');
  };
  return (
    <div className="never-sleep">
      <div className="row">
        <span>
          Sitios que nunca se duermen
          <br />
          <span className="muted small">También desde el menú de una pestaña (clic derecho → «No dormir nunca…»). Incluye sus subdominios.</span>
        </span>
      </div>
      {list.map((site) => (
        <div className="row" key={site} data-testid="never-sleep-site">
          <span>{site}</span>
          <button className="btn small" data-testid="never-sleep-remove" onClick={() => update({ neverSleepSites: list.filter((s) => s !== site) })}>
            Quitar
          </button>
        </div>
      ))}
      <form
        className="row never-sleep-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input data-testid="never-sleep-input" placeholder="Agregar un sitio (music.youtube.com)" value={input} maxLength={300} onChange={(e) => setInput(e.target.value)} />
        <button className="btn" type="submit" data-testid="never-sleep-add" disabled={list.length >= MAX_NEVER_SLEEP_SITES}>
          Agregar
        </button>
      </form>
      {error && (
        <p className="theme-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
