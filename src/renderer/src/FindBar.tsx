import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import type { FindState } from '../../shared/ipc';
import { FIND_BAR_HEIGHT } from '../../shared/layout';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './icons';

interface Props {
  tabId: number;
  find: FindState;
  /** Contador de pedidos de foco (Ctrl+F) y el último ya atendido. */
  focusSignal: number;
  focusHandled: MutableRefObject<number>;
}

export function FindBar({ tabId, find, focusSignal, focusHandled }: Props) {
  const api = window.callisto;
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.query);

  // Al cambiar de pestaña, el campo muestra la búsqueda de esa pestaña
  useEffect(() => {
    setText(find.query);
  }, [tabId]); // solo al cambiar de pestaña: mientras se escribe manda el texto local

  useEffect(() => {
    if (focusSignal <= focusHandled.current) return;
    focusHandled.current = focusSignal;
    input.current?.focus();
    input.current?.select();
  }, [focusSignal, focusHandled]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text) api.find(text, !e.shiftKey, false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.closeFind();
    }
  };

  let status = '';
  if (find.query && find.searched) status = find.matches > 0 ? `${find.activeMatch} de ${find.matches}` : 'Sin resultados';

  return (
    <div className="find-bar" style={{ height: FIND_BAR_HEIGHT }} role="search" data-testid="find-bar">
      <div className={`find-field ${find.query && find.searched && find.matches === 0 ? 'no-results' : ''}`}>
        <input
          ref={input}
          type="search"
          data-testid="find-input"
          aria-label="Buscar en la página"
          placeholder="Buscar en la página"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            api.find(e.target.value, true, true);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="find-status" data-testid="find-status" aria-live="polite">{status}</span>
      </div>
      <button className="icon-button small" data-testid="find-prev" aria-label="Coincidencia anterior" title="Anterior (Mayús+Enter)" disabled={!text} onClick={() => api.find(text, false, false)}>
        <ChevronUpIcon />
      </button>
      <button className="icon-button small" data-testid="find-next" aria-label="Coincidencia siguiente" title="Siguiente (Enter)" disabled={!text} onClick={() => api.find(text, true, false)}>
        <ChevronDownIcon />
      </button>
      <button className="icon-button small" data-testid="find-close" aria-label="Cerrar búsqueda" title="Cerrar (Esc)" onClick={() => api.closeFind()}>
        <CloseIcon />
      </button>
    </div>
  );
}
