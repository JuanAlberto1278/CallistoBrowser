import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SiteAction, SiteInfo, SiteSettingEntry, SiteSettingValue } from '../../shared/ipc';

const VALUE_LABELS: Record<SiteSettingValue, string> = { ask: 'Preguntar', allow: 'Permitir', block: 'Bloquear' };

/** Qué significa cada ajuste, para la ayuda de la opción. */
const HINTS: Partial<Record<SiteSettingEntry['kind'], string>> = {
  popups: 'Bloqueadas: el sitio solo abre ventanas cuando hacés clic.',
  javascript: 'Bloqueado: muchas páginas dejan de funcionar.',
  images: 'Bloqueadas: la página carga sin imágenes.',
};

function SettingRow({ entry, onChange }: { entry: SiteSettingEntry; onChange: (value: SiteSettingValue) => void }) {
  const options: SiteSettingValue[] = entry.defaultValue === 'ask' ? ['ask', 'allow', 'block'] : ['allow', 'block'];
  return (
    <label className="site-row" title={HINTS[entry.kind]}>
      <span className="site-row-label">{entry.label}</span>
      <select data-testid={`site-setting-${entry.kind}`} value={entry.value} onChange={(e) => onChange(e.target.value as SiteSettingValue)}>
        {options.map((v) => (
          <option key={v} value={v}>
            {VALUE_LABELS[v]}
            {v === entry.defaultValue && entry.defaultValue !== 'ask' ? ' (predeterminado)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Panel del sitio (1.5), bajo el candado: conexión, permisos y ajustes del sitio, zoom, "no dormir", contraseñas y
 * borrar sus datos. Todo actúa sobre el sitio de la pestaña activa; los cambios se guardan al instante.
 */
export function SitePanel({ top, left, url, zoomPercent, onClose, onBottom }: { top: number; left: number; url: string; zoomPercent: number; onClose: () => void; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<SiteInfo | null | undefined>(undefined);
  /** Cambió algo que se aplica al recargar (JavaScript, imágenes, datos borrados). */
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);

  // Al abrir y cuando la pestaña cambia de página o de zoom (Ctrl+rueda), datos frescos
  useEffect(() => {
    let alive = true;
    void api.siteInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [api, url, zoomPercent]);

  // Otro sitio: lo pendiente era del anterior
  const origin = info?.origin;
  useEffect(() => {
    setNeedsReload(false);
    setConfirmClear(false);
    setCleared(false);
  }, [origin]);

  useEffect(() => {
    if (info === null) onClose(); // la pestaña ya no muestra una página web
  }, [info, onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onBottom(el.getBoundingClientRect().bottom + window.scrollY);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onBottom(0);
    };
  }, [onBottom, info]);

  // Clic en la página (la interfaz pierde el foco) o Esc: se cierra
  useEffect(() => {
    const onBlur = () => onClose();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [onClose]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  if (!info) return null;

  const change = (entry: SiteSettingEntry, value: SiteSettingValue) => {
    if (entry.kind === 'javascript' || entry.kind === 'images') setNeedsReload(true);
    const patch = (list: SiteSettingEntry[]) => list.map((x) => (x.kind === entry.kind ? { ...x, value } : x));
    setInfo({ ...info, prompts: patch(info.prompts), content: patch(info.content) });
    void api.setSiteSetting(entry.kind, value === entry.defaultValue ? 'default' : value).then((i) => i && setInfo(i));
  };
  const act = (action: SiteAction) => api.siteAction(action).then((i) => (i ? setInfo(i) : undefined));

  const secure = info.security === 'secure';
  return (
    <div
      className="flyout site-panel"
      ref={ref}
      tabIndex={-1}
      style={{ top, left, right: 'auto' }}
      role="dialog"
      aria-label={`Información del sitio ${info.host}`}
      data-testid="site-panel"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="site-host" data-testid="site-host">
        {info.host}
      </div>
      <div className={`site-connection ${secure ? 'secure' : 'insecure'}`} data-testid="site-connection">
        <strong>{secure ? 'La conexión es segura' : 'La conexión no es segura'}</strong>
        <span className="muted">
          {secure
            ? 'Lo que envíes a este sitio (como contraseñas o tarjetas) viaja cifrado.'
            : 'No escribas datos sensibles en este sitio: alguien en la red podría verlos o cambiarlos.'}
        </span>
      </div>

      {needsReload && (
        <div className="site-reload" data-testid="site-reload-hint">
          <span>Recargá la página para aplicar los cambios.</span>
          <button
            className="btn primary"
            data-testid="site-reload"
            onClick={() => {
              setNeedsReload(false);
              void act('reload');
            }}
          >
            Recargar
          </button>
        </div>
      )}

      <div className="site-section-title">Permisos</div>
      {info.prompts.map((p) => (
        <SettingRow key={p.kind} entry={p} onChange={(v) => change(p, v)} />
      ))}
      <div className="site-section-title">Contenido</div>
      {info.content.map((p) => (
        <SettingRow key={p.kind} entry={p} onChange={(v) => change(p, v)} />
      ))}

      <div className="site-row">
        <span className="site-row-label">Zoom</span>
        <span className="site-zoom">
          <button className="icon-button small" aria-label="Alejar" title="Alejar" data-testid="site-zoom-out" onClick={() => void act('zoom-out')}>
            −
          </button>
          <span data-testid="site-zoom">{info.zoomPercent} %</span>
          <button className="icon-button small" aria-label="Acercar" title="Acercar" data-testid="site-zoom-in" onClick={() => void act('zoom-in')}>
            +
          </button>
          <button className="btn" data-testid="site-zoom-reset" disabled={info.zoomPercent === 100} onClick={() => void act('zoom-reset')}>
            Restablecer
          </button>
        </span>
      </div>

      {info.neverSleep && (
        <label className="site-row site-check">
          <input
            type="checkbox"
            data-testid="site-never-sleep"
            checked={info.neverSleep.listed}
            onChange={() => {
              // Se refleja al instante (el proceso principal devuelve lo que quedó guardado)
              setInfo({ ...info, neverSleep: { ...info.neverSleep!, listed: !info.neverSleep!.listed } });
              void act('toggle-never-sleep');
            }}
          />
          <span>No dormir nunca las pestañas de {info.neverSleep.site}</span>
        </label>
      )}

      {info.passwords > 0 && (
        <div className="site-row">
          <span className="site-row-label" data-testid="site-passwords">
            {info.passwords === 1 ? '1 contraseña guardada' : `${info.passwords} contraseñas guardadas`}
          </span>
          <button className="link-button" data-testid="site-open-passwords" onClick={() => void act('open-passwords')}>
            Ver contraseñas
          </button>
        </div>
      )}

      <div className="site-clear">
        {cleared ? (
          <span className="muted" data-testid="site-cleared">
            Se borraron las cookies y los datos de {info.host}.
          </span>
        ) : confirmClear ? (
          <>
            <span>
              ¿Borrar las cookies, el almacenamiento y la caché de <strong>{info.host}</strong>? Puede que tengas que volver a iniciar sesión.
            </span>
            <span className="site-clear-actions">
              <button
                className="btn danger"
                data-testid="site-clear-confirm"
                onClick={() => {
                  void act('clear-data').then(() => {
                    setCleared(true);
                    setNeedsReload(true);
                  });
                }}
              >
                Borrar
              </button>
              <button className="btn" onClick={() => setConfirmClear(false)}>
                Cancelar
              </button>
            </span>
          </>
        ) : (
          <button className="btn" data-testid="site-clear" onClick={() => setConfirmClear(true)}>
            Borrar los datos de este sitio…
          </button>
        )}
      </div>

      <button className="flyout-footer" data-testid="site-open-settings" onClick={() => void act('open-settings').then(onClose)}>
        Configuración de sitios
      </button>
    </div>
  );
}
