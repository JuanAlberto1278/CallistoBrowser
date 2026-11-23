import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExtensionInstallPrompt } from '../../shared/extensions';
import { WarningIcon } from './icons';

/**
 * Botones de las extensiones del perfil, en la barra. Los dibuja <browser-action-list> de electron-chrome-extensions
 * (íconos, insignias y popups). El clic derecho abre el menú de Callisto (en español) en lugar del de la librería.
 */
export function ExtensionActions({ partition }: { partition: string }) {
  const api = window.callisto;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // En captura: antes de que el botón (dentro del shadow DOM) abra el menú de la librería
    const onMenu = (e: MouseEvent) => {
      const button = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && n.tagName === 'BUTTON' && /^[a-p]{32}$/.test(n.id));
      e.preventDefault();
      e.stopPropagation();
      if (button) api.showExtensionMenu(button.id);
    };
    el.addEventListener('contextmenu', onMenu, true);
    return () => el.removeEventListener('contextmenu', onMenu, true);
  }, [api]);

  return createElement('browser-action-list', { ref, class: 'extension-actions', partition, alignment: 'bottom', 'data-testid': 'extension-actions' });
}

/** "¿Agregar la extensión?": lo que va a poder hacer y lo que no funciona en Callisto. */
export function ExtensionInstallDialog({ prompt, top, onBottom }: { prompt: ExtensionInstallPrompt; top: number; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLDivElement>(null);
  // Los botones se habilitan un instante después de aparecer: un clic que ya venía en camino no instala nada
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false);
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, [prompt.id]);

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
  }, [onBottom]);

  const required = prompt.unsupported.filter((u) => !u.optional);
  const optional = prompt.unsupported.filter((u) => u.optional);

  return (
    <div
      className="flyout extension-prompt"
      ref={ref}
      style={{ top }}
      role="alertdialog"
      aria-label={prompt.reenable ? `Activar ${prompt.name}` : `Agregar ${prompt.name}`}
      data-testid="extension-prompt"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') api.answerExtensionInstall(prompt.id, false);
      }}
    >
      <div className="extension-prompt-head">
        {prompt.icon ? <img src={prompt.icon} alt="" width={32} height={32} /> : <span className="extension-prompt-noicon" />}
        <div className="flyout-title" data-testid="extension-prompt-title">
          {prompt.reenable ? `¿Activar «${prompt.name}»?` : `¿Agregar «${prompt.name}»?`}
        </div>
      </div>
      {prompt.warnings.length > 0 ? (
        <>
          <p className="extension-prompt-label">Va a poder:</p>
          <ul className="extension-prompt-list" data-testid="extension-prompt-warnings">
            {prompt.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="extension-prompt-label">No pide permisos especiales.</p>
      )}
      {required.length > 0 && (
        <p className="prompt-warning" data-testid="extension-prompt-unsupported">
          <WarningIcon />
          <span>Callisto no tiene: {required.map((u) => u.what).join(', ')}. Esas funciones de la extensión no van a andar.</span>
        </p>
      )}
      {optional.length > 0 && <p className="extension-prompt-note">Funciones opcionales que tampoco están: {optional.map((u) => u.what).join(', ')}.</p>}
      <div className="prompt-buttons">
        <button className="btn primary" data-testid="extension-prompt-add" disabled={!armed} onClick={() => api.answerExtensionInstall(prompt.id, true)}>
          {prompt.reenable ? 'Activar extensión' : 'Agregar extensión'}
        </button>
        <button className="btn" data-testid="extension-prompt-cancel" onClick={() => api.answerExtensionInstall(prompt.id, false)}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
