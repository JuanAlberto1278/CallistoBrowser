import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SecurityLevel } from '../../shared/url-security';
import type { Suggestion, SuggestResult } from '../../shared/ipc';
import { displayUrl } from '../../shared/omnibox';
import { CallistoIcon, FileIcon, GlobeIcon, LockIcon, SearchIcon, WarningIcon, ZoomIcon } from './icons';

const SECURITY: Record<SecurityLevel, { label: string; title: string; icon: () => React.JSX.Element; className: string }> = {
  none: { label: '', title: 'Escribí una dirección o una búsqueda', icon: SearchIcon, className: 'none' },
  secure: { label: '', title: 'Conexión segura (HTTPS)', icon: LockIcon, className: 'secure' },
  insecure: { label: 'No seguro', title: 'La conexión con este sitio no está cifrada (HTTP)', icon: WarningIcon, className: 'insecure' },
  file: { label: 'Archivo', title: 'Archivo local', icon: FileIcon, className: 'file' },
  internal: { label: 'Callisto', title: 'Página de Callisto', icon: CallistoIcon, className: 'internal' },
  error: { label: '', title: 'No se pudo cargar la página', icon: WarningIcon, className: 'error' },
};

interface Props {
  /** Pestaña activa: al cambiar, se descarta lo que se estaba escribiendo. */
  tabId: number;
  url: string;
  security: SecurityLevel;
  zoomPercent: number;
  focusSignal: number;
  searchEngine: string;
  /** Alto de la interfaz sin el panel de sugerencias (para calcular cuánto se superpone a la página). */
  baseHeight: number;
  onSubmit: (text: string) => void;
  onResetZoom: () => void;
}

export function AddressBar({ tabId, url, security, zoomPercent, focusSignal, searchEngine, baseHeight, onSubmit, onResetZoom }: Props) {
  const api = window.callisto;
  const input = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  /** Lo que escribió el usuario (sin el autocompletado). */
  const [text, setText] = useState(displayUrl(url));
  const [items, setItems] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(0);
  const [inline, setInline] = useState<SuggestResult['inline']>(null);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  const close = () => {
    seq.current++;
    setOpen(false);
    setItems([]);
    setInline(null);
    setSelected(0);
  };

  // Mientras el usuario no está escribiendo, la barra refleja la URL real de la página.
  useEffect(() => {
    if (!editing) setText(displayUrl(url));
  }, [url, editing]);

  // Otra pestaña: se muestra su dirección (lo escrito a medias en la anterior se descarta, sin perder el foco).
  useEffect(() => {
    setEditing(false);
    setText(displayUrl(url));
    close();
  }, [tabId]); // solo al cambiar de pestaña

  useEffect(() => {
    if (focusSignal === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  // Lo que se ve en la barra: lo escrito + el autocompletado, o la sugerencia elegida con las flechas
  const chosen = selected > 0 ? items[selected] : undefined;
  const value = chosen ? (chosen.fill ?? chosen.url) : inline ? text + inline.completion : text;

  // El autocompletado queda seleccionado: seguir escribiendo lo reemplaza, Supr/Retroceso lo quita
  useLayoutEffect(() => {
    if (inline && !chosen && document.activeElement === input.current) input.current?.setSelectionRange(text.length, value.length);
  }, [inline, chosen, text, value]);

  // La interfaz se extiende sobre la página lo justo para mostrar el panel
  useLayoutEffect(() => {
    const el = dropdown.current;
    const h = open && el ? Math.max(0, Math.ceil(el.getBoundingClientRect().bottom) + 8 - baseHeight) : 0;
    api.setOverlayHeight(h);
  }, [open, items, baseHeight, api]);

  const requestSuggestions = (typed: string, allowInline: boolean) => {
    const id = ++seq.current;
    if (!typed.trim()) {
      close();
      return;
    }
    void api.suggest(typed).then((res) => {
      if (id !== seq.current) return;
      setItems(res.items);
      setInline(allowInline ? res.inline : null);
      setSelected(0);
      setOpen(res.items.length > 0);
    });
  };

  const submit = (target: string) => {
    const value = target.trim();
    if (!value) return;
    setEditing(false);
    close();
    input.current?.blur();
    onSubmit(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (chosen) submit(chosen.url);
      else if (inline) submit(inline.url);
      else submit(text);
    } else if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open || inline) {
        close();
      } else if (editing) {
        setEditing(false);
        setText(displayUrl(url));
        requestAnimationFrame(() => input.current?.select());
      } else {
        input.current?.blur();
      }
    }
  };

  const s = SECURITY[security];
  const Icon = s.icon;
  return (
    <div className="address-bar">
      <span className={`security ${s.className}`} title={s.title} data-testid="security" data-level={security}>
        <Icon />
        {s.label && <span className="security-label">{s.label}</span>}
      </span>
      <input
        ref={input}
        type="text"
        data-testid="address"
        aria-label="Barra de direcciones"
        aria-autocomplete="both"
        aria-expanded={open}
        aria-controls="suggestions"
        spellCheck={false}
        autoComplete="off"
        placeholder={`Buscá en ${searchEngine} o escribí una dirección`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // Solo se autocompleta mientras se agrega texto al final (no al borrar ni al editar en el medio)
          const appended = next.length > text.length && next.startsWith(text) && e.target.selectionStart === next.length;
          setEditing(true);
          setText(next);
          setInline(null);
          setSelected(0);
          requestSuggestions(next, appended);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onMouseUp={(e) => e.preventDefault()}
        onBlur={() => {
          close();
          if (!editing) setText(displayUrl(url));
        }}
        onKeyDown={onKeyDown}
      />
      {zoomPercent !== 100 && (
        <button className="zoom-badge" data-testid="zoom" title={`Zoom: ${zoomPercent} %. Clic para restablecer (Ctrl+0)`} aria-label={`Zoom ${zoomPercent} %, restablecer`} onClick={onResetZoom}>
          <ZoomIcon />
          <span>{zoomPercent} %</span>
        </button>
      )}
      {open && (
        <div className="suggestions" id="suggestions" role="listbox" ref={dropdown} data-testid="suggestions">
          {items.map((item, i) => (
            <div
              key={item.url}
              role="option"
              aria-selected={i === selected}
              data-testid="suggestion"
              data-kind={item.kind}
              className={`suggestion ${i === selected ? 'selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // no sacar el foco de la barra
              onMouseEnter={() => setSelected(i)}
              onClick={() => submit(item.url)}
            >
              <span className="suggestion-icon" aria-hidden="true">
                {item.kind === 'search' ? <SearchIcon /> : item.icon ? <img src={item.icon} alt="" width={16} height={16} /> : <GlobeIcon />}
              </span>
              <span className="suggestion-text">{item.text}</span>
              <span className="suggestion-detail">{item.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
