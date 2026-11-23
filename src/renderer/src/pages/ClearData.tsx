import { useState } from 'react';
import type { ClearDataRequest, ClearPeriod } from '../../../shared/internal-api';

const PERIODS: Array<{ id: ClearPeriod; label: string }> = [
  { id: 'hour', label: 'Última hora' },
  { id: 'day', label: 'Últimas 24 horas' },
  { id: 'week', label: 'Últimos 7 días' },
  { id: 'month', label: 'Últimas 4 semanas' },
  { id: 'all', label: 'Todo' },
];

/** "Borrar datos de navegación": historial (por período), cookies y datos de sitios, caché. */
export function ClearDataPanel() {
  const api = window.callistoInternal.settings;
  const [req, setReq] = useState<ClearDataRequest>({ period: 'hour', history: true, siteData: false, cache: true });
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const nothing = !req.history && !req.siteData && !req.cache;

  const check = (key: 'history' | 'siteData' | 'cache', label: string, detail: string) => (
    <label className="check">
      <input type="checkbox" data-testid={`clear-${key}`} checked={req[key]} onChange={(e) => setReq({ ...req, [key]: e.target.checked })} />
      <span>
        {label}
        <br />
        <span className="muted small">{detail}</span>
      </span>
    </label>
  );

  return (
    <div className="clear-data" data-testid="clear-data">
      {check('history', 'Historial de navegación', 'Las páginas visitadas, en el período elegido.')}
      {check('siteData', 'Cookies y datos de sitios', 'Cierra la sesión en la mayoría de los sitios. Se borran enteros (sin importar el período); los datos de las extensiones se conservan.')}
      {check('cache', 'Imágenes y archivos en caché', 'Libera espacio; algunos sitios cargan más lento la próxima vez. Se borra entera.')}
      <div className="row">
        <label htmlFor="clear-period">Período del historial</label>
        <select id="clear-period" data-testid="clear-period" value={req.period} disabled={!req.history} onChange={(e) => setReq({ ...req, period: e.target.value as ClearPeriod })}>
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span className="muted small" role="status" data-testid="clear-status">
          {state === 'done' ? 'Listo: se borraron los datos elegidos.' : ''}
        </span>
        <button
          className="btn danger"
          data-testid="clear-run"
          disabled={nothing || state === 'busy'}
          onClick={() => {
            setState('busy');
            void api.clearData(req).then(() => setState('done'));
          }}
        >
          {state === 'busy' ? 'Borrando…' : 'Borrar datos'}
        </button>
      </div>
    </div>
  );
}
