import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import type { TabState } from '../../shared/ipc';
import { displayUrl } from '../../shared/omnibox';
import { GROUP_COLORS, type TabGroupState } from '../../shared/tab-groups';
import { CloseIcon, GlobeIcon, HistoryIcon, PlusIcon, SettingsIcon } from './icons';

const DRAG_TAB = 'application/x-callisto-tab';
const DRAG_GROUP = 'application/x-callisto-group';
const TAB_WIDTH = 220;
const CHIP_WIDTH = 120;

export function tabTitle(t: TabState): string {
  if (!t.url || t.url === 'about:blank') return 'Nueva pestaña';
  if (t.title) return t.title;
  if (t.url && t.url !== 'about:blank') return displayUrl(t.url);
  return 'Nueva pestaña';
}

interface Props {
  tabs: TabState[];
  activeId: number;
  favicons: Record<string, string>;
  groups: TabGroupState[];
}

type Dragging = { kind: 'tab'; id: number } | { kind: 'group'; id: number };

/** Dónde caería lo que se arrastra: posición en la lista completa y grupo al que entraría una pestaña. */
interface Drop {
  index: number;
  groupId: number | null;
}

export function TabStrip({ tabs, activeId, favicons, groups }: Props) {
  const api = window.callisto;
  const scroller = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  /** Dónde caería mientras se arrastra (posición 0..n en la lista completa de pestañas, y grupo). */
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropAt = drop?.index ?? null;
  const groupById = new Map(groups.map((g) => [g.id, g]));

  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  /**
   * Zona de cada grupo: su encabezado (mitad derecha) y sus pestañas. Una pestaña soltada ahí entra al grupo; soltada
   * sobre una pestaña sin grupo o sobre la mitad izquierda del encabezado, queda afuera.
   */
  const onDragOverTab = (e: DragEvent<HTMLElement>, index: number, groupId: number | null) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setDrop({ index: e.clientX < r.left + r.width / 2 ? index : index + 1, groupId: dragging.kind === 'tab' ? groupId : null });
  };

  /** Sobre el encabezado de un grupo (que va antes de su primera pestaña, la `index`). */
  const onDragOverChip = (e: DragEvent<HTMLElement>, index: number, groupId: number) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const inside = dragging.kind === 'tab' && e.clientX >= r.left + r.width / 2;
    setDrop({ index, groupId: inside ? groupId : null });
  };

  const onDrop = (e: DragEvent) => {
    if (!dragging || !drop) return;
    e.preventDefault();
    if (dragging.kind === 'group') {
      api.moveGroup(dragging.id, drop.index);
    } else {
      const from = tabs.findIndex((t) => t.id === dragging.id);
      const dragged = tabs[from];
      if (dragged) {
        const to = drop.index > from ? drop.index - 1 : drop.index;
        if (to !== from || drop.groupId !== dragged.groupId) api.moveTab(dragging.id, to, drop.groupId);
      }
    }
    setDragging(null);
    setDrop(null);
  };

  const endDrag = () => {
    setDragging(null);
    setDrop(null);
  };

  const visibleTabs = tabs.filter((t) => t.groupId === null || !groupById.get(t.groupId)?.collapsed).length;
  const chipCount = new Set(tabs.map((t) => t.groupId).filter((g) => g !== null)).size;

  return (
    <div
      className="tabstrip"
      onContextMenu={(e) => {
        e.preventDefault();
        api.showTabMenu(null);
      }}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('tabs')) api.newTab();
      }}
    >
      <div
        className="tabs"
        role="tablist"
        aria-label="Pestañas"
        ref={scroller}
        // Ancho ideal: 220 px por pestaña visible (+ los encabezados de grupo); si no entra, se achica.
        // (Es explícito porque las pestañas usan container queries, que no aportan ancho propio.)
        style={{ width: visibleTabs * TAB_WIDTH + chipCount * CHIP_WIDTH }}
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          if (dragging) e.preventDefault();
        }}
        onDrop={onDrop}
      >
        {tabs.map((t, i) => {
          const group = t.groupId !== null ? groupById.get(t.groupId) : undefined;
          const startsGroup = !!group && tabs[i - 1]?.groupId !== t.groupId;
          const hidden = !!group?.collapsed;
          const active = t.id === activeId;
          const icon = t.faviconKey ? favicons[t.faviconKey] : undefined;
          const title = tabTitle(t);
          const color = group ? GROUP_COLORS[group.color].hex : undefined;
          return (
            <Fragment key={t.id}>
              {startsGroup && group && (
                <div
                  className={`group-chip ${group.collapsed ? 'collapsed' : ''} ${group.title ? '' : 'untitled'} ${drop && drop.groupId === group.id && drop.index === i ? 'drop-join' : ''}`}
                  data-testid="group-chip"
                  data-group-id={group.id}
                  data-collapsed={group.collapsed}
                  style={{ ['--group' as string]: color }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!group.collapsed}
                  aria-label={`Grupo ${group.title || GROUP_COLORS[group.color].name}${group.collapsed ? ' (contraído)' : ''}`}
                  title={group.collapsed ? 'Expandir el grupo' : 'Contraer el grupo'}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_GROUP, String(group.id));
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging({ kind: 'group', id: group.id });
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => onDragOverChip(e, i, group.id)}
                  onClick={() => api.updateGroup(group.id, { collapsed: !group.collapsed })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') api.updateGroup(group.id, { collapsed: !group.collapsed });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    api.editGroup(group.id);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span className="group-title" data-testid="group-title">{group.title}</span>
                </div>
              )}
              {!hidden && (
                <div
                  role="tab"
                  aria-selected={active}
                  data-testid="tab"
                  data-tab-id={t.id}
                  data-active={active}
                  data-group-id={t.groupId ?? ''}
                  className={['tab', active ? 'active' : '', group ? 'grouped' : '', dropAt === i ? 'drop-before' : '', dropAt === i + 1 && i === tabs.length - 1 ? 'drop-after' : ''].join(' ')}
                  style={color ? { ['--group' as string]: color } : undefined}
                  title={t.url && t.url !== 'about:blank' ? `${title}\n${displayUrl(t.url)}` : title}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TAB, String(t.id));
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging({ kind: 'tab', id: t.id });
                  }}
                  onDragOver={(e) => onDragOverTab(e, i, t.groupId)}
                  onDragEnd={endDrag}
                  onMouseDown={(e) => {
                    if (e.button === 0 && !active) api.activateTab(t.id);
                    if (e.button === 1) e.preventDefault(); // sin el desplazamiento automático del clic medio
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) api.closeTab(t.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    api.showTabMenu(t.id);
                  }}
                >
                  <div className={`tab-inner ${active ? 'active' : ''}`}>
                    <span className="tab-icon" aria-hidden="true">
                      {t.isLoading ? (
                        <span className="spinner" data-testid="tab-spinner" />
                      ) : t.url.startsWith('callisto://history') ? (
                        <HistoryIcon />
                      ) : t.url.startsWith('callisto://settings') ? (
                        <SettingsIcon />
                      ) : icon ? (
                        <img src={icon} alt="" width={16} height={16} data-testid="tab-favicon" draggable={false} />
                      ) : (
                        <GlobeIcon />
                      )}
                    </span>
                    <span className="tab-title" data-testid="tab-title">{title}</span>
                    <button
                      className="tab-close"
                      data-testid="tab-close"
                      aria-label={`Cerrar ${title}`}
                      title="Cerrar pestaña (Ctrl+W)"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        api.closeTab(t.id);
                      }}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <button className="icon-button new-tab" data-testid="new-tab" aria-label="Nueva pestaña" title="Nueva pestaña (Ctrl+T)" onClick={() => api.newTab()}>
        <PlusIcon />
      </button>
    </div>
  );
}
