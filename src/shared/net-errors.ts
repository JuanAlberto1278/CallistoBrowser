// Mensajes en español para los errores de red de Chromium (códigos de net/base/net_error_list.h).

export interface NetErrorInfo {
  title: string;
  detail: string;
  /** Error de certificado: Callisto NO permite continuar. */
  certificate: boolean;
}

const MESSAGES: Record<number, [string, string]> = {
  [-105]: ['No se encontró el sitio', 'No se pudo resolver la dirección del servidor. Revisá que esté bien escrita.'],
  [-106]: ['Sin conexión a Internet', 'Revisá tu conexión de red.'],
  [-102]: ['Conexión rechazada', 'El servidor rechazó la conexión.'],
  [-118]: ['Tiempo de conexión agotado', 'El servidor tardó demasiado en responder.'],
  [-7]: ['Tiempo agotado', 'La operación tardó demasiado.'],
  [-101]: ['Conexión restablecida', 'La conexión se interrumpió.'],
  [-100]: ['Conexión cerrada', 'El servidor cerró la conexión de forma inesperada.'],
  [-109]: ['Dirección inaccesible', 'No se puede llegar a esa dirección.'],
  [-107]: ['Error de protocolo SSL', 'El sitio envió una respuesta segura no válida.'],
  [-113]: ['Conexión segura no compatible', 'El sitio usa un protocolo de seguridad no compatible.'],
  [-10]: ['Acceso denegado', 'No se permitió el acceso a este recurso.'],
  [-6]: ['Archivo no encontrado', 'No se encontró el archivo.'],
  [-300]: ['Dirección no válida', 'La dirección no es válida.'],
  [-301]: ['Esquema no compatible', 'Callisto no puede abrir este tipo de dirección.'],
  [-324]: ['Respuesta vacía', 'El servidor no envió datos.'],
  [-312]: ['Puerto bloqueado', 'Por seguridad, Callisto no se conecta a este puerto.'],
};

export function describeNetError(code: number, chromiumDescription: string): NetErrorInfo {
  const certificate = code <= -200 && code > -300;
  if (certificate) {
    return {
      title: 'La conexión no es privada',
      detail: 'El certificado de seguridad del sitio no es válido. Alguien podría estar intentando interceptar tus datos. Callisto bloqueó la conexión.',
      certificate: true,
    };
  }
  const m = MESSAGES[code];
  return {
    title: m ? m[0] : 'No se puede acceder a este sitio',
    detail: m ? m[1] : `Ocurrió un error al cargar la página${chromiumDescription ? ` (${chromiumDescription})` : ''}.`,
    certificate: false,
  };
}

/** Errores de conexión tras los que es razonable reintentar con http cuando Callisto eligió https por su cuenta. */
export const HTTPS_UPGRADE_FALLBACK_ERRORS = new Set([-102, -107, -113, -100, -101, -118, -324]);

/** Navegación cancelada (por otra navegación o por el usuario): no es un error que mostrar. */
export const ERR_ABORTED = -3;
