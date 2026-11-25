// Scripts de usuario (chrome.userScripts, 1.4.4): la parte pura, sin Electron (la prueban las pruebas unitarias).
// El registro y la inyección están en user-scripts.ts y en el preload de las páginas (src/preload/web-content.ts).

/** Patrón de coincidencia de Chrome (`<all_urls>`, `*://*.ejemplo.com/ruta*`…): ¿la dirección coincide? */
export function matchesPattern(pattern: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (pattern === '<all_urls>') return ['http', 'https', 'file', 'ftp', 'ws', 'wss'].includes(scheme);
  const m = /^(\*|https?|wss?|file|ftp|urn):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, pScheme, pHost, pPath] = m as unknown as [string, string, string, string];
  if (pScheme === '*' ? scheme !== 'http' && scheme !== 'https' : pScheme !== scheme) return false;
  const host = u.hostname.toLowerCase();
  if (pScheme !== 'file') {
    const h = pHost.toLowerCase();
    if (h === '*') {
      /* cualquier host */
    } else if (h.startsWith('*.')) {
      const base = h.slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (host !== h.replace(/:\d+$/, '')) return false;
  }
  return globToRegExp(pPath).test(u.pathname + u.search);
}

/** Comodín de los scripts de usuario (`*` cualquier cosa, `?` un carácter) sobre la dirección completa. */
export function matchesGlob(glob: string, url: string): boolean {
  if (glob.length > 2000) return false;
  return globToRegExp(glob, true).test(url);
}

function globToRegExp(glob: string, question = false): RegExp {
  const source = glob
    .split('')
    .map((c) => (c === '*' ? '.*' : question && c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\?]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 's');
}

export interface UserScriptSource {
  code?: string;
  file?: string;
}

/** Un script registrado (chrome.userScripts.RegisteredUserScript). */
export interface RegisteredUserScript {
  id: string;
  matches?: string[];
  excludeMatches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  js: UserScriptSource[];
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  allFrames?: boolean;
  world?: 'MAIN' | 'USER_SCRIPT';
  worldId?: string;
}

/** ¿Un script registrado corre en esta dirección (y en este frame)? Las reglas de Chrome. */
export function scriptMatches(script: RegisteredUserScript, url: string, topFrame: boolean): boolean {
  if (!topFrame && !script.allFrames) return false;
  if (!(script.matches ?? []).some((p) => matchesPattern(p, url))) return false;
  if ((script.excludeMatches ?? []).some((p) => matchesPattern(p, url))) return false;
  if (script.includeGlobs?.length && !script.includeGlobs.some((g) => matchesGlob(g, url))) return false;
  if ((script.excludeGlobs ?? []).some((g) => matchesGlob(g, url))) return false;
  return true;
}

const stringArray = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length <= 2000)) throw new Error(`Invalid ${what}.`);
  return v as string[];
};

/**
 * Valida un script de chrome.userScripts.register / update (como Chrome: id sin "_" al principio, matches obligatorio al
 * registrar, js con code o file). `partial`: solo lo que trae (update).
 */
export function validateUserScript(raw: unknown, partial = false): Partial<RegisteredUserScript> & { id: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.startsWith('_') || r.id.length > 200) throw new Error('Invalid script id.');
  const out: Partial<RegisteredUserScript> & { id: string } = { id: r.id };
  const matches = stringArray(r.matches, 'matches');
  if (matches) out.matches = matches;
  else if (!partial) throw new Error(`Script with ID '${r.id}' must specify 'matches'.`);
  for (const key of ['excludeMatches', 'includeGlobs', 'excludeGlobs'] as const) {
    const v = stringArray(r[key], key);
    if (v) out[key] = v;
  }
  if (r.js !== undefined) {
    if (!Array.isArray(r.js) || !r.js.length) throw new Error(`Script with ID '${r.id}' must specify at least one js source.`);
    out.js = r.js.map((s) => {
      const src = (s ?? {}) as { code?: unknown; file?: unknown };
      if (typeof src.code === 'string' && src.file === undefined) return { code: src.code };
      if (typeof src.file === 'string' && src.code === undefined && !src.file.includes('..')) return { file: src.file.replace(/^\/+/, '') };
      throw new Error('Invalid script source: exactly one of "code" or "file" must be specified.');
    });
  } else if (!partial) throw new Error(`Script with ID '${r.id}' must specify at least one js source.`);
  if (r.runAt !== undefined) {
    if (r.runAt !== 'document_start' && r.runAt !== 'document_end' && r.runAt !== 'document_idle') throw new Error('Invalid runAt.');
    out.runAt = r.runAt;
  }
  if (r.allFrames !== undefined) out.allFrames = r.allFrames === true;
  if (r.world !== undefined) {
    if (r.world !== 'MAIN' && r.world !== 'USER_SCRIPT') throw new Error('Invalid world.');
    out.world = r.world;
  }
  if (r.worldId !== undefined) {
    if (typeof r.worldId !== 'string' || r.worldId.startsWith('_') || r.worldId.length > 256) throw new Error('Invalid worldId.');
    out.worldId = r.worldId;
  }
  return out;
}

/** Configuración de un mundo USER_SCRIPT (configureWorld). */
export interface WorldConfig {
  csp?: string;
  messaging?: boolean;
}
