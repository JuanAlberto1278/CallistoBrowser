import { useEffect, useState } from 'react';
import type { TopSite } from '../../shared/ipc';
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

function SiteIcon({ site }: { site: TopSite }) {
  const [failed, setFailed] = useState(false);
  if (site.icon && !failed) return <img src={site.icon} alt="" width={24} height={24} onError={() => setFailed(true)} />;
  return <span className="tile-letter">{(site.host[0] ?? '?').toUpperCase()}</span>;
}

/**
 * Página de nueva pestaña: saludo, búsqueda y los sitios más visitados. La dibuja la interfaz encima de la pestaña
 * vacía (no es una página web): al escribir una dirección, la pestaña navega normalmente.
 */
export function NewTabPage({ tabId, searchEngine, isPrivate }: { tabId: number; searchEngine: string; isPrivate: boolean }) {
  const api = window.callisto;
  const [sites, setSites] = useState<TopSite[] | null>(null);
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // En privado no se muestran los sitios más visitados (son del perfil, no de esta ventana)
  const load = () => {
    if (!isPrivate) void api.topSites().then(setSites);
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

        {sites && sites.length > 0 && (
          <section className="ntp-sites" aria-label="Sitios más visitados">
            {sites.map((s) => (
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
        {sites && sites.length === 0 && <p className="ntp-empty" data-testid="ntp-empty">Los sitios que visites seguido van a aparecer acá.</p>}

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
