import { useEffect, useRef, useState } from 'react';
import type { NtpShortcuts, TopSite } from '../../shared/ipc';
import { MAX_SHORTCUTS, MAX_SHORTCUT_TITLE, shortcutHost, type Shortcut } from '../../shared/shortcuts';
import { CloseIcon, SearchIcon } from './icons';

const dateFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });

function greeting(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Calisto, la luna de Júpiter que da nombre al navegador. */
function MoonMark() {
  return (
    <svg className="moon" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="moon-fill" cx="38%" cy="32%" r="70%">
          <stop offset="0" stopColor="var(--moon-light)" />
          <stop offset="1" stopColor="var(--moon-dark)" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill="url(#moon-fill)" />
      <circle cx="23" cy="22" r="4.5" fill="var(--moon-crater)" />
      <circle cx="41" cy="38" r="6.5" fill="var(--moon-crater)" />
      <circle cx="26" cy="42" r="3" fill="var(--moon-crater)" />
      <circle cx="44" cy="20" r="2.2" fill="var(--moon-crater)" />
    </svg>
  );
}

function SiteIcon({ site }: { site: { icon: string | null; host: string } }) {
  const [failed, setFailed] = useState(false);
  if (site.icon && !failed) return <img src={site.icon} alt="" width={24} height={24} onError={() => setFailed(true)} />;
  return <span className="tile-letter">{(site.host[0] ?? '?').toUpperCase()}</span>;
}

/** Agregar o editar un acceso directo (1.5). */
function ShortcutEditor({
  item,
  suggestions,
  onSave,
  onRemove,
  onClose,
}: {
  item: Shortcut | null;
  suggestions: TopSite[];
  onSave: (title: string, url: string) => Promise<string | null>;
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [url, setUrl] = useState(item?.url ?? '');
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const save = async (t: string, u: string) => {
    const err = await onSave(t, u);
    if (err) setError(err);
  };
  return (
    <div className="ntp-dialog-backdrop" onMouseDown={onClose}>
      <form
        className="ntp-dialog"
        role="dialog"
        aria-label={item ? 'Editar acceso directo' : 'Agregar acceso directo'}
        data-testid="ntp-editor"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void save(title, url);
        }}
      >
        <h2>{item ? 'Editar acceso directo' : 'Agregar acceso directo'}</h2>
        <label>
          Nombre
          <input ref={first} data-testid="ntp-editor-name" value={title} maxLength={MAX_SHORTCUT_TITLE} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Dirección
          <input data-testid="ntp-editor-url" value={url} maxLength={2048} spellCheck={false} placeholder="ejemplo.com" onChange={(e) => setUrl(e.target.value)} />
        </label>
        {error && (
          <p className="ntp-dialog-error" role="alert">
            {error}
          </p>
        )}
        {!item && suggestions.length > 0 && (
          <div className="ntp-dialog-suggest">
            <span className="muted">O elegí uno de tus sitios más visitados:</span>
            <div className="ntp-chips">
              {suggestions.map((s) => (
                <button type="button" key={s.host} className="ntp-chip" data-testid="ntp-editor-suggestion" onClick={() => void save(s.title, s.url)}>
                  {s.host}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ntp-dialog-actions">
          {onRemove && (
            <button type="button" className="ntp-dialog-remove" data-testid="ntp-editor-remove" onClick={onRemove}>
              Quitar
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" data-testid="ntp-editor-save" disabled={!url.trim()}>
            {item ? 'Guardar' : 'Agregar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.5 1.8a1.6 1.6 0 0 1 2.3 0l.4.4a1.6 1.6 0 0 1 0 2.3L5.6 13.1 2 14l.9-3.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Página de nueva pestaña: saludo, búsqueda y los sitios más visitados. La dibuja la interfaz encima de la pestaña
 * vacía (no es una página web): al escribir una dirección, la pestaña navega normalmente.
 */
export function NewTabPage({ tabId, searchEngine, isPrivate }: { tabId: number; searchEngine: string; isPrivate: boolean }) {
  const api = window.callisto;
  const [sites, setSites] = useState<TopSite[] | null>(null);
  const [shortcuts, setShortcuts] = useState<NtpShortcuts | null>(null);
  /** El editor abierto: un acceso directo, 'new' para agregar, o null. */
  const [editing, setEditing] = useState<Shortcut | 'new' | null>(null);
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // En privado no se muestran los sitios más visitados (son del perfil, no de esta ventana)
  const load = () => {
    if (isPrivate) return;
    void api.topSites().then(setSites);
    void api.shortcuts().then(setShortcuts);
  };
  useEffect(load, [tabId, api]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const hide = (host: string) => {
    api.hideTopSite(host, true);
    setRemoved(host);
    setSites((list) => list?.filter((s) => s.host !== host) ?? null);
    setTimeout(load, 50);
  };

  // Lo que ya es un acceso directo no se repite en "más visitados" ni en las sugerencias
  const taken = new Set((shortcuts?.items ?? []).map((s) => shortcutHost(s.url)));
  const visibleSites = (sites ?? []).filter((s) => !taken.has(s.host));
  const suggestions = visibleSites;

  const date = dateFmt.format(now);
  return (
    <div className="ntp" data-testid="new-tab-page">
      <div className="ntp-inner">
        <MoonMark />
        <h1 className="ntp-greeting" data-testid="ntp-greeting">{isPrivate ? 'Ventana privada' : greeting(now)}</h1>
        <p className="ntp-date">{date.charAt(0).toUpperCase() + date.slice(1)}</p>
        {isPrivate && (
          <div className="ntp-private" data-testid="ntp-private">
            <p>
              Al cerrar todas las ventanas privadas, Callisto borra el historial, las cookies, las sesiones iniciadas y los datos de los
              sitios que usaste en ellas.
            </p>
            <p className="muted">
              Lo que sí queda: los archivos que descargues y los favoritos que agregues. Tu actividad puede seguir siendo visible para los
              sitios que visitás, tu empresa o escuela, y tu proveedor de internet.
            </p>
          </div>
        )}

        <form
          className="ntp-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) api.navigate(text.trim());
          }}
        >
          <SearchIcon />
          <input
            data-testid="ntp-search"
            aria-label={`Buscar en ${searchEngine} o escribir una dirección`}
            placeholder={`Buscá en ${searchEngine} o escribí una dirección`}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
        </form>

        {shortcuts && (
          <section className="ntp-sites" aria-label="Accesos directos" data-testid="ntp-shortcuts">
            {shortcuts.items.map((s) => (
              <div className="tile" key={s.id} data-testid="ntp-shortcut">
                <button className="tile-link" title={s.url} onClick={() => api.navigate(s.url)}>
                  <span className="tile-icon">
                    <SiteIcon site={{ icon: s.icon, host: shortcutHost(s.url) }} />
                  </span>
                  <span className="tile-title">{s.title}</span>
                </button>
                <button className="tile-hide" data-testid="ntp-shortcut-edit" aria-label={`Editar ${s.title}`} title="Editar o quitar" onClick={() => setEditing(s)}>
                  <PencilIcon />
                </button>
              </div>
            ))}
            {shortcuts.items.length < MAX_SHORTCUTS && (
              <div className="tile">
                <button className="tile-link" data-testid="ntp-shortcut-add" onClick={() => setEditing('new')}>
                  <span className="tile-icon tile-add" aria-hidden="true">
                    +
                  </span>
                  <span className="tile-title">Agregar</span>
                </button>
              </div>
            )}
          </section>
        )}
        {shortcuts && !shortcuts.showTopSites && shortcuts.items.length < MAX_SHORTCUTS && suggestions.length > 0 && (
          <div className="ntp-suggest" data-testid="ntp-suggestions">
            <span className="muted">Agregar de tus más visitados:</span>
            {suggestions.slice(0, 4).map((s) => (
              <button
                key={s.host}
                className="ntp-chip"
                data-testid="ntp-suggestion"
                title={`Agregar ${s.title} a tus accesos directos`}
                onClick={() => void api.saveShortcut(null, s.title, s.url).then((r) => 'ok' in r && setShortcuts(r.ok))}
              >
                + {s.host}
              </button>
            ))}
          </div>
        )}

        {shortcuts?.showTopSites && visibleSites.length > 0 && (
          <section className="ntp-sites ntp-top" aria-label="Sitios más visitados">
            <h2 className="ntp-section-title">Más visitados</h2>
            {visibleSites.map((s) => (
              <div className="tile" key={s.host} data-testid="ntp-tile">
                <button className="tile-link" title={s.url} onClick={() => api.navigate(s.url)}>
                  <span className="tile-icon">
                    <SiteIcon site={s} />
                  </span>
                  <span className="tile-title">{s.title}</span>
                </button>
                <button className="tile-hide" data-testid="ntp-hide" aria-label={`Quitar ${s.host} de los más visitados`} title="Quitar" onClick={() => hide(s.host)}>
                  <CloseIcon />
                </button>
              </div>
            ))}
          </section>
        )}
        {shortcuts?.showTopSites && sites && visibleSites.length === 0 && <p className="ntp-empty" data-testid="ntp-empty">Los sitios que visites seguido van a aparecer acá.</p>}
        {shortcuts && (
          <label className="ntp-option">
            <input
              type="checkbox"
              data-testid="ntp-show-top"
              checked={shortcuts.showTopSites}
              onChange={(e) => {
                const show = e.target.checked;
                setShortcuts({ ...shortcuts, showTopSites: show });
                void api.setShowTopSites(show).then(setShortcuts);
              }}
            />
            Mostrar también los sitios más visitados
          </label>
        )}
        {editing && (
          <ShortcutEditor
            item={editing === 'new' ? null : editing}
            suggestions={suggestions.slice(0, 6)}
            onClose={() => setEditing(null)}
            onSave={async (title, url) => {
              const r = await api.saveShortcut(editing === 'new' ? null : editing.id, title, url);
              if ('error' in r) return r.error;
              setShortcuts(r.ok);
              setEditing(null);
              return null;
            }}
            onRemove={
              editing === 'new'
                ? null
                : () =>
                    void api.removeShortcut(editing.id).then((list) => {
                      setShortcuts(list);
                      setEditing(null);
                    })
            }
          />
        )}

        {removed && (
          <div className="ntp-toast" role="status">
            Se quitó {removed}.
            <button
              onClick={() => {
                api.hideTopSite(removed, false);
                setRemoved(null);
                setTimeout(load, 50);
              }}
            >
              Deshacer
            </button>
            <button
              onClick={() => {
                api.restoreTopSites();
                setRemoved(null);
                setTimeout(load, 50);
              }}
            >
              Mostrar todos
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
