import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PasswordEntry, PasswordsSnapshot } from '../../../shared/internal-api';
import { hostOf } from '../../../shared/passwords';
import { CopyIcon, EditIcon, EyeIcon, EyeOffIcon, KeyIcon, TrashIcon } from '../icons';

/** Una fila: sitio, usuario y contraseña (oculta hasta que Windows verifica la identidad). */
function PasswordRow({ entry, onChanged, onMessage }: { entry: PasswordEntry; onChanged: () => void; onMessage: (text: string) => void }) {
  const api = window.callistoInternal.passwords;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ username: string; password: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Al salir de la pestaña, lo que estaba a la vista se vuelve a ocultar
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setRevealed(null);
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  const run = async (op: () => Promise<{ password?: string; error?: string }>) => {
    setBusy(true);
    setError('');
    try {
      const r = await op();
      if (r.error) setError(r.error);
      return r;
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = async () => {
    if (revealed !== null) return setRevealed(null);
    const r = await run(() => api.reveal(entry.id));
    if (r.password !== undefined) setRevealed(r.password);
  };

  const copy = async () => {
    const r = await run(() => api.copy(entry.id));
    if (!r.error) onMessage(`Se copió la contraseña de ${entry.username || entry.host}.`);
  };

  const startEdit = async () => {
    const r = revealed !== null ? { password: revealed } : await run(() => api.reveal(entry.id));
    if (r.password !== undefined) setEditing({ username: entry.username, password: r.password });
  };

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const r = await run(() => api.update(entry.id, editing));
    if (r.error) return;
    setEditing(null);
    setRevealed(null);
    onChanged();
  };

  if (editing) {
    return (
      <form className="pw-row pw-editing" data-testid="password-edit" onSubmit={saveEdit} aria-label={`Editar la contraseña de ${entry.host}`}>
        <div className="pw-site">
          <span className="pw-host">{entry.host}</span>
        </div>
        <input data-testid="password-edit-username" aria-label="Usuario" value={editing.username} maxLength={1024} spellCheck={false} onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
        <input data-testid="password-edit-password" aria-label="Contraseña" value={editing.password} maxLength={4096} spellCheck={false} autoComplete="off" onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
        <div className="pw-actions visible">
          <button className="btn primary" type="submit" data-testid="password-edit-save" disabled={busy}>
            Guardar
          </button>
          <button className="btn" type="button" onClick={() => setEditing(null)}>
            Cancelar
          </button>
        </div>
        {error && <p className="pw-error" role="alert">{error}</p>}
      </form>
    );
  }

  return (
    <div className="pw-row" data-testid="password-row" data-id={entry.id}>
      <div className="pw-site">
        <span className="pw-icon" aria-hidden="true">
          {entry.icon ? <img src={entry.icon} alt="" width={16} height={16} /> : <KeyIcon />}
        </span>
        <span className="pw-host" title={entry.origin} data-testid="password-site">{entry.host}</span>
      </div>
      <span className="pw-user" data-testid="password-username">{entry.username || <span className="muted">(sin usuario)</span>}</span>
      <span className={`pw-secret ${revealed !== null ? 'revealed' : ''}`} data-testid="password-value">
        {revealed !== null ? revealed : '••••••••••'}
      </span>
      {confirmDelete ? (
        <div className="pw-actions visible">
          <span className="small">¿Eliminar?</span>
          <button
            className="btn danger"
            data-testid="password-delete-confirm"
            onClick={() => {
              void api.remove(entry.id).then(onChanged);
            }}
          >
            Eliminar
          </button>
          <button className="btn" onClick={() => setConfirmDelete(false)}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className="pw-actions">
          <button className="icon-btn" data-testid="password-reveal" disabled={busy} title={revealed !== null ? 'Ocultar' : 'Mostrar'} aria-label={revealed !== null ? 'Ocultar la contraseña' : 'Mostrar la contraseña'} onClick={() => void toggleReveal()}>
            {revealed !== null ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button className="icon-btn" data-testid="password-copy" disabled={busy} title="Copiar la contraseña" aria-label="Copiar la contraseña" onClick={() => void copy()}>
            <CopyIcon />
          </button>
          <button className="icon-btn" data-testid="password-edit-button" disabled={busy} title="Editar" aria-label="Editar" onClick={() => void startEdit()}>
            <EditIcon />
          </button>
          <button className="icon-btn" data-testid="password-delete" title="Eliminar" aria-label="Eliminar" onClick={() => setConfirmDelete(true)}>
            <TrashIcon />
          </button>
        </div>
      )}
      {error && <p className="pw-error" role="alert" data-testid="password-error">{error}</p>}
    </div>
  );
}

export function PasswordsPage() {
  const api = window.callistoInternal.passwords;
  const [query, setQuery] = useState('');
  const [snap, setSnap] = useState<PasswordsSnapshot | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(() => void api.list(query || undefined).then(setSnap), [api, query]);

  useEffect(() => {
    const t = setTimeout(load, query ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Volver a la pestaña: la lista se actualiza (por si se guardó algo desde otra)
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Contraseñas</h1>
        <input className="search" type="search" data-testid="passwords-search" aria-label="Buscar contraseñas" placeholder="Buscar por sitio o usuario" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {snap?.status === 'unavailable' && (
        <div className="card pw-banner" role="alert" data-testid="passwords-unavailable">
          El cifrado de Windows no está disponible en esta cuenta: Callisto no puede guardar contraseñas.
        </div>
      )}
      {snap?.status === 'unreadable' && (
        <div className="card pw-banner" role="alert" data-testid="passwords-unreadable">
          Las contraseñas guardadas en este perfil no se pueden descifrar con esta cuenta de Windows (por ejemplo, si la carpeta del perfil se copió desde otra cuenta). No se borraron; tampoco se guardan nuevas.
        </div>
      )}

      <section className="card" aria-label="Opciones">
        <label className="row">
          <span>
            Ofrecer guardar contraseñas
            <br />
            <span className="muted small">
              {snap?.isPrivate ? 'En las ventanas privadas nunca se ofrece guardar.' : 'Después de iniciar sesión en un sitio, Callisto pregunta si querés guardar la contraseña.'}
            </span>
          </span>
          <input
            type="checkbox"
            data-testid="passwords-offer"
            checked={!!snap?.offerToSave}
            disabled={!snap}
            onChange={(e) => {
              const on = e.target.checked;
              if (snap) setSnap({ ...snap, offerToSave: on });
              void api.setOfferToSave(on).then(load);
            }}
          />
        </label>
      </section>

      <section className="card pw-list" aria-label="Contraseñas guardadas">
        <h2>Contraseñas guardadas{snap && snap.entries.length > 0 ? ` (${snap.entries.length})` : ''}</h2>
        {snap && snap.entries.length === 0 && (
          <p className="empty" data-testid="passwords-empty">
            {query ? `No se encontró nada para «${query}».` : 'Todavía no hay contraseñas guardadas.'}
          </p>
        )}
        {snap?.entries.map((entry) => <PasswordRow key={`${entry.id}-${entry.updated}`} entry={entry} onChanged={load} onMessage={setMessage} />)}
      </section>

      {snap && snap.blocked.length > 0 && (
        <section className="card" aria-label="Sitios que nunca guardan">
          <h2>Nunca se guardan</h2>
          {snap.blocked.map((origin) => (
            <div className="row" key={origin} data-testid="passwords-blocked">
              <span title={origin}>{hostOf(origin)}</span>
              <button className="btn" data-testid="passwords-unblock" onClick={() => void api.unblock(origin).then(load)}>
                Quitar
              </button>
            </div>
          ))}
        </section>
      )}

      <p className="muted small pw-note">
        Las contraseñas se guardan cifradas en este equipo, y solo se pueden descifrar con tu cuenta de Windows. Para mostrar, copiar o editar una,
        Windows te pide verificar tu identidad (Windows Hello o la contraseña de tu cuenta).
      </p>
      <div className="pw-toast" role="status" aria-live="polite" data-testid="passwords-message">
        {message}
      </div>
    </div>
  );
}
