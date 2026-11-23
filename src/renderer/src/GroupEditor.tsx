import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GROUP_COLORS, GROUP_COLOR_IDS, type TabGroupState } from '../../shared/tab-groups';

/** Panel de un grupo (bajo su encabezado): nombre, color y acciones. */
export function GroupEditor({ group, top, onBottom }: { group: TabGroupState; top: number; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(group.title);
  const [left, setLeft] = useState(8);

  // Debajo del encabezado del grupo
  useLayoutEffect(() => {
    const chip = document.querySelector<HTMLElement>(`[data-testid="group-chip"][data-group-id="${group.id}"]`);
    const width = ref.current?.offsetWidth ?? 280;
    if (chip) setLeft(Math.max(8, Math.min(chip.getBoundingClientRect().left, window.innerWidth - width - 8)));
  }, [group.id]);

  useEffect(() => {
    setTitle(group.title);
    nameRef.current?.focus({ preventScroll: true });
    nameRef.current?.select();
  }, [group.id]); // otro grupo: se cargan sus datos

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

  return (
    <div
      className="flyout group-editor"
      ref={ref}
      style={{ top, left, right: 'auto' }}
      role="dialog"
      aria-label="Grupo de pestañas"
      data-testid="group-editor"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          api.editGroup(null);
        }
      }}
    >
      <input
        ref={nameRef}
        className="group-name"
        data-testid="group-name"
        placeholder="Nombre del grupo"
        aria-label="Nombre del grupo"
        maxLength={60}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          api.updateGroup(group.id, { title: e.target.value });
        }}
      />
      <div className="group-colors" role="radiogroup" aria-label="Color">
        {GROUP_COLOR_IDS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            aria-label={GROUP_COLORS[c].name}
            title={GROUP_COLORS[c].name}
            data-testid={`group-color-${c}`}
            className={`group-swatch ${group.color === c ? 'selected' : ''}`}
            style={{ background: GROUP_COLORS[c].hex }}
            onClick={() => api.updateGroup(group.id, { color: c })}
          />
        ))}
      </div>
      <div className="group-actions">
        <button data-testid="group-new-tab" onClick={() => api.groupAction(group.id, 'new-tab')}>
          Nueva pestaña en el grupo
        </button>
        <button data-testid="group-ungroup" onClick={() => api.groupAction(group.id, 'ungroup')}>
          Desagrupar
        </button>
        <button data-testid="group-close" onClick={() => api.groupAction(group.id, 'close')}>
          Cerrar grupo
        </button>
        <button data-testid="group-move" onClick={() => api.groupAction(group.id, 'move-to-window')}>
          Mover el grupo a una ventana nueva
        </button>
      </div>
    </div>
  );
}
