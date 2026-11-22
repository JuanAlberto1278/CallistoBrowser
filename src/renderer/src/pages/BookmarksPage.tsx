import { useCallback, useEffect, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react';
import { BAR_FOLDER_ID, ROOT_FOLDER_IDS, type BookmarkNode, type FolderOption } from '../../../shared/bookmarks';
import { CloseIcon, EditIcon, FolderIcon, GlobeIcon } from '../icons';

const DRAG_TYPE = 'application/x-callisto-bookmark';

function Icon({ node }: { node: BookmarkNode }) {
  if (node.kind === 'folder') return <FolderIcon />;
  return node.icon ? <img src={node.icon} alt="" width={16} height={16} /> : <GlobeIcon />;
}

/** Formulario en línea para agregar o editar (página: nombre + dirección; carpeta: nombre). */
function NodeForm({ initial, kind, onSave, onCancel }: { initial: { title: string; url: string }; kind: 'url' | 'folder'; onSave: (v: { title: string; url: string }) => Promise<string | undefined>; onCancel: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [url, setUrl] = useState(initial.url);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const err = await onSave({ title, url });
    if (err) setError(err);
  };
  return (
    <form className="bm-form" data-testid="bm-form" onSubmit={(e) => void submit(e)} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <input autoFocus data-testid="bm-form-title" placeholder="Nombre" value={title} onChange={(e) => setTitle(e.target.value)} />
      {kind === 'url' && <input data-testid="bm-form-url" placeholder="Dirección (https://…)" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />}
      <button type="submit" className="btn primary" data-testid="bm-form-save">
        Guardar
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancelar
      </button>
      {error && (
        <span className="bm-error" role="alert" data-testid="bm-form-error">
          {error}
        </span>
      )}
    </form>
  );
}

export function BookmarksPage() {
  const api = window.callistoInternal.bookmarks;
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [selected, setSelected] = useState(BAR_FOLDER_ID);
  const [items, setItems] = useState<BookmarkNode[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState<'url' | 'folder' | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [dropFolder, setDropFolder] = useState<number | null>(null);

  const load = useCallback(async () => {
    const f = await api.folders();
    setFolders(f);
    const sel = f.some((x) => x.id === selected) ? selected : BAR_FOLDER_ID;
    if (sel !== selected) setSelected(sel);
    setItems(query.trim() ? await api.search(query) : await api.children(sel));
  }, [api, selected, query]);

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 150 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Cambios hechos desde otra parte (la estrella, la barra): se ven al volver a esta pestaña
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && void load();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const searching = !!query.trim();
  const folderTitle = folders.find((f) => f.id === selected)?.title ?? '';

  const open = (e: MouseEvent, n: BookmarkNode) => {
    if (n.kind === 'folder') {
      setQuery('');
      setSelected(n.id);
      return;
    }
    if (!n.url) return;
    api.open(n.url, e.button === 1 || e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-window' : 'current');
  };

  const dropOnList = async (e: DragEvent) => {
    e.preventDefault();
    if (dragId === null || dropAt === null || searching) return;
    const from = items.findIndex((i) => i.id === dragId);
    const to = from >= 0 && dropAt > from ? dropAt - 1 : dropAt;
    setDragId(null);
    setDropAt(null);
    if (from >= 0 && to === from) return;
    await api.move(dragId, selected, to);
    await load();
  };

  const dropOnFolder = async (e: DragEvent, folderId: number) => {
    e.preventDefault();
    setDropFolder(null);
    if (dragId === null) return;
    const id = dragId;
    setDragId(null);
    const res = await api.move(id, folderId);
    if (!res.error) await load();
  };

  return (
    <div className="page bm-page">
      <div className="page-header">
        <h1>Favoritos</h1>
        <input className="search" type="search" data-testid="bm-search" aria-label="Buscar en favoritos" placeholder="Buscar en favoritos" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" data-testid="bm-add-page" disabled={searching} onClick={() => setAdding('url')}>
          Agregar página
        </button>
        <button className="btn" data-testid="bm-add-folder" disabled={searching} onClick={() => setAdding('folder')}>
          Agregar carpeta
        </button>
      </div>

      <div className="bm-layout">
        <nav className="card bm-tree" aria-label="Carpetas">
          {folders.map((f) => (
            <button
              key={f.id}
              className={`bm-folder ${f.id === selected && !searching ? 'selected' : ''} ${dropFolder === f.id ? 'drop-into' : ''}`}
              style={{ paddingLeft: 10 + f.depth * 16 }}
              data-testid="bm-tree-folder"
              data-folder-id={f.id}
              onClick={() => {
                setQuery('');
                setSelected(f.id);
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === f.id) return;
                e.preventDefault();
                setDropFolder(f.id);
              }}
              onDragLeave={() => setDropFolder(null)}
              onDrop={(e) => void dropOnFolder(e, f.id)}
            >
              <FolderIcon />
              <span>{f.title}</span>
            </button>
          ))}
        </nav>

        <section className="card bm-list" aria-label={searching ? 'Resultados' : folderTitle} onDragOver={(e) => dragId !== null && e.preventDefault()} onDrop={(e) => void dropOnList(e)}>
          <h2 className="day-title">{searching ? `Resultados para «${query.trim()}»` : folderTitle}</h2>
          {adding && (
            <NodeForm
              kind={adding}
              initial={{ title: '', url: '' }}
              onCancel={() => setAdding(null)}
              onSave={async (v) => {
                const res = await api.add(selected, v.title, adding === 'url' ? v.url : null);
                if (res.error) return res.error;
                setAdding(null);
                await load();
                return undefined;
              }}
            />
          )}
          {items.length === 0 && !adding && (
            <p className="empty" data-testid="bm-empty">
              {searching ? 'No se encontró nada.' : 'Esta carpeta está vacía.'}
            </p>
          )}
          {items.map((n, i) =>
            editing === n.id ? (
              <NodeForm
                key={n.id}
                kind={n.kind}
                initial={{ title: n.title, url: n.url ?? '' }}
                onCancel={() => setEditing(null)}
                onSave={async (v) => {
                  const res = await api.update(n.id, n.kind === 'url' ? v : { title: v.title });
                  if (res.error) return res.error;
                  setEditing(null);
                  await load();
                  return undefined;
                }}
              />
            ) : (
              <div
                key={n.id}
                className={`bm-row ${dropAt === i ? 'drop-before' : ''} ${dropAt === i + 1 && i === items.length - 1 ? 'drop-after' : ''}`}
                data-testid="bm-row"
                data-kind={n.kind}
                data-bookmark-id={n.id}
                draggable={!searching}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, String(n.id));
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(n.id);
                }}
                onDragOver={(e) => {
                  if (dragId === null || searching) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropAt(null);
                  setDropFolder(null);
                }}
              >
                <span className="visit-icon" aria-hidden="true">
                  <Icon node={n} />
                </span>
                <button className="bm-title" data-testid="bm-title" onClick={(e) => open(e, n)} onAuxClick={(e) => e.button === 1 && open(e, n)} onMouseDown={(e) => e.button === 1 && e.preventDefault()}>
                  {n.title || n.url}
                </button>
                <span className="bm-url">{n.kind === 'url' ? n.url : `${n.childCount ?? 0} elementos`}</span>
                {!ROOT_FOLDER_IDS.includes(n.id) && (
                  <span className="bm-actions">
                    <button className="icon-button" data-testid="bm-edit" aria-label={`Editar ${n.title}`} title="Editar" onClick={() => setEditing(n.id)}>
                      <EditIcon />
                    </button>
                    <button
                      className="icon-button"
                      data-testid="bm-delete"
                      aria-label={`Eliminar ${n.title}`}
                      title="Eliminar"
                      onClick={() => void api.remove(n.id).then(load)}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                )}
              </div>
            ),
          )}
        </section>
      </div>
    </div>
  );
}
