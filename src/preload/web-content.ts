// Preload que corre en TODAS las páginas web (y sus iframes). No expone nada a la página.
// Hace tres cosas: corrige capacidades WebAuthn, retrasa la revocación de blob: (descargas) y, en el frame principal,
// atiende los formularios de inicio de sesión (contraseñas, V0.9).
//
// Corrección de capacidades WebAuthn (docs/01-v0.1-resultados.md §5.4):
// Electron anuncia autocompletado de passkeys ("conditional mediation") e "immediate mediation", pero no tiene la
// interfaz de Chrome que las implementa; en Windows la petición termina abriendo, sin que el usuario lo pida, el
// diálogo del sistema de llave de seguridad USB. Callisto anuncia solo lo que soporta. El inicio de sesión con passkey
// que el usuario elige explícitamente sigue funcionando con el diálogo de Windows.
import { contextBridge, ipcRenderer } from 'electron';
import { PAGE_EDITED } from '../shared/page-signals';
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, PW_IPC, isTextLike, isUsernameLike, pickPasswordIndex, pickUsernameIndex, type FieldInfo, type FieldRect } from '../shared/passwords';

// Descargas autorizadas (docs/01-v0.1-resultados.md §1.2, "B-guard"): Callisto cancela toda descarga hasta que el
// usuario la autoriza y después la vuelve a pedir. Muchos botones "Exportar" crean un blob:, lo descargan y lo revocan
// en el acto; sin esto, al autorizar ya no existiría. Se retrasa la revocación 2 minutos (solo libera memoria más tarde).
contextBridge.executeInMainWorld({
  func: (delayMs: number) => {
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      setTimeout(() => original(url), delayMs);
    };
  },
  args: [120_000],
});

contextBridge.executeInMainWorld({
  func: () => {
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return;
    try {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
      const pkc = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
      if (pkc.getClientCapabilities) {
        const original = pkc.getClientCapabilities.bind(PublicKeyCredential);
        pkc.getClientCapabilities = async () => ({ ...(await original()), conditionalGet: false, conditionalCreate: false, immediateGet: false });
      }
      const get = navigator.credentials.get.bind(navigator.credentials);
      const create = navigator.credentials.create.bind(navigator.credentials);
      const pendingUntilAbort = (signal?: AbortSignal | null) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
        });
      type Opts = { publicKey?: unknown; mediation?: string; signal?: AbortSignal | null };
      navigator.credentials.get = (options?: CredentialRequestOptions) => {
        const o = (options ?? {}) as Opts;
        if (o.publicKey && o.mediation === 'conditional') return pendingUntilAbort(o.signal);
        if (o.publicKey && o.mediation === 'immediate') return Promise.reject(new DOMException('No immediate credential', 'NotAllowedError'));
        return get(options);
      };
      navigator.credentials.create = (options?: CredentialCreationOptions) => {
        const o = (options ?? {}) as Opts;
        if (o.publicKey && o.mediation === 'conditional') return pendingUntilAbort(o.signal);
        return create(options);
      };
    } catch (e) {
      console.error('callisto: webauthn patch failed', e);
    }
  },
});

// ---------------------------------------------------------------- texto sin guardar (V1.0)
// Una pestaña donde el usuario editó algo no se duerme sola (perdería lo escrito). Se avisa una vez por documento, en
// cualquier frame; solo ediciones reales del usuario (isTrusted), no las que hace la página por su cuenta.
let editedSent = false;
document.addEventListener(
  'input',
  (e) => {
    if (editedSent || !e.isTrusted) return;
    editedSent = true;
    ipcRenderer.send(PAGE_EDITED);
  },
  true,
);

// ---------------------------------------------------------------- contraseñas (V0.9)
//
// Corre en el mundo aislado del preload: la página no ve estas funciones ni puede llamarlas. Solo en el frame
// principal (nunca en iframes) y solo en páginas http(s). El proceso principal decide el sitio con el origen real del
// frame; lo que diga la página no cuenta.
//
// - Al enfocar un campo de usuario o de contraseña de un formulario de inicio de sesión, pide al proceso principal que
//   muestre las sugerencias (si hay) debajo del campo. Se rellena SOLO cuando el usuario elige una (clic, o flechas y
//   Enter reales: isTrusted). Nunca al cargar la página.
// - Al enviar un formulario con contraseña, avisa lo enviado; el proceso principal ofrece guardarlo si el inicio de
//   sesión parece exitoso (la página cambió y ya no pide la contraseña, o el formulario desapareció).

function setupPasswords(): void {
  if (window.top !== window) return;
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;

  const attr = (el: HTMLInputElement, name: string) => el.getAttribute(name) ?? '';
  const info = (el: HTMLInputElement): FieldInfo => ({ type: (el.getAttribute('type') ?? 'text').toLowerCase(), autocomplete: attr(el, 'autocomplete'), name: el.name, id: el.id, value: el.value });
  const isPassword = (el: HTMLInputElement) => el.type === 'password';

  const visible = (el: HTMLInputElement): boolean => {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const scopeOf = (el: Element): ParentNode => (el as HTMLInputElement).form ?? el.closest('form') ?? document;
  const inputsIn = (scope: ParentNode) => Array.from(scope.querySelectorAll('input')).filter(visible);

  interface Login {
    username: HTMLInputElement | null;
    password: HTMLInputElement | null;
  }

  /** Campos de usuario y contraseña del formulario de inicio de sesión al que pertenece `el` (o null si no es uno). */
  function loginFor(el: HTMLInputElement): Login | null {
    if (!visible(el)) return null;
    const fields = inputsIn(scopeOf(el));
    const at = fields.indexOf(el);
    if (at < 0) return null;
    const infos = fields.map(info);
    if (isPassword(el)) {
      // Contraseña nueva (registro, cambio de contraseña): no se sugieren las guardadas
      if (attr(el, 'autocomplete').toLowerCase().includes('new-password')) return null;
      const u = pickUsernameIndex(infos, at);
      return { username: u >= 0 ? fields[u]! : null, password: el };
    }
    if (!isTextLike(info(el))) return null;
    const passwords = fields.map((f, i) => (isPassword(f) ? i : -1)).filter((i) => i >= 0);
    if (passwords.length) {
      const pw = passwords.find((i) => i > at) ?? passwords[0]!;
      if (attr(fields[pw]!, 'autocomplete').toLowerCase().includes('new-password')) return null;
      return pickUsernameIndex(infos, pw) === at ? { username: el, password: fields[pw]! } : null;
    }
    return isUsernameLike(info(el)) ? { username: el, password: null } : null;
  }

  // ------------------------------------------------------------ sugerencias y relleno

  let current: { field: HTMLInputElement; login: Login } | null = null;
  const popup = { open: false, count: 0, index: -1 };
  /** Después de rellenar, el foco vuelve al campo: eso no debe volver a abrir el menú (en ese campo). */
  let quiet: { field: HTMLInputElement; until: number } | null = null;

  const rectOf = (el: HTMLInputElement): FieldRect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const requestSuggestions = (el: HTMLInputElement) => ipcRenderer.send(PW_IPC.focus, rectOf(el));
  const hideSuggestions = () => {
    if (popup.open) ipcRenderer.send(PW_IPC.blur);
  };

  ipcRenderer.on(PW_IPC.popup, (_e, state: { open: boolean; count: number }) => {
    popup.open = state.open === true;
    popup.count = Number(state.count) || 0;
    popup.index = -1;
  });

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const login = loginFor(el);
      if (!login) return;
      current = { field: el, login };
      if (!(quiet && quiet.field === el && performance.now() < quiet.until)) requestSuggestions(el);
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      if (current && e.target === current.field) ipcRenderer.send(PW_IPC.blur);
    },
    true,
  );
  // Escribir, desplazar la página o cambiar el tamaño cierra las sugerencias (como en Chrome)
  document.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && current && e.target === current.field) hideSuggestions();
    },
    true,
  );
  window.addEventListener('scroll', hideSuggestions, true);
  window.addEventListener('resize', hideSuggestions);

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const setValue = (el: HTMLInputElement, value: string) => {
    valueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  ipcRenderer.on(PW_IPC.fill, (_e, data: { origin: string; username: string; password: string }) => {
    popup.open = false;
    if (!current || location.origin !== data.origin) return;
    quiet = { field: current.field, until: performance.now() + 500 };
    const { username, password } = current.login;
    if (username && visible(username) && data.username) setValue(username, data.username);
    if (password && visible(password)) setValue(password, data.password);
  });

  // ------------------------------------------------------------ lo que el usuario envía

  let watching: HTMLInputElement | null = null;
  /** Si el campo de contraseña desaparece después de enviar, el inicio de sesión probablemente funcionó (páginas que no recargan). */
  const watchGone = (pw: HTMLInputElement) => {
    watching = pw;
    for (const ms of [800, 2000, 5000]) {
      setTimeout(() => {
        if (watching === pw && !visible(pw)) {
          watching = null;
          ipcRenderer.send(PW_IPC.gone);
        }
      }, ms);
    }
  };

  function capture(from: Element): void {
    const fields = inputsIn(scopeOf(from));
    const passwords = fields.filter(isPassword);
    if (!passwords.length) {
      // Primer paso de un inicio de sesión en dos pasos: el usuario, para asociarlo a la contraseña del paso siguiente
      const user = fields.find((f) => isUsernameLike(info(f)) && f.value.trim());
      if (user) ipcRenderer.send(PW_IPC.username, user.value.trim().slice(0, MAX_USERNAME_LENGTH));
      return;
    }
    const pi = pickPasswordIndex(passwords.map(info));
    if (pi < 0) return;
    const pw = passwords[pi]!;
    if (pw.value.length > MAX_PASSWORD_LENGTH) return;
    const ui = pickUsernameIndex(fields.map(info), fields.indexOf(pw));
    const username = ui >= 0 ? fields[ui]!.value.trim().slice(0, MAX_USERNAME_LENGTH) : '';
    ipcRenderer.send(PW_IPC.submit, { username, password: pw.value });
    watchGone(pw);
  }

  document.addEventListener('submit', (e) => capture(e.target as Element), true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      const button = e.target.closest('button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]');
      if (button) capture(button);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (current && el === current.field && popup.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = popup.count;
          if (n > 0) popup.index = e.key === 'ArrowDown' ? (popup.index + 1) % n : (popup.index - 1 + n) % n;
          ipcRenderer.send(PW_IPC.select, popup.index);
          return;
        }
        if (e.key === 'Enter' && popup.index >= 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          ipcRenderer.send(PW_IPC.choose, popup.index);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideSuggestions();
          return;
        }
      } else if (current && el === current.field && e.key === 'ArrowDown') {
        requestSuggestions(current.field); // las flechas vuelven a abrir las sugerencias
        return;
      }
      if (e.key === 'Enter' && el instanceof HTMLInputElement) capture(el);
    },
    true,
  );

  // Al terminar de cargar: ¿esta página pide una contraseña? (si sí, el inicio de sesión anterior probablemente falló)
  window.addEventListener('load', () => {
    setTimeout(() => ipcRenderer.send(PW_IPC.page, inputsIn(document).some(isPassword)), 300);
  });
}

try {
  setupPasswords();
} catch (e) {
  console.error('callisto: passwords setup failed', e);
}
