import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/updates';

const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'idle':
      return 'Callisto busca versiones nuevas solo, cada 6 horas.';
    case 'checking':
      return 'Buscando actualizaciones…';
    case 'up-to-date':
      return `Callisto está actualizado (revisado a las ${timeFmt.format(s.checkedAt)}).`;
    case 'downloading':
      return `Descargando la versión ${s.version}…`;
    case 'ready':
      return `La versión ${s.version} está lista para instalarse.`;
    case 'error':
      return `No se pudo buscar actualizaciones: ${s.message}.`;
  }
}

/** Actualizaciones de Callisto (en Acerca de). */
export function UpdatesRow() {
  const api = window.callistoInternal.settings;
  const [info, setInfo] = useState<{ enabled: boolean; status: UpdateStatus } | null>(null);
  const busy = info?.status.state === 'checking' || info?.status.state === 'downloading';

  useEffect(() => {
    void api.updateStatus().then(setInfo);
  }, [api]);
  // Mientras busca o descarga, el estado se vuelve a pedir
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void api.updateStatus().then(setInfo), 1000);
    return () => clearInterval(t);
  }, [api, busy]);

  if (!info) return null;
  if (!info.enabled) {
    return (
      <div className="row">
        <span className="muted" data-testid="update-status">Las actualizaciones funcionan en Callisto instalado (no en el modo de desarrollo).</span>
      </div>
    );
  }
  return (
    <div className="row">
      <span data-testid="update-status">{describe(info.status)}</span>
      {info.status.state === 'ready' ? (
        <button className="btn primary" data-testid="update-install" onClick={() => api.installUpdate()}>
          Reiniciar y actualizar
        </button>
      ) : (
        <button className="btn" data-testid="update-check" disabled={busy} onClick={() => void api.checkUpdate().then(setInfo)}>
          Buscar actualizaciones
        </button>
      )}
    </div>
  );
}
