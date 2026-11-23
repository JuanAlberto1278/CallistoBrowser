import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ProfilesSnapshot } from '../../../shared/internal-api';
import type { ProfileColor } from '../../../shared/profiles';

function ColorPicker({ colors, value, onChange }: { colors: ProfilesSnapshot['colors']; value: ProfileColor; onChange: (c: ProfileColor) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color">
      {colors.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={c.id === value}
          aria-label={c.name}
          title={c.name}
          data-testid={`color-${c.id}`}
          className={`swatch ${c.id === value ? 'selected' : ''}`}
          style={{ background: c.hex }}
          onClick={() => onChange(c.id)}
        />
      ))}
    </div>
  );
}

function Avatar({ name, hex }: { name: string; hex: string }) {
  return (
    <span className="avatar" style={{ background: hex }} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function ProfilesPage() {
  const api = window.callistoInternal.profiles;
  const [snap, setSnap] = useState<ProfilesSnapshot | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<ProfileColor>('green');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState<ProfileColor>('blue');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => void api.list().then(setSnap), [api]);
  useEffect(() => {
    load();
    const refresh = () => document.visibilityState === 'visible' && load();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  if (!snap) return <div className="page" />;
  const hex = (c: ProfileColor) => snap.colors.find((x) => x.id === c)?.hex ?? '#888';

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const res = await api.create(name, color);
    if (res.error) return setError(res.error);
    setName('');
    setError(null);
    load();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Perfiles</h1>
      </div>
      <p className="muted intro">
        Cada perfil tiene su propio historial, favoritos, cookies, sesiones iniciadas y configuración, y abre sus propias ventanas. Sirven, por
        ejemplo, para separar el trabajo de lo personal.
      </p>

      <section className="card" aria-label="Tus perfiles">
        {snap.profiles.map((p) =>
          editing === p.id ? (
            <form
              key={p.id}
              className="profile-row editing"
              data-testid="profile-edit"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await api.update(p.id, { name: editName, color: editColor });
                if (res.error) return setError(res.error);
                setEditing(null);
                load();
              }}
            >
              <Avatar name={editName || p.name} hex={hex(editColor)} />
              <input autoFocus data-testid="profile-edit-name" value={editName} maxLength={40} onChange={(e) => setEditName(e.target.value)} />
              <ColorPicker colors={snap.colors} value={editColor} onChange={setEditColor} />
              <button className="btn primary" type="submit" data-testid="profile-edit-save">
                Guardar
              </button>
              <button className="btn" type="button" onClick={() => setEditing(null)}>
                Cancelar
              </button>
            </form>
          ) : (
            <div key={p.id} className="profile-row" data-testid="profile-row" data-profile-id={p.id}>
              <Avatar name={p.name} hex={hex(p.color)} />
              <div className="profile-text">
                <div className="profile-name" data-testid="profile-name">
                  {p.name} {p.current && <span className="tag">Este perfil</span>}
                </div>
                <div className="muted small">{p.windows === 0 ? 'Sin ventanas abiertas' : p.windows === 1 ? '1 ventana abierta' : `${p.windows} ventanas abiertas`}</div>
              </div>
              {!p.current && (
                <button className="btn" data-testid="profile-open" onClick={() => api.open(p.id)}>
                  Abrir
                </button>
              )}
              <button
                className="btn"
                data-testid="profile-edit-start"
                onClick={() => {
                  setEditing(p.id);
                  setEditName(p.name);
                  setEditColor(p.color);
                }}
              >
                Editar
              </button>
              {snap.profiles.length > 1 && (
                <button
                  className="btn danger"
                  data-testid="profile-remove"
                  onClick={async () => {
                    const res = await api.remove(p.id);
                    if (res.error) setError(res.error);
                    load();
                  }}
                >
                  Eliminar
                </button>
              )}
            </div>
          ),
        )}
      </section>

      <section className="card" aria-labelledby="new-profile">
        <h2 id="new-profile">Agregar perfil</h2>
        <form className="profile-row new" onSubmit={(e) => void create(e)}>
          <Avatar name={name || '?'} hex={hex(color)} />
          <input data-testid="profile-new-name" placeholder="Nombre (por ejemplo, Trabajo)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <ColorPicker colors={snap.colors} value={color} onChange={setColor} />
          <button className="btn primary" type="submit" data-testid="profile-create">
            Crear y abrir
          </button>
        </form>
        {error && (
          <p className="bm-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
