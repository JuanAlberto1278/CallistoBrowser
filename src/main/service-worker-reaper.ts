import type { Session, WebContents } from 'electron';

// Ahorro de memoria (V1.0, medido): los service workers de algunos sitios (YouTube, BBC…) siguen corriendo después de
// cerrar o dormir su última pestaña y mantienen vivo un proceso entero (~100-200 MB cada uno), sin terminar solos.
// Callisto detiene los de los sitios que no tienen ninguna pestaña despierta desde hace un rato, como hace Chrome con los
// service workers inactivos. Detenerlo no borra nada: el navegador lo vuelve a iniciar solo cuando el sitio lo necesita
// (al abrirlo, una notificación push…). Los de las extensiones no se tocan.
//
// Electron no tiene una función para detenerlos: se usa el protocolo de depuración de Chromium (ServiceWorker.stopWorker)
// desde una pestaña del mismo perfil, unos milisegundos, sin que se note.


const lastSeen = new WeakMap<Session, Map<string, number>>();

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Detiene los service workers de la sesión cuyos sitios no tienen pestañas despiertas desde hace `graceMs` (un minuto).
 * `liveTabs`: los contenidos de las pestañas web despiertas del perfil (de todas sus ventanas).
 */
export async function stopOrphanServiceWorkers(ses: Session, liveTabs: WebContents[], graceMs = 60_000, now = Date.now()): Promise<string[]> {
  const seen = lastSeen.get(ses) ?? new Map<string, number>();
  lastSeen.set(ses, seen);
  const live = new Set<string>();
  for (const wc of liveTabs) {
    const o = !wc.isDestroyed() ? originOf(wc.getURL()) : null;
    if (o) {
      live.add(o);
      seen.set(o, now);
    }
  }
  const running = ses.serviceWorkers.getAllRunning();
  const doomed: Array<{ versionId: string; scope: string }> = [];
  for (const [versionId, info] of Object.entries(running)) {
    const o = originOf(info.scope);
    if (!o || live.has(o)) continue; // extensiones (chrome-extension://) y sitios con pestañas despiertas
    const last = seen.get(o);
    if (last === undefined) {
      seen.set(o, now); // recién visto sin pestañas: se le da el margen
      continue;
    }
    if (now - last >= graceMs) doomed.push({ versionId, scope: info.scope });
  }
  if (!doomed.length) return [];
  const host = liveTabs.find((wc) => !wc.isDestroyed() && !wc.isDevToolsOpened() && !wc.debugger.isAttached());
  if (!host) return [];
  const stopped: string[] = [];
  try {
    host.debugger.attach('1.3');
  } catch {
    return [];
  }
  try {
    await host.debugger.sendCommand('ServiceWorker.enable');
    for (const d of doomed) {
      try {
        await host.debugger.sendCommand('ServiceWorker.stopWorker', { versionId: d.versionId });
        stopped.push(d.scope);
      } catch {
        /* ya terminó solo */
      }
    }
  } catch {
    /* sin el dominio ServiceWorker: no se detiene nada */
  } finally {
    try {
      if (!host.isDestroyed()) host.debugger.detach();
    } catch {
      /* ya desconectado */
    }
  }
  return stopped;
}
