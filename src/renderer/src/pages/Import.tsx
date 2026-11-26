import { useEffect, useState } from 'react';
import { BROWSER_NAMES, type ImportResult, type ImportSource } from '../../../shared/import';
import type { PasswordImportResult } from '../../../shared/internal-api';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function importSummary(r: ImportResult): string {
  const parts: string[] = [];
  if (r.bookmarks) {
    parts.push(`${plural(r.bookmarks.added, 'favorito', 'favoritos')} en la carpeta «${r.bookmarks.folder}» de Otros favoritos`);
    if (r.bookmarks.skipped) parts.push(`${plural(r.bookmarks.skipped, 'favorito no se pudo guardar', 'favoritos no se pudieron guardar')} (como los que empiezan con «javascript:»)`);
  }
  if (r.history) parts.push(r.history.added ? `${plural(r.history.added, 'visita', 'visitas')} al historial (de los últimos 90 días)` : 'nada nuevo en el historial');
  return parts.length ? `Listo: ${parts.join('; ')}.` : 'No había nada para importar.';
}

/** Importar desde Chrome o Edge (favoritos e historial). */
function BrowserImport() {
  const api = window.callistoInternal;
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [bookmarks, setBookmarks] = useState(true);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    void api.settings.importSources().then((list) => {
      setSources(list);
      setSourceId(list[0]?.id ?? '');
    });
  }, [api]);

  if (!sources) return null;
  if (!sources.length) {
    return (
      <p className="muted" data-testid="import-none">
        No se encontró Chrome ni Edge en esta computadora (con favoritos o historial).
      </p>
    );
  }
  const source = sources.find((s) => s.id === sourceId);
  return (
    <div className="import-browser">
      <div className="row">
        <label htmlFor="import-source">Importar desde</label>
        <select id="import-source" data-testid="import-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {BROWSER_NAMES[s.browser]} — {s.profileName}
            </option>
          ))}
        </select>
      </div>
      <label className="row">
        <span>Favoritos</span>
        <input type="checkbox" data-testid="import-bookmarks" disabled={!source?.hasBookmarks} checked={bookmarks && !!source?.hasBookmarks} onChange={(e) => setBookmarks(e.target.checked)} />
      </label>
      <label className="row">
        <span>Historial</span>
        <input type="checkbox" data-testid="import-history" disabled={!source?.hasHistory} checked={history && !!source?.hasHistory} onChange={(e) => setHistory(e.target.checked)} />
      </label>
      <div className="row">
        <span className="muted small">Las contraseñas de Chrome y Edge se traen con su archivo CSV (abajo).</span>
        <button
          className="btn primary"
          data-testid="import-run"
          disabled={busy || !source || (!(bookmarks && source.hasBookmarks) && !(history && source.hasHistory))}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void api.settings
              .importBrowser(sourceId, { bookmarks: bookmarks && !!source?.hasBookmarks, history: history && !!source?.hasHistory })
              .then((r) => setMessage(r.error ? { text: (r.bookmarks || r.history ? importSummary(r) + ' ' : '') + r.error, error: true } : { text: importSummary(r), error: false }))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Importando…' : 'Importar'}
        </button>
      </div>
      {message && (
        <p className={message.error ? 'theme-warning' : 'muted'} role="status" data-testid="import-result">
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Contraseñas: importar un CSV (con los choques a decidir) y exportar (con Windows Hello). */
function PasswordsCsv() {
  const api = window.callistoInternal;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState<Extract<PasswordImportResult, { token: string | null }> | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);

  const done = (r: Extract<PasswordImportResult, { token: string | null }>) => {
    const parts = [`${plural(r.added, 'contraseña nueva', 'contraseñas nuevas')}`];
    if (r.unchanged) parts.push(`${plural(r.unchanged, 'ya estaba', 'ya estaban')}`);
    if (r.skipped) parts.push(`${plural(r.skipped, 'fila salteada', 'filas salteadas')} (sin sitio web o sin contraseña)`);
    return `Importadas: ${parts.join(', ')}.`;
  };

  return (
    <div className="import-passwords">
      <div className="row">
        <span>
          Contraseñas desde un archivo CSV
          <br />
          <span className="muted small">En Chrome o Edge, buscá «Exportar contraseñas» en su administrador de contraseñas. Después borrá ese archivo: no está cifrado.</span>
        </span>
        <button
          className="btn"
          data-testid="import-passwords"
          disabled={busy || !!pending}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void api.settings
              .importPasswords()
              .then((r) => {
                if ('canceled' in r) return;
                if ('error' in r) return setMessage({ text: r.error, error: true });
                setMessage({ text: done(r), error: false });
                if (r.conflicts.length && r.token) setPending(r);
              })
              .finally(() => setBusy(false));
          }}
        >
          Importar contraseñas…
        </button>
      </div>
      {pending && (
        <div className="import-conflicts" role="alertdialog" aria-label="Contraseñas distintas" data-testid="import-conflicts">
          <p>
            {pending.conflicts.length === 1 ? 'Ya tenés guardada una contraseña distinta' : `Ya tenés guardadas contraseñas distintas para ${pending.conflicts.length} de estos sitios y usuarios`}:
          </p>
          <ul>
            {pending.conflicts.slice(0, 8).map((c) => (
              <li key={`${c.origin} ${c.username}`}>
                {c.origin.replace(/^https?:\/\//, '')} — {c.username || '(sin usuario)'}
              </li>
            ))}
            {pending.conflicts.length > 8 && <li className="muted">y {pending.conflicts.length - 8} más</li>}
          </ul>
          <div className="import-conflict-actions">
            <button
              className="btn primary"
              data-testid="import-replace"
              onClick={() =>
                void api.settings.resolvePasswordConflicts(pending.token!, true).then((r) => {
                  setPending(null);
                  setMessage('error' in r ? { text: r.error, error: true } : { text: `${done(pending)} Se reemplazaron ${plural(r.replaced, 'contraseña', 'contraseñas')} con las del archivo.`, error: false });
                })
              }
            >
              Reemplazar las mías
            </button>
            <button
              className="btn"
              data-testid="import-keep"
              onClick={() =>
                void api.settings.resolvePasswordConflicts(pending.token!, false).then(() => {
                  setPending(null);
                  setMessage({ text: `${done(pending)} Se conservaron las tuyas.`, error: false });
                })
              }
            >
              Conservar las mías
            </button>
          </div>
        </div>
      )}
      <div className="row">
        <span>
          Exportar contraseñas
          <br />
          <span className="muted small">Un archivo CSV que Chrome, Edge o Firefox pueden importar.</span>
        </span>
        {!confirmExport && (
          <button className="btn" data-testid="export-passwords" disabled={busy} onClick={() => setConfirmExport(true)}>
            Exportar…
          </button>
        )}
      </div>
      {confirmExport && (
        <div className="import-conflicts" data-testid="export-confirm">
          <p>El archivo no está cifrado: cualquiera que lo abra ve tus contraseñas. Guardalo en un lugar seguro y borralo cuando ya no lo necesites.</p>
          <div className="import-conflict-actions">
            <button
              className="btn primary"
              data-testid="export-run"
              onClick={() => {
                setConfirmExport(false);
                setBusy(true);
                setMessage(null);
                void api.settings
                  .exportPasswords()
                  .then((r) => {
                    if ('canceled' in r) return;
                    if ('error' in r) return setMessage({ text: r.error, error: true });
                    setMessage({ text: `Se exportaron ${plural(r.exported, 'contraseña', 'contraseñas')}.${r.failed ? ` ${plural(r.failed, 'no se pudo', 'no se pudieron')} descifrar.` : ''}`, error: false });
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Exportar
            </button>
            <button className="btn" onClick={() => setConfirmExport(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={message.error ? 'theme-warning' : 'muted'} role="status" data-testid="passwords-csv-result">
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Configuración → Importar y exportar (1.6). */
export function ImportSection() {
  return (
    <section className="card" aria-labelledby="s-import">
      <h2 id="s-import">Importar y exportar</h2>
      <BrowserImport />
      <PasswordsCsv />
    </section>
  );
}
