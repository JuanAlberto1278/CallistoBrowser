// Panel del sitio (1.5): lo que se muestra al tocar el candado y "Borrar los datos de este sitio".
import type { Profile } from './profile';
import type { Tab } from './tab';
import { webOrigin } from './permissions';
import { cookieAppliesTo, SITE_CONTENT_DEFAULTS, SITE_CONTENT_KINDS, SITE_PROMPT_KINDS, SITE_SETTING_LABELS } from '../shared/site-settings';
import { classifyUrl } from '../shared/url-security';
import type { SiteInfo, SiteSettingEntry } from '../shared/ipc';

/** Datos del sitio de la pestaña (null si no es una página web). */
export function buildSiteInfo(profile: Profile, tab: Tab, neverSleep: { site: string; listed: boolean } | null): SiteInfo | null {
  if (tab.kind !== 'web') return null;
  const origin = webOrigin(tab.url);
  if (!origin) return null;
  const prompts: SiteSettingEntry[] = SITE_PROMPT_KINDS.map((kind) => ({
    kind,
    label: SITE_SETTING_LABELS[kind],
    value: profile.permissions.get(origin, kind) ?? 'ask',
    defaultValue: 'ask',
  }));
  const content: SiteSettingEntry[] = SITE_CONTENT_KINDS.map((kind) => ({
    kind,
    label: SITE_SETTING_LABELS[kind],
    value: profile.contentSetting(origin, kind),
    defaultValue: SITE_CONTENT_DEFAULTS[kind],
  }));
  let passwords = 0;
  try {
    passwords = profile.passwords.forOrigin(origin).length;
  } catch {
    passwords = 0; // la bóveda no se pudo leer: no se ofrece el enlace
  }
  return {
    origin,
    host: new URL(origin).host,
    security: classifyUrl(tab.url),
    prompts,
    content,
    zoomPercent: tab.state.zoomPercent,
    neverSleep,
    passwords,
    isPrivate: profile.isPrivate,
  };
}

/**
 * Borra los datos que el sitio guardó en el perfil: sus cookies (las que el navegador le envía), su almacenamiento
 * (local, IndexedDB, service workers, caché de la página) y lo que tiene en la caché. No toca el historial, las
 * contraseñas ni los ajustes del sitio (como el panel de Chrome).
 */
export async function clearSiteData(profile: Profile, origin: string): Promise<void> {
  const ses = profile.session;
  const host = new URL(origin).hostname;
  const cookies = await ses.cookies.get({});
  await Promise.all(
    cookies
      .filter((c) => cookieAppliesTo(c.domain, host))
      .map((c) => {
        const domain = (c.domain ?? host).replace(/^\./, '');
        return ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${domain}${c.path ?? '/'}`, c.name).catch(() => undefined);
      }),
  );
  await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'filesystem', 'cachestorage', 'shadercache'] });
  try {
    await ses.clearData({ dataTypes: ['cache'], origins: [origin] });
  } catch {
    /* la caché de este sitio no se pudo filtrar: queda (se renueva sola) */
  }
}
