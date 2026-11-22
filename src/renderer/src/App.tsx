import { useEffect, useRef, useState } from 'react';
import type { PermissionPrompt, WindowState } from '../../shared/ipc';
import { chromeHeight, NOTICE_HEIGHT, PERMISSION_BAR_HEIGHT, TAB_STRIP_HEIGHT, TOOLBAR_HEIGHT } from '../../shared/layout';
import { AddressBar } from './AddressBar';
import { FindBar } from './FindBar';
import { TabStrip } from './TabStrip';
import { BackIcon, CloseIcon, ForwardIcon, MoreIcon, ReloadIcon, StopIcon } from './icons';

function siteName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function PermissionBar({ prompt }: { prompt: PermissionPrompt }) {
  const api = window.callisto;
  const [remember, setRemember] = useState(true);
  return (
    <div className="permission-bar" role="alertdialog" aria-label="Pedido de permiso" data-testid="permission" style={{ height: PERMISSION_BAR_HEIGHT }}>
      <span className="permission-text" data-testid="permission-text">
        <strong>{siteName(prompt.origin)}</strong> quiere {prompt.phrase}
      </span>
      <label className="permission-remember">
        <input type="checkbox" data-testid="permission-remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Recordar en este sitio
      </label>
      <button className="btn primary" data-testid="permission-allow" onClick={() => api.respondPermission(prompt.id, true, remember)}>
        Permitir
      </button>
      <button className="btn" data-testid="permission-block" onClick={() => api.respondPermission(prompt.id, false, remember)}>
        Bloquear
      </button>
      <button className="icon-button small" aria-label="Ignorar por ahora" title="Ignorar por ahora (no se permite)" onClick={() => api.respondPermission(prompt.id, false, false)}>
        <CloseIcon />
      </button>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<WindowState | null>(null);
  const [favicons, setFavicons] = useState<Record<string, string>>({});
  const [focusSignal, setFocusSignal] = useState(0);
  const [findSignal, setFindSignal] = useState(0);
  const findHandled = useRef(0);
  const api = window.callisto;

  useEffect(() => {
    api.onState(setState);
    api.onFavicons((f) => setFavicons((prev) => ({ ...prev, ...f })));
    api.onFocusAddressBar(() => setFocusSignal((n) => n + 1));
    api.onFocusFind(() => setFindSignal((n) => n + 1));
    api.ready();
  }, [api]);

  const tab = state?.tabs.find((t) => t.id === state.activeTabId);
  const notice = tab?.notice ?? null;
  const baseHeight = chromeHeight({ notice: !!notice, find: !!tab?.find, permission: !!tab?.permission });
  return (
    <div className="chrome">
      <div style={{ height: TAB_STRIP_HEIGHT }} className="tabstrip-row">
        {state && <TabStrip tabs={state.tabs} activeId={state.activeTabId} favicons={favicons} />}
      </div>
      <div className="toolbar" role="toolbar" aria-label="Navegación" style={{ height: TOOLBAR_HEIGHT - 2 }}>
        <button className="icon-button" data-testid="back" title="Atrás (Alt+Flecha izquierda)" aria-label="Atrás" disabled={!tab?.canGoBack} onClick={() => api.goBack()}>
          <BackIcon />
        </button>
        <button className="icon-button" data-testid="forward" title="Adelante (Alt+Flecha derecha)" aria-label="Adelante" disabled={!tab?.canGoForward} onClick={() => api.goForward()}>
          <ForwardIcon />
        </button>
        {tab?.isLoading ? (
          <button className="icon-button" data-testid="stop" title="Detener (Esc)" aria-label="Detener" onClick={() => api.stop()}>
            <StopIcon />
          </button>
        ) : (
          <button className="icon-button" data-testid="reload" title="Recargar (F5)" aria-label="Recargar" onClick={(e) => api.reload(e.shiftKey || e.ctrlKey)}>
            <ReloadIcon />
          </button>
        )}
        <AddressBar
          tabId={tab?.id ?? 0}
          url={tab?.url ?? ''}
          security={tab?.security ?? 'none'}
          zoomPercent={tab?.zoomPercent ?? 100}
          focusSignal={focusSignal}
          searchEngine={state?.searchEngine ?? 'Google'}
          baseHeight={baseHeight}
          onSubmit={(text) => api.navigate(text)}
          onResetZoom={() => api.resetZoom()}
        />
        <button className="icon-button" data-testid="app-menu" title="Configuración y más" aria-label="Configuración y más" onClick={() => api.showAppMenu()}>
          <MoreIcon />
        </button>
      </div>
      <div className={`loading-bar ${tab?.isLoading ? 'active' : ''}`} data-testid="loading" data-loading={!!tab?.isLoading} aria-hidden="true" />
      {notice && (
        <div className={`notice ${notice.kind}`} role="status" data-testid="notice" style={{ height: NOTICE_HEIGHT }}>
          <span className="notice-text">{notice.text}</span>
          <button className="icon-button small" data-testid="notice-close" aria-label="Cerrar aviso" title="Cerrar" onClick={() => api.dismissNotice(notice.id)}>
            <CloseIcon />
          </button>
        </div>
      )}
      {tab?.permission && <PermissionBar key={tab.permission.id} prompt={tab.permission} />}
      {tab?.find && <FindBar tabId={tab.id} find={tab.find} focusSignal={findSignal} focusHandled={findHandled} />}
    </div>
  );
}
