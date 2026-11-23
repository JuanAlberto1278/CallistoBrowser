import { useEffect, useState } from 'react';

/** ¿Callisto es el navegador predeterminado? Elegirlo se hace en la Configuración de Windows. */
export function DefaultBrowserSection() {
  const api = window.callistoInternal.settings;
  const [status, setStatus] = useState<{ registered: boolean; isDefault: boolean } | null>(null);

  useEffect(() => {
    const load = () => void api.defaultBrowser().then(setStatus);
    load();
    // Al volver de la Configuración de Windows
    const onVisible = () => {
      if (!document.hidden) load();
    };
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api]);

  return (
    <section className="card" aria-labelledby="s-default">
      <h2 id="s-default">Navegador predeterminado</h2>
      <div className="row">
        <span data-testid="default-browser-status">
          {!status
            ? ''
            : status.isDefault
              ? 'Callisto es tu navegador predeterminado.'
              : status.registered
                ? 'Callisto no es tu navegador predeterminado.'
                : 'Callisto no está instalado con su instalador: Windows todavía no lo conoce como navegador.'}
        </span>
        {status && !status.isDefault && (
          <button className="btn primary" data-testid="default-browser-make" onClick={() => api.makeDefault()}>
            {status.registered ? 'Elegir en Windows…' : 'Abrir la configuración de Windows'}
          </button>
        )}
      </div>
      <p className="muted small">Windows no deja que un programa se ponga como predeterminado solo: se elige en Configuración de Windows &gt; Aplicaciones predeterminadas.</p>
    </section>
  );
}
