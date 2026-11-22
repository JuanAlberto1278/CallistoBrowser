// Clasificación de seguridad de la página actual, para el indicador junto a la barra de direcciones.

export type SecurityLevel =
  | 'none' // página en blanco / nada cargado
  | 'secure' // HTTPS (Chromium ya rechazó la navegación si el certificado no era válido)
  | 'insecure' // HTTP sin cifrar
  | 'file' // archivo local
  | 'error'; // la carga falló (se muestra la página de error)

export function classifyUrl(url: string, failed = false): SecurityLevel {
  if (failed) return 'error';
  if (!url || url === 'about:blank') return 'none';
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'none';
  }
  switch (protocol) {
    case 'https:':
      return 'secure';
    case 'http:':
      return 'insecure';
    case 'file:':
      return 'file';
    default:
      return 'none';
  }
}
