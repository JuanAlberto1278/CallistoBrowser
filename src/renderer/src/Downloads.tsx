import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DownloadsUiState } from '../../shared/ipc';
import { formatBytes, formatRemaining, type DownloadEntry, type DownloadPrompt } from '../../shared/downloads';
import { CloseIcon, DownloadIcon, FileIcon, FolderIcon, PauseIcon, PlayIcon, RetryIcon, WarningIcon } from './icons';
import './downloads.css';

/** Botón de descargas de la barra, con el progreso conjunto como anillo. */
export function DownloadsButton({ state, onClick }: { state: DownloadsUiState; onClick: () => void }) {
  const pct = state.progress === null ? null : Math.round(state.progress * 100);
  const busy = state.active > 0;
  return (
    <button
      className={`icon-button downloads-button ${busy ? 'busy' : ''} ${state.prompt ? 'attention' : ''}`}
      data-testid="downloads-button"
      data-active={state.active}
      aria-label={busy ? `Descargas (${state.active} en curso)` : 'Descargas'}
      title="Descargas (Ctrl+J)"
      aria-expanded={state.panelOpen || !!state.prompt}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {busy && <span className="ring" style={{ ['--pct' as string]: pct === null ? 25 : pct }} aria-hidden="true" />}
      <DownloadIcon />
    </button>
  );
}

function statusText(d: DownloadEntry): string {
  switch (d.state) {
    case 'starting':
      return 'Iniciando…';
    case 'in_progress': {
      const parts = [d.totalBytes ? `${formatBytes(d.receivedBytes)} de ${formatBytes(d.totalBytes)}` : formatBytes(d.receivedBytes)];
      if (d.bytesPerSecond > 0) parts.push(`${formatBytes(d.bytesPerSecond)}/s`);
      if (d.totalBytes && d.bytesPerSecond > 0) {
        const left = formatRemaining((d.totalBytes - d.receivedBytes) / d.bytesPerSecond);
        if (left) parts.push(`quedan ${left}`);
      }
      return parts.join(' · ');
    }
    case 'paused':
      return `En pausa · ${d.totalBytes ? `${formatBytes(d.receivedBytes)} de ${formatBytes(d.totalBytes)}` : formatBytes(d.receivedBytes)}`;
    case 'completed':
      return d.exists ? `${formatBytes(d.totalBytes || d.receivedBytes)} · ${d.site}` : 'El archivo se movió o se eliminó';
    case 'cancelled':
      return 'Cancelada';
    case 'interrupted':
      return d.error ?? 'Falló';
    case 'waiting_click':
      return `Volvé a hacer clic en el enlace en ${d.site}: este sitio no permite volver a pedir el archivo. Callisto lo va a guardar sin volver a preguntar.`;
  }
}

/** Fila de una descarga con sus acciones (se usa en el panel y en la página de descargas). */
export function DownloadRow({ d, onAction, compact }: { d: DownloadEntry; onAction: (action: 'pause' | 'resume' | 'cancel' | 'open' | 'show' | 'retry' | 'remove') => void; compact?: boolean }) {
  const live = d.state === 'in_progress' || d.state === 'paused' || d.state === 'starting';
  const pct = d.totalBytes ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : null;
  const canOpen = d.state === 'completed' && d.exists;
  const failed = d.state === 'interrupted' || d.state === 'cancelled';
  return (
    <div
      className={`download-row state-${d.state} ${canOpen ? 'openable' : ''}`}
      data-testid="download-item"
      data-state={d.state}
      data-filename={d.filename}
      title={canOpen ? `Abrir ${d.filename}` : d.filename}
      onClick={() => canOpen && onAction('open')}
    >
      <span className="download-icon" aria-hidden="true">
        {failed ? <WarningIcon /> : <FileIcon />}
      </span>
      <div className="download-body">
        <div className={`download-name ${failed ? 'struck' : ''}`}>{d.filename}</div>
        {(d.state === 'in_progress' || d.state === 'paused') && (
          <div className={`progress ${pct === null ? 'indeterminate' : ''}`} role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: pct === null ? undefined : `${pct}%` }} />
          </div>
        )}
        <div className={`download-status ${d.state === 'interrupted' || d.state === 'waiting_click' ? 'emphasis' : ''}`} data-testid="download-status">
          {statusText(d)}
        </div>
        {!compact && <div className="download-url">{d.url.length > 140 ? d.url.slice(0, 140) + '…' : d.url}</div>}
      </div>
      <div className="download-actions" onClick={(e) => e.stopPropagation()}>
        {d.state === 'in_progress' && (
          <button className="icon-button small" data-testid="download-pause" aria-label="Pausar" title="Pausar" onClick={() => onAction('pause')}>
            <PauseIcon />
          </button>
        )}
        {(d.state === 'paused' || (d.state === 'interrupted' && d.canResume)) && (
          <button className="icon-button small" data-testid="download-resume" aria-label="Reanudar" title="Reanudar" onClick={() => onAction('resume')}>
            <PlayIcon />
          </button>
        )}
        {failed && !d.canResume && (
          <button className="icon-button small" data-testid="download-retry" aria-label="Reintentar" title="Reintentar" onClick={() => onAction('retry')}>
            <RetryIcon />
          </button>
        )}
        {canOpen && (
          <button className="icon-button small" data-testid="download-show" aria-label="Mostrar en la carpeta" title="Mostrar en la carpeta" onClick={() => onAction('show')}>
            <FolderIcon />
          </button>
        )}
        {(live || d.state === 'waiting_click' || (d.state === 'interrupted' && d.canResume)) && (
          <button className="icon-button small" data-testid="download-cancel" aria-label="Cancelar" title="Cancelar" onClick={() => onAction('cancel')}>
            <CloseIcon />
          </button>
        )}
        {!compact && !live && d.state !== 'waiting_click' && (
          <button className="icon-button small" data-testid="download-remove" aria-label="Quitar de la lista" title="Quitar de la lista (el archivo no se borra)" onClick={() => onAction('remove')}>
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Pedido de autorización. Cada pedido es un elemento nuevo y sus botones se activan recién a los 400 ms: un doble clic
 * o un clic tardío sobre "Guardar" nunca autoriza la descarga siguiente, que el usuario todavía no vio.
 */
function PromptCard({ p, waiting }: { p: DownloadPrompt; waiting: number }) {
  const api = window.callisto;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="download-prompt" data-testid="download-prompt" data-prompt-id={p.id}>
      <div className="flyout-title">¿Guardar este archivo?</div>
      <div className="prompt-file">
        <span className="download-icon" aria-hidden="true">
          <FileIcon />
        </span>
        <div className="download-body">
          <div className="download-name" data-testid="download-prompt-name">{p.filename}</div>
          <div className="download-status">{[p.totalBytes ? formatBytes(p.totalBytes) : '', `de ${p.site}`].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {p.dangerous && (
        <p className="prompt-warning" data-testid="download-prompt-warning">
          <WarningIcon /> Este tipo de archivo puede dañar tu equipo. Guardalo solo si confiás en {p.site}.
        </p>
      )}
      <p className="muted small">Se va a guardar en la carpeta «{p.folderName}». Hasta que elijas, no se guarda nada.</p>
      <div className="prompt-buttons">
        <button className="btn primary" data-testid="download-save" disabled={!armed} onClick={() => api.answerDownload(p.id, 'save')}>
          Guardar
        </button>
        <button className="btn" data-testid="download-save-as" disabled={!armed} onClick={() => api.answerDownload(p.id, 'save-as')}>
          Guardar como…
        </button>
        <button className="btn" data-testid="download-deny" onClick={() => api.answerDownload(p.id, 'cancel')}>
          Cancelar
        </button>
      </div>
      {waiting > 0 && (
        <p className="muted small" data-testid="download-waiting">
          {waiting === 1 ? 'Hay 1 descarga más esperando.' : `Hay ${waiting} descargas más esperando.`}
        </p>
      )}
    </div>
  );
}

/**
 * Panel debajo del botón de descargas: el pedido de autorización (si hay uno) o las descargas recientes.
 * Mientras se decide, la descarga ya está cancelada: nada se guarda sin "Guardar".
 */
export function DownloadsFlyout({ state, top, onBottom }: { state: DownloadsUiState; top: number; onBottom: (bottom: number) => void }) {
  const api = window.callisto;
  const ref = useRef<HTMLDivElement>(null);
  const visible = !!state.prompt || state.panelOpen;

  useLayoutEffect(() => {
    onBottom(visible && ref.current ? ref.current.getBoundingClientRect().bottom : 0);
  });

  if (!visible) return null;
  const p = state.prompt;
  return (
    <div
      className="flyout"
      ref={ref}
      style={{ top }}
      role={p ? 'alertdialog' : 'dialog'}
      aria-label={p ? 'Autorizar descarga' : 'Descargas'}
      data-testid="downloads-flyout"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (p) api.answerDownload(p.id, 'cancel');
          else api.setDownloadsPanel(false);
        }
      }}
    >
      {p ? (
        <PromptCard key={p.id} p={p} waiting={state.waiting} />
      ) : (
        <>
          <div className="flyout-header">
            <span className="flyout-title">Descargas</span>
            <button className="icon-button small" aria-label="Cerrar" title="Cerrar" onClick={() => api.setDownloadsPanel(false)}>
              <CloseIcon />
            </button>
          </div>
          {state.items.length === 0 ? (
            <p className="muted flyout-empty">Todavía no hay descargas.</p>
          ) : (
            <div className="flyout-list">
              {state.items.map((d) => (
                <DownloadRow key={d.id} d={d} compact onAction={(a) => api.downloadAction(d.id, a)} />
              ))}
            </div>
          )}
          <button className="flyout-footer" data-testid="downloads-open-page" onClick={() => api.openDownloadsPage()}>
            Ver todas las descargas
          </button>
        </>
      )}
    </div>
  );
}
