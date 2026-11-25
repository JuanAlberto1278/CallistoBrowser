import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SidePanelState } from '../../shared/ipc';
import { applyThemeVars } from '../../shared/themes';
import { CloseIcon } from './icons';

/**
 * Encabezado y borde del panel lateral de una extensión (callisto://ui/sidepanel.html, una vista propia detrás de la
 * página de la extensión): ícono y nombre, el botón de cerrar y el borde izquierdo para cambiar el ancho arrastrando.
 */
export function SidePanelChrome() {
  const api = window.callisto;
  const [state, setState] = useState<SidePanelState | null>(null);
  const drag = useRef<{ startX: number; startWidth: number; frame: number | null; next: number } | null>(null);

  useEffect(() => api.onSidePanel(setState), [api]);
  useLayoutEffect(() => {
    if (state) applyThemeVars(document.documentElement, state.theme.ui, state.theme.ui ? state.theme.mode : null);
  }, [state]);

  if (!state) return null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.screenX, startWidth: state.width, frame: null, next: state.width };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Hacia la izquierda, más ancho
    d.next = d.startWidth - (e.screenX - d.startX);
    if (d.frame === null)
      d.frame = requestAnimationFrame(() => {
        if (!drag.current) return;
        drag.current.frame = null;
        api.resizeSidePanel(drag.current.next);
      });
  };
  const onPointerUp = () => {
    if (drag.current) api.resizeSidePanel(drag.current.next);
    drag.current = null;
  };

  return (
    <div className="side-panel" data-testid="side-panel" data-extension={state.extensionId}>
      <div
        className="side-panel-edge"
        data-testid="side-panel-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="Cambiar el ancho del panel"
        title="Arrastrá para cambiar el ancho"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="side-panel-head">
        {state.icon ? <img src={state.icon} alt="" width={16} height={16} /> : <span className="side-panel-noicon" />}
        <span className="side-panel-name" data-testid="side-panel-name">
          {state.name}
        </span>
        <button className="icon-button small" data-testid="side-panel-close" aria-label="Cerrar el panel lateral" title="Cerrar el panel lateral" onClick={() => api.closeSidePanel()}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
