import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/ipc';
import { AddressBar } from './AddressBar';
import { BackIcon, CloseIcon, ForwardIcon, ReloadIcon, StopIcon } from './icons';

const INITIAL: WindowState = {
  tab: { url: '', title: '', isLoading: false, canGoBack: false, canGoForward: false, security: 'none' },
  notice: null,
};

export function App() {
  const [state, setState] = useState<WindowState>(INITIAL);
  const [focusSignal, setFocusSignal] = useState(0);
  const api = window.callisto;

  useEffect(() => {
    api.onState(setState);
    api.onFocusAddressBar(() => setFocusSignal((n) => n + 1));
    api.ready();
  }, [api]);

  const { tab, notice } = state;
  return (
    <div className="chrome">
      <div className="toolbar" role="toolbar" aria-label="Navegación">
        <button className="icon-button" data-testid="back" title="Atrás (Alt+Flecha izquierda)" aria-label="Atrás" disabled={!tab.canGoBack} onClick={() => api.goBack()}>
          <BackIcon />
        </button>
        <button className="icon-button" data-testid="forward" title="Adelante (Alt+Flecha derecha)" aria-label="Adelante" disabled={!tab.canGoForward} onClick={() => api.goForward()}>
          <ForwardIcon />
        </button>
        {tab.isLoading ? (
          <button className="icon-button" data-testid="stop" title="Detener (Esc)" aria-label="Detener" onClick={() => api.stop()}>
            <StopIcon />
          </button>
        ) : (
          <button className="icon-button" data-testid="reload" title="Recargar (F5)" aria-label="Recargar" onClick={(e) => api.reload(e.shiftKey || e.ctrlKey)}>
            <ReloadIcon />
          </button>
        )}
        <AddressBar url={tab.url} security={tab.security} focusSignal={focusSignal} onSubmit={(text) => api.navigate(text)} />
      </div>
      <div className={`loading-bar ${tab.isLoading ? 'active' : ''}`} data-testid="loading" data-loading={tab.isLoading} aria-hidden="true" />
      {notice && (
        <div className={`notice ${notice.kind}`} role="status" data-testid="notice">
          <span className="notice-text">{notice.text}</span>
          <button className="icon-button small" data-testid="notice-close" aria-label="Cerrar aviso" title="Cerrar" onClick={() => api.dismissNotice(notice.id)}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
