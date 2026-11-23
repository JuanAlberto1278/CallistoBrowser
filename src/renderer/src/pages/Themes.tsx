import { useState } from 'react';
import type { Settings } from '../../../shared/settings';
import { MAX_CUSTOM_THEMES, MAX_THEME_NAME, PRESET_THEMES, SYSTEM_THEME_ID, contrast, findTheme, type Theme, type ThemeColors, type ThemeMode } from '../../../shared/themes';

const COLOR_LABELS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'strip', label: 'Franja de pestañas' },
  { key: 'toolbar', label: 'Barra y pestaña activa' },
  { key: 'text', label: 'Texto e íconos' },
  { key: 'accent', label: 'Acento' },
  { key: 'field', label: 'Barra de direcciones y menús' },
  { key: 'border', label: 'Bordes' },
];

/** Miniatura de un navegador con los colores del tema. */
function Preview({ theme, large }: { theme: Theme; large?: boolean }) {
  if (!theme.colors) {
    return (
      <div className={`theme-preview system ${large ? 'large' : ''}`} aria-hidden="true">
        <div className="half light" />
        <div className="half dark" />
      </div>
    );
  }
  const c = theme.colors;
  return (
    <div className={`theme-preview ${large ? 'large' : ''}`} style={{ background: c.strip }} aria-hidden="true">
      <div className="tp-tab" style={{ background: c.toolbar, color: c.text }}>
        <span style={{ background: c.accent }} />
      </div>
      <div className="tp-toolbar" style={{ background: c.toolbar, borderColor: c.border }}>
        <div className="tp-address" style={{ background: c.field, borderColor: c.border, color: c.text }}>
          {large ? 'callisto://settings' : ''}
        </div>
        <span className="tp-accent" style={{ background: c.accent }} />
      </div>
    </div>
  );
}

function Editor({ initial, existing, onSave, onCancel }: { initial: Theme; existing: boolean; onSave: (t: Theme) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial.name);
  const [mode, setMode] = useState<ThemeMode>(initial.mode);
  const [colors, setColors] = useState<ThemeColors>(initial.colors!);
  const draft: Theme = { id: initial.id, name: name.trim() || 'Mi tema', mode, colors };
  const lowContrast = contrast(colors.text, colors.toolbar) < 4.5 || contrast(colors.text, colors.field) < 4.5;

  return (
    <div className="theme-editor" data-testid="theme-editor">
      <div className="theme-editor-form">
        <label className="row">
          <span>Nombre</span>
          <input data-testid="theme-name" value={name} maxLength={MAX_THEME_NAME} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="row">
          <span>Modo</span>
          <select data-testid="theme-mode" value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)}>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        {COLOR_LABELS.map(({ key, label }) => (
          <label className="row" key={key}>
            <span>{label}</span>
            <span className="color-field">
              <code>{colors[key]}</code>
              <input type="color" data-testid={`theme-color-${key}`} value={colors[key]} onChange={(e) => setColors({ ...colors, [key]: e.target.value })} />
            </span>
          </label>
        ))}
        {lowContrast && (
          <p className="theme-warning" role="status" data-testid="theme-contrast">
            El texto contrasta poco con el fondo: puede costar leerlo.
          </p>
        )}
        <div className="row theme-editor-buttons">
          <button className="btn primary" data-testid="theme-save" onClick={() => onSave(draft)}>
            {existing ? 'Guardar cambios' : 'Guardar y usar'}
          </button>
          <button className="btn" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
      <Preview theme={draft} large />
    </div>
  );
}

/** Apariencia: temas predeterminados, propios y el editor. */
export function ThemesSection({ settings, update }: { settings: Settings; update: (partial: Partial<Settings>) => void }) {
  const [editing, setEditing] = useState<{ theme: Theme; existing: boolean } | null>(null);
  const current = findTheme(settings.theme, settings.customThemes);
  const custom = settings.customThemes;

  const startNew = () => {
    const base = current.colors ? current : PRESET_THEMES.find((t) => t.id === 'light')!;
    setEditing({ theme: { id: `custom-${Date.now().toString(36)}`, name: 'Mi tema', mode: base.mode, colors: { ...base.colors! } }, existing: false });
  };
  const save = (t: Theme) => {
    const list = custom.some((x) => x.id === t.id) ? custom.map((x) => (x.id === t.id ? t : x)) : [...custom, t];
    update({ customThemes: list, theme: t.id });
    setEditing(null);
  };
  const remove = (id: string) => update({ customThemes: custom.filter((t) => t.id !== id), theme: settings.theme === id ? SYSTEM_THEME_ID : settings.theme });

  const card = (t: Theme, own: boolean) => (
    <div className={`theme-card ${t.id === settings.theme ? 'selected' : ''}`} key={t.id} data-testid="theme-card" data-theme-id={t.id}>
      <button className="theme-pick" aria-pressed={t.id === settings.theme} title={`Usar el tema ${t.name}`} onClick={() => update({ theme: t.id })}>
        <Preview theme={t} />
        <span className="theme-name">{t.name}</span>
      </button>
      {own && (
        <div className="theme-card-actions">
          <button className="btn small" data-testid="theme-edit" onClick={() => setEditing({ theme: t, existing: true })}>
            Editar
          </button>
          <button className="btn small danger" data-testid="theme-delete" onClick={() => remove(t.id)}>
            Eliminar
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section className="card" aria-labelledby="s-themes">
      <h2 id="s-themes">Apariencia</h2>
      <p className="muted">El tema cambia los colores de Callisto (pestañas, barra, páginas internas). El modo claro u oscuro también les llega a los sitios que lo soportan, como en Chrome.</p>
      <div className="theme-grid" data-testid="theme-presets">
        {PRESET_THEMES.map((t) => card(t, false))}
      </div>
      <h3 className="theme-subtitle">Tus temas</h3>
      {custom.length > 0 && <div className="theme-grid" data-testid="theme-custom">{custom.map((t) => card(t, true))}</div>}
      {editing ? (
        <Editor key={editing.theme.id} initial={editing.theme} existing={editing.existing} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <button className="btn" data-testid="theme-new" disabled={custom.length >= MAX_CUSTOM_THEMES} onClick={startNew}>
          Crear un tema…
        </button>
      )}
    </section>
  );
}
