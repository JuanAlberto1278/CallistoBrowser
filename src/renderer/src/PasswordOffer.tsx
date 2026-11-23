import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { hostOf, type PasswordOffer } from '../../shared/passwords';
import { CloseIcon, KeyIcon } from './icons';

/**
 * "¿Guardar la contraseña?" después de un inicio de sesión: no roba el foco de la página. La contraseña nunca llega a
 * la interfaz (solo su largo, para los puntos); el usuario se puede corregir antes de guardar.
 */
export function PasswordOfferBubble({ offer, top, onBottom }: { offer: PasswordOffer; top: number; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLFormElement>(null);
  const [username, setUsername] = useState(offer.username);

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

  const update = offer.mode === 'update';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.answerPasswordOffer(offer.id, 'save', update ? undefined : username);
  };

  return (
    <form
      className="flyout password-offer"
      ref={ref}
      style={{ top }}
      data-testid="password-offer"
      data-mode={offer.mode}
      aria-label={update ? 'Actualizar la contraseña' : 'Guardar la contraseña'}
      onSubmit={submit}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          api.answerPasswordOffer(offer.id, 'dismiss');
        }
      }}
    >
      <div className="flyout-header">
        <span className="flyout-title password-offer-title">
          <KeyIcon />
          {update ? '¿Actualizar la contraseña?' : '¿Guardar la contraseña?'}
        </span>
        <button type="button" className="icon-button small" data-testid="password-offer-close" aria-label="Ahora no" title="Ahora no" onClick={() => api.answerPasswordOffer(offer.id, 'dismiss')}>
          <CloseIcon />
        </button>
      </div>
      <p className="password-offer-site" data-testid="password-offer-site">{hostOf(offer.origin)}</p>
      <label className="field">
        <span>Usuario</span>
        {update ? (
          <span className="password-offer-user" data-testid="password-offer-username">{offer.username || '(sin usuario)'}</span>
        ) : (
          <input data-testid="password-offer-username" value={username} maxLength={1024} spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        )}
      </label>
      <label className="field">
        <span>Contraseña</span>
        <span className="password-offer-dots" aria-label="contraseña oculta">{'•'.repeat(Math.max(4, offer.passwordLength))}</span>
      </label>
      <div className="prompt-buttons">
        <button type="submit" className="btn primary" data-testid="password-offer-save">
          {update ? 'Actualizar' : 'Guardar'}
        </button>
        {!update && (
          <button type="button" className="btn" data-testid="password-offer-never" onClick={() => api.answerPasswordOffer(offer.id, 'never')}>
            Nunca para este sitio
          </button>
        )}
      </div>
    </form>
  );
}
