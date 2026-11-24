import { useEffect, useState } from 'react';
import { ThemesSection } from './Themes';
import { ClearDataPanel } from './ClearData';
import { DefaultBrowserSection } from './DefaultBrowser';
import { UpdatesRow } from './Updates';
import { CHANGELOG } from '../../../shared/changelog';
import { MemoryNow, NeverSleepSites } from './Performance';
import type { SettingsSnapshot } from '../../../shared/internal-api';
import type { SearchEngineId, Settings } from '../../../shared/settings';

export function SettingsPage() {
  const api = window.callistoInternal;
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);

  useEffect(() => {
    void api.settings.get().then(setSnap);
  }, [api]);

  if (!snap) return <div className="page" />;
  const { settings } = snap;
  // Se refleja al instante y después se guarda (el proceso principal devuelve lo que quedó guardado)
  const update = (partial: Partial<Settings>) => {
    setSnap({ ...snap, settings: { ...settings, ...partial } });
    void api.settings.set(partial).then(setSnap);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Configuración</h1>
      </div>

      <section className="card" aria-labelledby="s-search">
        <h2 id="s-search">Buscador</h2>
        <div className="row">
          <label htmlFor="engine">Buscador que usa la barra de direcciones</label>
          <select
            id="engine"
            data-testid="settings-engine"
            value={settings.searchEngine}
            onChange={(e) => update({ searchEngine: e.target.value as SearchEngineId })}
          >
            {snap.engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card" aria-labelledby="s-startup">
        <h2 id="s-startup">Al abrir Callisto</h2>
        <label className="radio">
          <input
            type="radio"
            name="startup"
            data-testid="settings-startup-restore"
            checked={settings.startup === 'restore'}
            onChange={() => update({ startup: 'restore' })}
          />
          Continuar donde lo dejé (las mismas ventanas y pestañas)
        </label>
        <label className="radio">
          <input
            type="radio"
            name="startup"
            data-testid="settings-startup-newtab"
            checked={settings.startup === 'newtab'}
            onChange={() => update({ startup: 'newtab' })}
          />
          Abrir una pestaña nueva
        </label>
      </section>

      <ThemesSection settings={settings} update={update} />

      <section className="card" aria-labelledby="s-performance">
        <h2 id="s-performance">Rendimiento</h2>
        <MemoryNow />
        <div className="row">
          <label htmlFor="sleep">Dormir las pestañas que no usás después de</label>
          <select id="sleep" data-testid="settings-sleep" value={settings.sleepTabsAfter} onChange={(e) => update({ sleepTabsAfter: Number(e.target.value) as Settings['sleepTabsAfter'] })}>
            <option value={5}>5 minutos</option>
            <option value={15}>15 minutos</option>
            <option value={30}>30 minutos</option>
            <option value={60}>1 hora</option>
            <option value={120}>2 horas</option>
            <option value={0}>Nunca</option>
          </select>
        </div>
        <p className="muted">
          Una pestaña dormida no usa memoria: queda en la barra (atenuada) y se vuelve a cargar al tocarla, en el mismo lugar de la página. Nunca se
          duermen la pestaña que estás viendo, las que reproducen sonido, cargan o tienen texto que escribiste. También podés dormir una pestaña desde su
          menú (clic derecho).
        </p>
        <NeverSleepSites settings={settings} update={update} />
      </section>

      <section className="card" aria-labelledby="s-appearance">
        <h2 id="s-appearance">Barra de favoritos</h2>
        <div className="row">
          <label htmlFor="bar">Mostrar la barra de favoritos</label>
          <select id="bar" data-testid="settings-bookmarks-bar" value={settings.bookmarksBar} onChange={(e) => update({ bookmarksBar: e.target.value as Settings['bookmarksBar'] })}>
            <option value="always">Siempre</option>
            <option value="newtab">Solo en las pestañas nuevas</option>
            <option value="never">Nunca</option>
          </select>
        </div>
        <div className="row">
          <span className="muted">Agregá, ordená y organizá tus favoritos en carpetas.</span>
          <button className="btn" onClick={() => api.openPage('bookmarks')}>
            Administrar favoritos
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="s-downloads">
        <h2 id="s-downloads">Descargas</h2>
        <div className="row">
          <div>
            <div>Carpeta de descargas</div>
            <div className="muted" data-testid="settings-download-dir">{snap.downloadDir}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!snap.downloadDirIsDefault && (
              <button className="btn" onClick={() => void api.settings.resetDownloadDir().then(setSnap)}>
                Usar Descargas
              </button>
            )}
            <button className="btn" data-testid="settings-download-dir-change" onClick={() => void api.settings.chooseDownloadDir().then(setSnap)}>
              Cambiar…
            </button>
          </div>
        </div>
        <p className="muted">Callisto te pregunta antes de guardar cada archivo. Con «Guardar como…» podés elegir otra carpeta en ese momento.</p>
      </section>

      <section className="card" aria-labelledby="s-passwords">
        <h2 id="s-passwords">Contraseñas</h2>
        <div className="row">
          <span className="muted">Mirá, editá o eliminá las contraseñas guardadas, y elegí si Callisto ofrece guardarlas.</span>
          <button className="btn" data-testid="settings-passwords" onClick={() => api.openPage('passwords')}>
            Administrar contraseñas
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="s-perms">
        <h2 id="s-perms">Permisos de sitios</h2>
        {snap.permissions.length === 0 ? (
          <p className="muted" data-testid="settings-no-permissions">
            Ningún sitio tiene permisos guardados. Cuando un sitio pida usar la cámara, el micrófono, tu ubicación o mostrarte
            notificaciones, Callisto te va a preguntar.
          </p>
        ) : (
          <table data-testid="settings-permissions">
            <thead>
              <tr>
                <th>Sitio</th>
                <th>Permiso</th>
                <th>Decisión</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snap.permissions.map((p) => (
                <tr key={`${p.origin} ${p.permission}`}>
                  <td>{p.origin}</td>
                  <td>{p.label}</td>
                  <td className={p.setting === 'allow' ? 'setting-allow' : 'setting-block'}>{p.setting === 'allow' ? 'Permitido' : 'Bloqueado'}</td>
                  <td>
                    <button className="btn" onClick={() => void api.settings.removePermission(p.origin, p.permission).then(setSnap)}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Al quitar una decisión, el sitio vuelve a preguntar la próxima vez.</p>
      </section>

      <section className="card" aria-labelledby="s-zoom">
        <h2 id="s-zoom">Zoom de sitios</h2>
        {snap.zoom.length === 0 ? (
          <p className="muted">Todos los sitios se muestran al 100 %.</p>
        ) : (
          <table data-testid="settings-zoom">
            <tbody>
              {snap.zoom.map((z) => (
                <tr key={z.host}>
                  <td>{z.host}</td>
                  <td>{z.percent} %</td>
                  <td>
                    <button className="btn" onClick={() => void api.settings.removeZoom(z.host).then(setSnap)}>
                      Restablecer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="s-history">
        <h2 id="s-history">Privacidad y datos</h2>
        <div className="row">
          <span className="muted">Las páginas visitadas se guardan 90 días.</span>
          <button className="btn" onClick={() => api.openPage('history')}>
            Ver el historial
          </button>
        </div>
        <h3 className="theme-subtitle">Borrar datos de navegación</h3>
        <ClearDataPanel />
      </section>

      <section className="card" aria-labelledby="s-more">
        <h2 id="s-more">Perfiles y extensiones</h2>
        <div className="row">
          <span className="muted">Cada perfil tiene su historial, favoritos, contraseñas, extensiones y sesión.</span>
          <button className="btn" data-testid="settings-profiles" onClick={() => api.openPage('profiles')}>
            Administrar perfiles
          </button>
        </div>
        <div className="row">
          <span className="muted">Extensiones instaladas desde la Chrome Web Store.</span>
          <button className="btn" data-testid="settings-extensions" onClick={() => api.openPage('extensions')}>
            Administrar extensiones
          </button>
        </div>
      </section>

      <DefaultBrowserSection />

      <section className="card" aria-labelledby="s-about">
        <h2 id="s-about">Acerca de Callisto</h2>
        <div className="row">
          <span>
            <strong data-testid="settings-version">Callisto {snap.about.version}</strong>
            <br />
            <span className="muted small">
              Chromium {snap.about.chromium} · Electron {snap.about.electron} · Node.js {snap.about.node}
            </span>
          </span>
        </div>
        <UpdatesRow />
        <h3 className="theme-subtitle">Novedades</h3>
        {CHANGELOG.map((entry, i) => (
          <details key={entry.version} open={i === 0} className="changelog" data-testid="changelog-entry">
            <summary>
              Versión {entry.version} <span className="muted small">({entry.date})</span>
            </summary>
            <ul>
              {entry.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </div>
  );
}
