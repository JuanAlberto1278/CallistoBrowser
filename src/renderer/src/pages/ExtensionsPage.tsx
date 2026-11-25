import { useCallback, useEffect, useState } from 'react';
import type { ExtensionsSnapshot } from '../../../shared/internal-api';
import type { ExtensionInfo } from '../../../shared/extensions';
import { TrashIcon } from '../icons';

function ExtensionCard({ ext, onChanged }: { ext: ExtensionInfo; onChanged: () => void }) {
  const api = window.callistoInternal.extensions;
  const [details, setDetails] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // El interruptor cambia en el acto; la lista se vuelve a pedir cuando el cambio terminó
  const [enabled, setEnabled] = useState(ext.enabled);
  useEffect(() => setEnabled(ext.enabled), [ext.enabled]);
  const required = ext.unsupported.filter((u) => !u.optional);

  return (
    <section className="card ext-card" data-testid="extension-card" data-id={ext.id} aria-label={ext.name}>
      <div className="ext-head">
        {ext.icon ? <img src={ext.icon} alt="" width={32} height={32} /> : <span className="ext-noicon" />}
        <div className="ext-text">
          <div className="ext-name">
            <span data-testid="extension-name">{ext.name}</span>
            <span className="muted small">{ext.version}</span>
          </div>
          <div className="muted small ext-desc">{ext.description}</div>
          {ext.error && (
            <div className="ext-error" role="alert" data-testid="extension-error">
              No se pudo cargar: {ext.error}
            </div>
          )}
          {required.length > 0 && <div className="ext-warn">Sin: {required.map((u) => u.what).join(', ')}</div>}
        </div>
        <label className="switch" title={enabled ? 'Desactivar' : 'Activar'}>
          <input
            type="checkbox"
            data-testid="extension-toggle"
            aria-label={`${enabled ? 'Desactivar' : 'Activar'} ${ext.name}`}
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              void api.setEnabled(ext.id, e.target.checked).then(onChanged);
            }}
          />
          <span />
        </label>
      </div>
      <div className="ext-actions">
        <button className="btn" data-testid="extension-details" aria-expanded={details} onClick={() => setDetails(!details)}>
          {details ? 'Ocultar detalles' : 'Detalles'}
        </button>
        {ext.hasOptions && (
          <button className="btn" data-testid="extension-options" disabled={!ext.loaded} onClick={() => api.options(ext.id)}>
            Opciones
          </button>
        )}
        {confirm ? (
          <>
            <span className="small">¿Quitar la extensión y sus datos?</span>
            <button className="btn danger" data-testid="extension-remove-confirm" onClick={() => void api.remove(ext.id).then(onChanged)}>
              Quitar
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <button className="btn danger" data-testid="extension-remove" onClick={() => setConfirm(true)}>
            <TrashIcon /> Quitar
          </button>
        )}
      </div>
      {details && (
        <div className="ext-details" data-testid="extension-details-panel">
          <div>
            <strong>Puede:</strong>
            {ext.warnings.length ? (
              <ul>
                {ext.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : (
              <span className="muted"> no pide permisos especiales.</span>
            )}
          </div>
          {ext.unsupported.length > 0 && (
            <div>
              <strong>No disponible en Callisto:</strong>
              <ul>
                {ext.unsupported.map((u) => (
                  <li key={u.permission}>
                    {u.what} <span className="muted small">({u.permission}{u.optional ? ', opcional' : ''})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="muted small">
            ID: {ext.id} ·{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); api.openStore(ext.id); }}>
              Ver en la Chrome Web Store
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

export function ExtensionsPage() {
  const api = window.callistoInternal.extensions;
  const [snap, setSnap] = useState<ExtensionsSnapshot | null>(null);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => void api.list().then(setSnap), [api]);
  useEffect(() => {
    load();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);


  return (
    <div className="page">
      <div className="page-header">
        <h1>Extensiones</h1>
        {snap?.available && (
          <>
            <button
              className="btn"
              data-testid="extensions-update"
              disabled={checking || !snap.items.length}
              onClick={() => {
                setChecking(true);
                setMessage('Buscando actualizaciones…');
                void api
                  .checkUpdates()
                  .then((r) => setMessage(r.updated ? `Se actualizaron ${r.updated} extensiones.` : 'Las extensiones están al día.'))
                  .finally(() => {
                    setChecking(false);
                    load();
                  });
              }}
            >
              Buscar actualizaciones
            </button>
            <button className="btn primary" data-testid="extensions-store" onClick={() => api.openStore()}>
              Abrir la Chrome Web Store
            </button>
          </>
        )}
      </div>
      <p className="muted small" role="status" data-testid="extensions-message">
        {message}
      </p>

      {snap && !snap.available && (
        <div className="card" data-testid="extensions-private">
          Las extensiones no funcionan en las ventanas privadas (como en Chrome y Edge, que las desactivan por defecto).
        </div>
      )}

      {snap?.available && snap.items.length === 0 && (
        <div className="card empty" data-testid="extensions-empty">
          Todavía no hay extensiones. Abrí la Chrome Web Store y usá «Agregar a Chrome»: Callisto te muestra qué va a poder hacer cada una antes de
          instalarla.
        </div>
      )}
      {snap?.items.map((ext) => <ExtensionCard key={`${ext.id}-${ext.updated}`} ext={ext} onChanged={load} />)}

    </div>
  );
}
