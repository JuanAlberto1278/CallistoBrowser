// Borrar datos de navegación de un perfil: desde la configuración y, desde la 1.5, al cerrar Callisto.
import type { Profile } from './profile';
import { hasClearOnExit } from '../shared/settings';

export interface ClearRequest {
  /** Historial a borrar: todo, o un rango [desde, hasta) en ms. */
  history?: 'all' | [number, number] | null;
  /** Cookies y datos de sitios (almacenamiento, service workers…). */
  siteData?: boolean;
  /** Imágenes y archivos en caché. */
  cache?: boolean;
}

/** Borra lo pedido. Los datos de las extensiones (su configuración) no se tocan, como en Chrome. */
export async function clearBrowsingData(profile: Profile, req: ClearRequest): Promise<void> {
  if (req.history === 'all') profile.history.deleteAll();
  else if (req.history) profile.history.deleteRange(req.history[0], req.history[1]);
  const excludeOrigins = (profile.extensions?.registry.all() ?? []).map((r) => `chrome-extension://${r.id}`);
  const exclude = excludeOrigins.length ? { excludeOrigins } : {};
  if (req.siteData) {
    await profile.session.clearData({ dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'], ...exclude });
    await profile.session.clearAuthCache();
  }
  if (req.cache) await profile.session.clearData({ dataTypes: ['cache'], ...exclude });
}

/**
 * "Al cerrar Callisto, borrar" (1.5). Mientras la opción está activa, el perfil queda marcado como pendiente: si
 * Callisto se cierra de golpe (sin pasar por la salida normal), se borra al volver a abrir el perfil.
 */
const PENDING_KEY = 'clearOnExitPending';

export function markClearOnExit(profile: Profile): void {
  if (profile.isPrivate) return;
  if (hasClearOnExit(profile.settings)) profile.kv.set(PENDING_KEY, true);
  else profile.kv.delete(PENDING_KEY);
}

export function clearOnExitPending(profile: Profile): boolean {
  return !profile.isPrivate && profile.kv.get(PENDING_KEY) === true;
}

/** Borra lo elegido en "Al cerrar Callisto" (y deja de estar pendiente). */
export async function clearOnExit(profile: Profile): Promise<void> {
  const what = profile.settings.clearOnExit;
  if (!profile.isPrivate && hasClearOnExit(profile.settings)) {
    await clearBrowsingData(profile, { history: what.history ? 'all' : null, siteData: what.siteData, cache: what.cache });
  }
  if (!profile.isPrivate) profile.kv.delete(PENDING_KEY);
}
