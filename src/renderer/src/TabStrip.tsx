import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { TabState } from '../../shared/ipc';
import { displayUrl } from '../../shared/omnibox';
import { CloseIcon, GlobeIcon, HistoryIcon, PlusIcon, SettingsIcon } from './icons';

const DRAG_TYPE = 'application/x-callisto-tab';
const TAB_WIDTH = 220;

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
}

export function TabStrip({ tabs, activeId, favicons }: Props) {
  const api = window.callisto;
  const scroller = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  /** Posición de inserción (0..n) mientras se arrastra una pestaña. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  const onDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (dragId === null || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? index : index + 1);
  };

  const onDrop = (e: DragEvent) => {
    if (dragId === null || dropAt === null) return;
    e.preventDefault();
    const from = tabs.findIndex((t) => t.id === dragId);
    const to = dropAt > from ? dropAt - 1 : dropAt;
    if (from >= 0 && to !== from) api.moveTab(dragId, to);
    setDragId(null);
    setDropAt(null);
  };

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
        // Ancho ideal: 220 px por pestaña; si no entra, la franja se achica y las pestañas con ella.
        // (Es explícito porque las pestañas usan container queries, que no aportan ancho propio.)
        style={{ width: tabs.length * TAB_WIDTH }}
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          if (dragId !== null) e.preventDefault();
        }}
        onDrop={onDrop}
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const icon = t.faviconKey ? favicons[t.faviconKey] : undefined;
          const title = tabTitle(t);
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              data-testid="tab"
              data-tab-id={t.id}
              data-active={active}
              className={['tab', active ? 'active' : '', dropAt === i ? 'drop-before' : '', dropAt === i + 1 && i === tabs.length - 1 ? 'drop-after' : ''].join(' ')}
              title={t.url && t.url !== 'about:blank' ? `${title}\n${displayUrl(t.url)}` : title}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, String(t.id));
                e.dataTransfer.effectAllowed = 'move';
                setDragId(t.id);
              }}
              onDragOver={(e) => onDragOver(e, i)}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
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
          );
        })}
      </div>
      <button className="icon-button new-tab" data-testid="new-tab" aria-label="Nueva pestaña" title="Nueva pestaña (Ctrl+T)" onClick={() => api.newTab()}>
        <PlusIcon />
      </button>
    </div>
  );
}
