import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { BookmarksUiState } from '../../shared/ipc';
import { BAR_FOLDER_ID, type BookmarkEditorState, type BookmarkNode } from '../../shared/bookmarks';
import { ChevronDownIcon, FolderIcon, GlobeIcon } from './icons';

const DRAG_TYPE = 'application/x-callisto-bookmark';

function NodeIcon({ node }: { node: BookmarkNode }) {
  const [failed, setFailed] = useState(false);
  if (node.kind === 'folder') return <FolderIcon />;
  if (node.icon && !failed) return <img src={node.icon} alt="" width={16} height={16} onError={() => setFailed(true)} />;
  return <GlobeIcon />;
}

/**
 * Barra de favoritos. Lo que no entra se ofrece en el botón "»". Se reordena arrastrando; soltar sobre el centro de
 * una carpeta mueve el favorito adentro.
 */
export function BookmarksBar({ state }: { state: BookmarksUiState }) {
  const api = window.callisto;
  const listRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(state.bar.length);
  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; into: boolean } | null>(null);

  // Cuántos entran: se mide lo dibujado y se ocultan los que se pasan del ancho
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const limit = el.clientWidth;
      const items = [...el.querySelectorAll<HTMLElement>('[data-bookmark-index]')];
      let count = items.length;
      for (const item of items) {
        if (item.offsetLeft + item.offsetWidth > limit) {
          count = Number(item.dataset.bookmarkIndex);
          break;
        }
      }
      setVisibleCount(count);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.bar]);

  const onDragOver = (e: DragEvent<HTMLElement>, index: number, node: BookmarkNode) => {
    if (dragId === null || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (node.kind === 'folder' && node.id !== dragId && x > 0.25 && x < 0.75) setDrop({ index, into: true });
    else setDrop({ index: x < 0.5 ? index : index + 1, into: false });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (dragId === null || !drop) return;
    const from = state.bar.findIndex((n) => n.id === dragId);
    if (drop.into) {
      api.moveBookmark(dragId, state.bar[drop.index]!.id, 1e6);
    } else {
      const to = from >= 0 && drop.index > from ? drop.index - 1 : drop.index;
      if (from < 0 || to !== from) api.moveBookmark(dragId, BAR_FOLDER_ID, to);
    }
    setDragId(null);
    setDrop(null);
  };

  const open = (e: React.MouseEvent, node: BookmarkNode) => {
    if (node.kind === 'folder') return api.showBookmarkFolder(node.id);
    api.openBookmark(node.id, e.button === 1 || e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-window' : 'current');
  };

  return (
    <div
      className="bookmarks-bar"
      data-testid="bookmarks-bar"
      role="toolbar"
      aria-label="Barra de favoritos"
      onContextMenu={(e) => {
        e.preventDefault();
        api.showBookmarkMenu(null);
      }}
      onDragOver={(e) => {
        if (dragId !== null) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="bookmarks-list" ref={listRef}>
        {state.bar.length === 0 && (
          <span className="bookmarks-empty" data-testid="bookmarks-empty">
            Para tener tus sitios a mano, agregalos acá con la estrella de la barra de direcciones (Ctrl+D).
          </span>
        )}
        {state.bar.map((node, i) => (
          <button
            key={node.id}
            data-bookmark-index={i}
            data-testid="bookmark"
            data-bookmark-id={node.id}
            data-kind={node.kind}
            className={['bookmark', i >= visibleCount ? 'hidden' : '', drop && !drop.into && drop.index === i ? 'drop-before' : '', drop && !drop.into && drop.index === i + 1 && i === state.bar.length - 1 ? 'drop-after' : '', drop?.into && drop.index === i ? 'drop-into' : ''].join(' ')}
            title={node.kind === 'url' ? `${node.title}\n${node.url}` : node.title}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, String(node.id));
              e.dataTransfer.effectAllowed = 'move';
              setDragId(node.id);
            }}
            onDragOver={(e) => onDragOver(e, i, node)}
            onDragEnd={() => {
              setDragId(null);
              setDrop(null);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onClick={(e) => open(e, node)}
            onAuxClick={(e) => {
              if (e.button === 1 && node.kind === 'url') open(e, node);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              api.showBookmarkMenu(node.id);
            }}
          >
            <span className="bookmark-icon" aria-hidden="true">
              <NodeIcon node={node} />
            </span>
            <span className="bookmark-title">{node.title || node.url}</span>
            {node.kind === 'folder' && <ChevronDownIcon />}
          </button>
        ))}
      </div>
      {visibleCount < state.bar.length && (
        <button className="icon-button small bookmarks-overflow" data-testid="bookmarks-overflow" aria-label="Más favoritos" title="Más favoritos" onClick={() => api.showBookmarkOverflow(visibleCount)}>
          »
        </button>
      )}
    </div>
  );
}

/** Panel para agregar o editar un favorito o una carpeta (bajo la estrella o bajo la barra). */
export function BookmarkEditor({ editor, top, onBottom }: { editor: BookmarkEditorState; top: number; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(editor.title);
  const [url, setUrl] = useState(editor.url);
  const [parentId, setParentId] = useState(editor.parentId);

  useEffect(() => {
    setTitle(editor.title);
    setUrl(editor.url);
    setParentId(editor.parentId);
    // Sin desplazar el documento: la interfaz todavía no se extendió sobre la página y el navegador "scrollearía" para
    // mostrar el campo, corriendo de lugar la medición del panel
    nameRef.current?.focus({ preventScroll: true });
    nameRef.current?.select();
  }, [editor.id, editor.mode]); // otro favorito: se cargan sus datos

  // La interfaz se extiende sobre la página hasta el borde inferior del panel, también si el panel cambia de alto
  // (al terminar de dibujarse, al aparecer un mensaje de error…)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Respecto del documento (no de lo visible): robusto aunque algo desplace la vista
    const report = () => onBottom(el.getBoundingClientRect().bottom + window.scrollY);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onBottom(0);
    };
  }, [onBottom]);

  const heading =
    editor.mode === 'new-folder' ? 'Carpeta nueva' : editor.mode === 'new-page' ? 'Agregar favorito' : editor.kind === 'folder' ? 'Cambiar nombre de la carpeta' : editor.justAdded ? 'Favorito agregado' : 'Editar favorito';
  const showUrl = editor.kind === 'url' && (editor.anchor === 'bar' || editor.mode === 'new-page');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.bookmarkEditorSave({ title, url, parentId });
  };

  return (
    <form
      className={`flyout bookmark-editor anchor-${editor.anchor}`}
      ref={ref}
      style={{ top }}
      data-testid="bookmark-editor"
      aria-label={heading}
      onSubmit={submit}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          api.bookmarkEditorClose();
        }
      }}
    >
      <div className="flyout-title">{heading}</div>
      <label className="field">
        <span>Nombre</span>
        <input ref={nameRef} data-testid="bookmark-title" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {showUrl && (
        <label className="field">
          <span>Dirección</span>
          <input data-testid="bookmark-url" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Carpeta</span>
        <select data-testid="bookmark-folder" value={parentId} onChange={(e) => setParentId(Number(e.target.value))}>
          {editor.folders.map((f) => (
            <option key={f.id} value={f.id}>
              {'   '.repeat(f.depth) + f.title}
            </option>
          ))}
        </select>
      </label>
      {editor.error && (
        <p className="prompt-warning" role="alert" data-testid="bookmark-error">
          {editor.error}
        </p>
      )}
      <div className="prompt-buttons">
        <button type="submit" className="btn primary" data-testid="bookmark-save">
          {editor.mode === 'edit' ? 'Listo' : 'Guardar'}
        </button>
        <button type="button" className="btn" data-testid="bookmark-remove" onClick={() => api.bookmarkEditorRemove()}>
          {editor.mode === 'edit' ? 'Quitar' : 'Cancelar'}
        </button>
      </div>
    </form>
  );
}
