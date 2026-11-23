import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AutofillPopupState } from '../../../shared/passwords';
import type { CallistoAutofillApi } from '../../../preload/autofill';
import { KeyIcon } from '../icons';
import '../styles.css';
import './autofill.css';

declare global {
  interface Window {
    callistoAutofill: CallistoAutofillApi;
  }
}

/** Menú de sugerencias de contraseñas: usuarios guardados para el sitio. Elegir uno rellena el formulario. */
function AutofillMenu() {
  const api = window.callistoAutofill;
  const [state, setState] = useState<AutofillPopupState>({ items: [], selected: -1 });
  const [hover, setHover] = useState(-1);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => api.onState((s) => {
    setState(s);
    setHover(-1);
  }), [api]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [state.selected]);

  return (
    <div className="autofill" role="listbox" aria-label="Contraseñas guardadas" data-testid="autofill">
      <ul ref={list}>
        {state.items.map((item, i) => (
          <li
            key={item.id}
            role="option"
            aria-selected={state.selected === i}
            data-selected={state.selected === i || hover === i}
            data-testid="autofill-item"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(-1)}
            // En mousedown: antes de que el campo de la página pierda el foco y el menú se cierre
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              api.choose(i);
            }}
          >
            <span className="autofill-icon"><KeyIcon /></span>
            <span className="autofill-text">
              <span className="autofill-user">{item.username || '(sin usuario)'}</span>
              <span className="autofill-pass" aria-label="contraseña guardada">••••••••</span>
            </span>
          </li>
        ))}
      </ul>
      <button
        className="autofill-manage"
        data-testid="autofill-manage"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          api.manage();
        }}
      >
        Administrar contraseñas…
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AutofillMenu />
  </StrictMode>,
);
