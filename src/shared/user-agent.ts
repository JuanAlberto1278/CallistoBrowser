// User-agent de Callisto.
// Decisión de V0.1 (docs/01-v0.1-resultados.md §5): Callisto se identifica con su propio token de producto y NUNCA se
// disfraza de Chrome. Google rechaza el inicio de sesión cuando un Chromium embebido se presenta como Chrome.
//   Electron:  ... (KHTML, like Gecko) Chrome/156.0.0.0 Electron/45.4.1 Safari/537.36
//   Callisto:  ... (KHTML, like Gecko) Callisto/0.2.0 Chrome/156.0.0.0 Safari/537.36

export function buildUserAgent(electronDefault: string, callistoVersion: string): string {
  const cleaned = electronDefault
    .replace(/\s?Electron\/\S+/g, '')
    .replace(/\s?callisto\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.replace(/\sChrome\//, ` Callisto/${callistoVersion} Chrome/`);
}
