// Funciones para la prueba (devuelven el resultado o 'ERROR: …')
const run = async (f) => {
  try {
    return await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('sin respuesta')), 8000))]);
  } catch (e) {
    return 'ERROR: ' + (e && e.message ? e.message : e);
  }
};
window.tools = {
  events: () => chrome.storage.local.get({ events: [] }).then((r) => r.events),
  call: (path, ...args) => run(() => path.split('.').reduce((o, k) => o[k], chrome)(...args)),
  // Un puerto con el programa: manda texto con acentos y emoji, y pide un mensaje grande (más de un pedazo)
  connect: (name, text) =>
    run(
      () =>
        new Promise((resolve) => {
          const port = chrome.runtime.connectNative(name);
          const got = [];
          port.onMessage.addListener((m) => {
            got.push(m.big ? { bigLength: m.big.length } : m);
            if (got.length === 2) {
              port.disconnect();
              resolve(got);
            }
          });
          port.onDisconnect.addListener(() => resolve(['desconectado: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : ''), ...got]));
          port.postMessage({ text });
          port.postMessage({ cmd: 'big' });
        }),
    ),
};
document.title = 'Panel listo';
