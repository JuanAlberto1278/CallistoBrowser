import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SecurityLevel } from '../../shared/url-security';
import { displayUrl } from '../../shared/omnibox';
import { FileIcon, LockIcon, SearchIcon, WarningIcon, ZoomIcon } from './icons';

const SECURITY: Record<SecurityLevel, { label: string; title: string; icon: () => React.JSX.Element; className: string }> = {
  none: { label: '', title: 'Escribí una dirección o una búsqueda', icon: SearchIcon, className: 'none' },
  secure: { label: '', title: 'Conexión segura (HTTPS)', icon: LockIcon, className: 'secure' },
  insecure: { label: 'No seguro', title: 'La conexión con este sitio no está cifrada (HTTP)', icon: WarningIcon, className: 'insecure' },
  file: { label: 'Archivo', title: 'Archivo local', icon: FileIcon, className: 'file' },
  error: { label: '', title: 'No se pudo cargar la página', icon: WarningIcon, className: 'error' },
};

interface Props {
  /** Pestaña activa: al cambiar, se descarta lo que se estaba escribiendo. */
  tabId: number;
  url: string;
  security: SecurityLevel;
  zoomPercent: number;
  focusSignal: number;
  onSubmit: (text: string) => void;
  onResetZoom: () => void;
}

export function AddressBar({ tabId, url, security, zoomPercent, focusSignal, onSubmit, onResetZoom }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(displayUrl(url));

  // Mientras el usuario no está escribiendo, la barra refleja la URL real de la página.
  useEffect(() => {
    if (!editing) setText(displayUrl(url));
  }, [url, editing]);

  // Otra pestaña: se muestra su dirección (lo escrito a medias en la anterior se descarta, sin perder el foco).
  useEffect(() => {
    setEditing(false);
    setText(displayUrl(url));
  }, [tabId]); // solo al cambiar de pestaña

  useEffect(() => {
    if (focusSignal === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = text.trim();
      if (!value) return;
      setEditing(false);
      input.current?.blur();
      onSubmit(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (editing) {
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
        spellCheck={false}
        autoComplete="off"
        placeholder="Buscá en Google o escribí una dirección"
        value={text}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onMouseUp={(e) => e.preventDefault()}
        onBlur={() => {
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
    </div>
  );
}
