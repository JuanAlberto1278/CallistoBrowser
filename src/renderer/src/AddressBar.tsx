import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SecurityLevel } from '../../shared/url-security';
import type { Suggestion, SuggestResult } from '../../shared/ipc';
import { displayUrl } from '../../shared/omnibox';
import { CallistoIcon, FileIcon, GlobeIcon, LockIcon, SearchIcon, StarIcon, WarningIcon, ZoomIcon } from './icons';

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
  /** Ctrl+Shift+A: la barra pasa a buscar entre las pestañas abiertas. */
  tabSearchSignal: number;
  searchEngine: string;
  /** Dónde termina el panel de sugerencias (0 = cerrado), para que la interfaz se extienda sobre la página. */
  onOverlay: (bottom: number) => void;
  /** Estrella de favoritos: llena si la página ya es favorito; oculta si la página no se puede guardar. */
  starred: boolean;
  starrable: boolean;
  /** Panel del sitio (1.5): abierto, y abrir/cerrar al tocar el candado (solo en páginas web). */
  siteOpen: boolean;
  onToggleSite: () => void;
  onSubmit: (text: string) => void;
  onResetZoom: () => void;
}

export function AddressBar({ tabId, url, security, zoomPercent, focusSignal, tabSearchSignal, searchEngine, onOverlay, starred, starrable, siteOpen, onToggleSite, onSubmit, onResetZoom }: Props) {
  const api = window.callisto;
  const input = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  /** Lo que escribió el usuario (sin el autocompletado). */
  const [text, setText] = useState(displayUrl(url));
  const [items, setItems] = useState<Suggestion[]>([]);
  /** Sugerencia elegida con el teclado (la que abre Enter). */
  const [selected, setSelected] = useState(0);
  /** Sugerencia bajo el mouse: solo se resalta; no cambia lo que abre Enter ni el texto de la barra. */
  const [hovered, setHovered] = useState<number | null>(null);
  const [inline, setInline] = useState<SuggestResult['inline']>(null);
  const [open, setOpen] = useState(false);
  /** Buscando entre las pestañas abiertas (Ctrl+Shift+A): la lista son pestañas y Enter va a la elegida. */
  const [tabMode, setTabMode] = useState(false);
  const seq = useRef(0);

  const close = () => {
    seq.current++;
    setTabMode(false);
    setOpen(false);
    setItems([]);
    setInline(null);
    setSelected(0);
    setHovered(null);
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

  const requestTabs = (typed: string) => {
    const id = ++seq.current;
    void api.suggestTabs(typed).then((res) => {
      if (id !== seq.current) return;
      setItems(res);
      setSelected(0);
      setOpen(true);
    });
  };

  useEffect(() => {
    if (tabSearchSignal === 0) return;
    setEditing(true);
    setText('');
    setInline(null);
    setHovered(null);
    setTabMode(true);
    input.current?.focus();
    requestTabs('');
  }, [tabSearchSignal]);

  // Lo que se ve en la barra: lo escrito + el autocompletado, o la sugerencia elegida con las flechas
  const chosen = selected > 0 ? items[selected] : undefined;
  const value = tabMode ? text : chosen ? (chosen.fill ?? chosen.url) : inline ? text + inline.completion : text;

  // El autocompletado queda seleccionado: seguir escribiendo lo reemplaza, Supr/Retroceso lo quita
  useLayoutEffect(() => {
    if (inline && !chosen && document.activeElement === input.current) input.current?.setSelectionRange(text.length, value.length);
  }, [inline, chosen, text, value]);

  // La interfaz se extiende sobre la página lo justo para mostrar el panel
  useLayoutEffect(() => {
    const el = dropdown.current;
    onOverlay(open && el ? el.getBoundingClientRect().bottom : 0);
  }, [open, items, onOverlay]);

  // La elegida con el teclado siempre a la vista (la lista de pestañas puede ser larga)
  useLayoutEffect(() => {
    dropdown.current?.querySelector('.suggestion.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

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

  /** Ir a una pestaña abierta en lugar de navegar. */
  const switchTo = (item: Suggestion) => {
    if (item.tabId === undefined) return;
    setEditing(false);
    setText(displayUrl(url));
    close();
    input.current?.blur();
    api.switchToTab(item.tabId);
  };

  const pick = (item: Suggestion) => (item.kind === 'tab' ? switchTo(item) : submit(item.url));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tabMode) {
        if (items[selected]) switchTo(items[selected]);
      } else if (chosen) pick(chosen);
      // Lo escrito ya está abierto en otra pestaña (va primero): Enter lleva a esa pestaña
      else if (items[0]?.kind === 'tab' && open) switchTo(items[0]);
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
      if (tabMode) {
        close();
        setEditing(false);
        setText(displayUrl(url));
        input.current?.blur();
      } else if (open || inline) {
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
      {/^https?:/i.test(url) && security !== 'none' ? (
        <button
          type="button"
          className={`security ${s.className}`}
          title={`${s.title} — Ver información del sitio`}
          aria-label="Ver información del sitio"
          aria-expanded={siteOpen}
          data-testid="security"
          data-level={security}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggleSite}
        >
          <Icon />
          {s.label && <span className="security-label">{s.label}</span>}
        </button>
      ) : (
        <span className={`security ${s.className}`} title={s.title} data-testid="security" data-level={security}>
          <Icon />
          {s.label && <span className="security-label">{s.label}</span>}
        </span>
      )}
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
        placeholder={tabMode ? 'Buscá entre las pestañas abiertas' : `Buscá en ${searchEngine} o escribí una dirección`}
        data-mode={tabMode ? 'tabs' : 'address'}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          // Solo se autocompleta mientras se agrega texto al final (no al borrar ni al editar en el medio)
          const appended = next.length > text.length && next.startsWith(text) && e.target.selectionStart === next.length;
          setEditing(true);
          setText(next);
          setInline(null);
          setSelected(0);
          if (tabMode) requestTabs(next);
          else requestSuggestions(next, appended);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onMouseUp={(e) => e.preventDefault()}
        onBlur={() => {
          const wasTabMode = tabMode;
          close();
          if (wasTabMode) {
            setEditing(false);
            setText(displayUrl(url));
          } else if (!editing) setText(displayUrl(url));
        }}
        onKeyDown={onKeyDown}
      />
      {zoomPercent !== 100 && (
        <button className="zoom-badge" data-testid="zoom" title={`Zoom: ${zoomPercent} %. Clic para restablecer (Ctrl+0)`} aria-label={`Zoom ${zoomPercent} %, restablecer`} onClick={onResetZoom}>
          <ZoomIcon />
          <span>{zoomPercent} %</span>
        </button>
      )}
      {starrable && (
        <button
          className={`star ${starred ? 'starred' : ''}`}
          data-testid="star"
          data-starred={starred}
          aria-pressed={starred}
          aria-label={starred ? 'Editar el favorito de esta página' : 'Agregar esta página a favoritos'}
          title={starred ? 'Editar el favorito (Ctrl+D)' : 'Agregar a favoritos (Ctrl+D)'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => api.toggleStar()}
        >
          <StarIcon filled={starred} />
        </button>
      )}
      {open && (
        <div className={`suggestions ${tabMode ? 'tab-mode' : ''}`} id="suggestions" role="listbox" ref={dropdown} data-testid="suggestions">
          {tabMode && items.length === 0 && (
            <div className="suggestion empty" data-testid="suggestions-empty">
              <span />
              <span className="suggestion-detail">{text.trim() ? 'Ninguna pestaña abierta coincide' : 'No hay otras pestañas abiertas'}</span>
            </div>
          )}
          {items.map((item, i) => (
            <div
              key={`${item.kind}:${item.tabId ?? item.url}`}
              role="option"
              aria-selected={i === selected}
              data-testid="suggestion"
              data-kind={item.kind}
              data-tab-id={item.tabId}
              className={`suggestion ${i === selected ? 'selected' : ''} ${i === hovered ? 'hovered' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // no sacar el foco de la barra
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => pick(item)}
            >
              <span className="suggestion-icon" aria-hidden="true">
                {item.kind === 'search' ? <SearchIcon /> : item.icon ? <img src={item.icon} alt="" width={16} height={16} /> : item.kind === 'bookmark' ? <StarIcon filled={false} /> : <GlobeIcon />}
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
