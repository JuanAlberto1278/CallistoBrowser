import { webContents as allWebContents } from 'electron';
import type { ExtensionManager } from './manager';
import type { BookmarkTree } from '../bookmark-store';
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, type BookmarkNode } from '../../shared/bookmarks';
import { isGroupColor, type TabGroupState } from '../../shared/tab-groups';
import { Tab } from '../tab';
import type { BrowserWindowController } from '../window';

// chrome.bookmarks y chrome.tabGroups (+ chrome.tabs.group/ungroup) sobre los favoritos y los grupos de Callisto (V0.10).
// Se registran en el router de electron-chrome-extensions: llegan por el mismo canal que el resto de las APIs y el
// router exige que la extensión esté cargada en el perfil y tenga el permiso ("bookmarks" / "tabGroups").
// El lado de las extensiones está en src/preload/extension-apis.ts.

type TreeNode = { id: string; parentId?: string; index?: number; title: string; url?: string; dateAdded?: number; children?: TreeNode[] };

const ROOT_ID = '0';

export interface CallistoApiDeps {
  /** Ventanas del perfil (para los grupos). */
  windows(): BrowserWindowController[];
}

export function registerCallistoApis(manager: ExtensionManager, deps: CallistoApiDeps): void {
  const profile = manager.profile;
  const store = profile.bookmarks;
  const handle = manager.router.handle.bind(manager.router);
  const changed = () => profile.emit('bookmarks-changed');

  // ------------------------------------------------------------ chrome.bookmarks

  const toNode = (n: BookmarkNode, deep: boolean): TreeNode => {
    const node: TreeNode = { id: String(n.id), parentId: n.parentId === null ? ROOT_ID : String(n.parentId), index: n.position, title: n.title, dateAdded: store.created(n.id) };
    if (n.kind === 'url' && n.url) node.url = n.url;
    else if (deep) node.children = store.children(n.id).map((c) => toNode(c, true));
    return node;
  };
  const treeToNode = (t: BookmarkTree): TreeNode => ({
    id: String(t.id),
    parentId: t.parentId === null ? ROOT_ID : String(t.parentId),
    index: t.position,
    title: t.title,
    dateAdded: t.created,
    ...(t.kind === 'url' && t.url ? { url: t.url } : { children: (t.children ?? []).map(treeToNode) }),
  });
  const root = (deep: boolean): TreeNode => ({
    id: ROOT_ID,
    title: '',
    dateAdded: 0,
    ...(deep ? { children: [BAR_FOLDER_ID, OTHER_FOLDER_ID].map((id) => toNode(store.get(id)!, true)) } : {}),
  });
  const parseId = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid bookmark id.');
    return n;
  };
  const nodeOf = (v: unknown, deep = false): TreeNode => {
    const id = parseId(v);
    if (id === 0) return root(deep);
    const n = store.get(id);
    if (!n) throw new Error("Can't find bookmark for id.");
    return toNode(n, deep);
  };
  const opts = { permission: 'bookmarks' };

  handle('bookmarks.get', (_e, ids) => (Array.isArray(ids) ? ids : [ids]).map((id) => nodeOf(id)), opts);
  handle('bookmarks.getChildren', (_e, id) => {
    const n = parseId(id);
    return n === 0 ? root(true).children!.map((c) => ({ ...c, children: undefined })) : store.children(n).map((c) => toNode(c, false));
  }, opts);
  handle('bookmarks.getTree', () => [root(true)], opts);
  handle('bookmarks.getSubTree', (_e, id) => [nodeOf(id, true)], opts);
  handle('bookmarks.getRecent', (_e, count) => store.recent(Math.max(1, Math.min(Number(count) || 1, 1000))).map((n) => toNode(n, false)), opts);
  handle('bookmarks.search', (_e, q) => {
    const query = typeof q === 'string' ? q : q && typeof q === 'object' ? String((q as { query?: unknown; title?: unknown; url?: unknown }).query ?? (q as { title?: unknown }).title ?? (q as { url?: unknown }).url ?? '') : '';
    return query.trim() ? store.search(query.slice(0, 1000)).map((n) => toNode(n, false)) : [];
  }, opts);
  handle('bookmarks.create', (_e, details) => {
    const d = (details ?? {}) as { parentId?: unknown; index?: unknown; title?: unknown; url?: unknown };
    const parent = d.parentId === undefined ? OTHER_FOLDER_ID : parseId(d.parentId);
    const index = typeof d.index === 'number' ? d.index : undefined;
    const title = typeof d.title === 'string' ? d.title : '';
    const id = typeof d.url === 'string' && d.url ? store.addUrl(parent, title, d.url, index) : store.addFolder(parent, title, index);
    changed();
    return nodeOf(id);
  }, opts);
  handle('bookmarks.update', (_e, id, changes) => {
    const c = (changes ?? {}) as { title?: unknown; url?: unknown };
    store.update(parseId(id), { title: typeof c.title === 'string' ? c.title : undefined, url: typeof c.url === 'string' ? c.url : undefined });
    changed();
    return nodeOf(id);
  }, opts);
  handle('bookmarks.move', (_e, id, destination) => {
    const d = (destination ?? {}) as { parentId?: unknown; index?: unknown };
    const n = parseId(id);
    const current = store.get(n);
    if (!current) throw new Error("Can't find bookmark for id.");
    store.move(n, d.parentId === undefined ? current.parentId! : parseId(d.parentId), typeof d.index === 'number' ? d.index : undefined);
    changed();
    return nodeOf(n);
  }, opts);
  handle('bookmarks.remove', (_e, id) => {
    const n = parseId(id);
    const node = store.get(n);
    if (node?.kind === 'folder' && store.children(n).length) throw new Error("Can't remove non-empty folder (use recursive to force).");
    store.remove(n);
    changed();
  }, opts);
  handle('bookmarks.removeTree', (_e, id) => {
    store.remove(parseId(id));
    changed();
  }, opts);

  // Eventos: cada cambio puntual (de la extensión, de otra o de la interfaz de Callisto)
  store.onChange((c) => {
    const r = manager.router;
    if (c.type === 'created') r.broadcastEvent('bookmarks.onCreated', String(c.id), nodeOf(c.id));
    else if (c.type === 'changed') {
      const n = store.get(c.id);
      if (n) r.broadcastEvent('bookmarks.onChanged', String(c.id), { title: n.title, ...(n.url ? { url: n.url } : {}) });
    } else if (c.type === 'moved') {
      r.broadcastEvent('bookmarks.onMoved', String(c.id), { parentId: String(c.parentId), index: c.index, oldParentId: String(c.oldParentId), oldIndex: c.oldIndex });
    } else if (c.type === 'removed') {
      r.broadcastEvent('bookmarks.onRemoved', String(c.id), { parentId: String(c.parentId), index: c.index, node: treeToNode(c.tree) });
    }
  });

  // ------------------------------------------------------------ chrome.tabGroups y chrome.tabs.group/ungroup

  const groupOf = (g: TabGroupState, w: BrowserWindowController) => ({ id: g.id, collapsed: g.collapsed, color: g.color, title: g.title, windowId: w.win.id });
  const allGroups = () => deps.windows().flatMap((w) => w.groupList().map((g) => ({ g, w })));
  const findGroup = (id: unknown) => {
    const found = allGroups().find(({ g }) => g.id === id);
    if (!found) throw new Error(`No group with id: ${String(id)}.`);
    return found;
  };
  const tabOf = (id: unknown) => {
    const wc = typeof id === 'number' ? allWebContents.fromId(id) : undefined;
    const tab = wc ? Tab.fromWebContents(wc) : undefined;
    const win = tab ? deps.windows().find((w) => w.tabs.includes(tab)) : undefined;
    if (!tab || !win) throw new Error(`No tab with id: ${String(id)}.`);
    return { tab, win };
  };
  const gopts = { permission: 'tabGroups' };

  handle('tabGroups.get', (_e, id) => {
    const { g, w } = findGroup(id);
    return groupOf(g, w);
  }, gopts);
  handle('tabGroups.query', (_e, info) => {
    const q = (info ?? {}) as { collapsed?: unknown; color?: unknown; title?: unknown; windowId?: unknown };
    return allGroups()
      .filter(({ g, w }) => (q.collapsed === undefined || g.collapsed === q.collapsed) && (q.color === undefined || g.color === q.color) && (q.title === undefined || g.title === q.title) && (q.windowId === undefined || w.win.id === q.windowId))
      .map(({ g, w }) => groupOf(g, w));
  }, gopts);
  handle('tabGroups.update', (_e, id, props) => {
    const { w } = findGroup(id);
    const p = (props ?? {}) as { collapsed?: unknown; color?: unknown; title?: unknown };
    w.updateGroup(id as number, {
      collapsed: typeof p.collapsed === 'boolean' ? p.collapsed : undefined,
      color: isGroupColor(p.color) ? p.color : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
    });
    const { g } = findGroup(id);
    return groupOf(g, w);
  }, gopts);
  handle('tabGroups.move', (_e, id, props) => {
    const { w } = findGroup(id);
    const index = Number((props as { index?: unknown } | undefined)?.index);
    if (!Number.isSafeInteger(index)) throw new Error('Invalid index.');
    w.moveGroup(id as number, index < 0 ? w.tabs.length : index);
    const { g } = findGroup(id);
    return groupOf(g, w);
  }, gopts);
  // chrome.tabs.group / ungroup (en Chrome no requieren el permiso tabGroups)
  handle('tabs.group', (_e, options) => {
    const o = (options ?? {}) as { tabIds?: unknown; groupId?: unknown };
    const ids = Array.isArray(o.tabIds) ? o.tabIds : [o.tabIds];
    const tabs = ids.map(tabOf);
    if (!tabs.length) throw new Error('No tabs.');
    const win = tabs[0]!.win;
    let groupId: number;
    if (o.groupId !== undefined) {
      groupId = findGroup(o.groupId).g.id;
      if (findGroup(groupId).w !== win) throw new Error('Tabs must be in the same window as the group.');
    } else groupId = win.createGroup(tabs[0]!.tab, true);
    for (const { tab, win: w } of tabs) if (w === win && tab.groupId !== groupId) win.addToGroup(tab, groupId);
    return groupId;
  });
  handle('tabs.ungroup', (_e, tabIds) => {
    for (const { tab, win } of (Array.isArray(tabIds) ? tabIds : [tabIds]).map(tabOf)) win.removeFromGroup(tab);
  });

  // Eventos de grupos: se compara con lo último conocido cada vez que cambia algo en una ventana
  let known = new Map<number, string>();
  let pending = false;
  manager.on('groups-maybe-changed', () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      const now = new Map<number, string>();
      const details = new Map<number, ReturnType<typeof groupOf>>();
      for (const { g, w } of allGroups()) {
        const d = groupOf(g, w);
        details.set(g.id, d);
        now.set(g.id, JSON.stringify([d, w.groupIndex(g.id)]));
      }
      const r = manager.router;
      for (const [id, sig] of now) {
        const prev = known.get(id);
        if (prev === undefined) r.broadcastEvent('tabGroups.onCreated', details.get(id));
        else if (prev !== sig) {
          const [before, beforeIndex] = JSON.parse(prev) as [unknown, number];
          const [after, afterIndex] = JSON.parse(sig) as [unknown, number];
          if (JSON.stringify(before) !== JSON.stringify(after)) r.broadcastEvent('tabGroups.onUpdated', details.get(id));
          if (beforeIndex !== afterIndex) r.broadcastEvent('tabGroups.onMoved', details.get(id));
        }
      }
      for (const [id, prev] of known) if (!now.has(id)) r.broadcastEvent('tabGroups.onRemoved', (JSON.parse(prev) as [unknown])[0]);
      known = now;
    });
  });
}
