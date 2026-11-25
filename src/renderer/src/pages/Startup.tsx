import { useState } from 'react';
import { MAX_STARTUP_PAGES, normalizePageAddress, type ClearOnExit, type Settings } from '../../../shared/settings';

/** "Abrir páginas específicas" (1.5): la lista de páginas que se abren al iniciar. */
export function StartupPages({ settings, update }: { settings: Settings; update: (partial: Partial<Settings>) => void }) {
  const api = window.callistoInternal;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const list = settings.startupPages;
  const add = () => {
    const page = normalizePageAddress(input);
    if (!page) return setError('Escribí una dirección, por ejemplo ejemplo.com o https://ejemplo.com/inicio');
    if (list.includes(page)) return setError('Esa página ya está en la lista.');
    update({ startupPages: [...list, page] });
    setInput('');
    setError('');
  };
  return (
    <div className="never-sleep startup-pages" data-testid="startup-pages">
      {list.length === 0 && <p className="muted small">Todavía no hay páginas: agregá alguna, o se abre una pestaña nueva.</p>}
      {list.map((page) => (
        <div className="row" key={page} data-testid="startup-page">
          <span className="startup-url">{page}</span>
          <button className="btn small" data-testid="startup-page-remove" onClick={() => update({ startupPages: list.filter((p) => p !== page) })}>
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
        <input data-testid="startup-page-input" placeholder="Agregar una página (ejemplo.com)" value={input} maxLength={2048} onChange={(e) => setInput(e.target.value)} />
        <button className="btn" type="submit" data-testid="startup-page-add" disabled={list.length >= MAX_STARTUP_PAGES}>
          Agregar
        </button>
        <button
          className="btn"
          type="button"
          data-testid="startup-use-current"
          title="Reemplaza la lista por las páginas abiertas en esta ventana"
          onClick={() =>
            void api.settings.currentPages().then((pages) => {
              const next = [...new Set(pages.map((p) => normalizePageAddress(p)).filter((p): p is string => !!p))].slice(0, MAX_STARTUP_PAGES);
              if (!next.length) return setError('No hay páginas web abiertas en esta ventana.');
              setError('');
              update({ startupPages: next });
            })
          }
        >
          Usar las páginas abiertas
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

const CLEAR_ITEMS: Array<{ key: keyof ClearOnExit; label: string }> = [
  { key: 'history', label: 'Historial de navegación' },
  { key: 'siteData', label: 'Cookies y datos de sitios (se cierran las sesiones iniciadas)' },
  { key: 'cache', label: 'Imágenes y archivos en caché' },
];

/** "Al cerrar Callisto, borrar" (1.5): cada tipo por separado, apagados por defecto. */
export function ClearOnExitRows({ settings, update }: { settings: Settings; update: (partial: Partial<Settings>) => void }) {
  return (
    <div className="clear-on-exit" data-testid="clear-on-exit">
      <div className="row">
        <span>
          Al cerrar Callisto, borrar
          <br />
          <span className="muted small">Los datos de las extensiones no se borran. Si Callisto se cierra de golpe, se borra al volver a abrirlo.</span>
        </span>
      </div>
      {CLEAR_ITEMS.map((item) => (
        <label className="row" key={item.key}>
          <span>{item.label}</span>
          <input
            type="checkbox"
            data-testid={`clear-on-exit-${item.key}`}
            checked={settings.clearOnExit[item.key]}
            onChange={(e) => update({ clearOnExit: { ...settings.clearOnExit, [item.key]: e.target.checked } })}
          />
        </label>
      ))}
    </div>
  );
}
