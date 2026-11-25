// Registra sus scripts cuando la API está (solo con "Permitir scripts de usuario"), como Tampermonkey
async function setup() {
  if (!chrome.userScripts) return;
  await chrome.userScripts.configureWorld({ messaging: true });
  await chrome.userScripts.unregister();
  await chrome.userScripts.register([
    {
      id: 'main-start',
      matches: ['*://127.0.0.1/*'],
      js: [{ code: "window.__usMain = 'start';" }],
      runAt: 'document_start',
      world: 'MAIN',
    },
    {
      id: 'iso-end',
      matches: ['*://127.0.0.1/*'],
      excludeMatches: ['*://127.0.0.1/page3*'],
      js: [
        {
          code: [
            "document.documentElement.dataset.usIso = typeof window.__usMain;",
            "chrome.runtime.sendMessage({ hola: location.pathname }).then((r) => { document.documentElement.dataset.usReply = r.ok; });",
            "const port = chrome.runtime.connect({ name: 'canal' });",
            "port.onMessage.addListener((m) => { document.documentElement.dataset.usPort = m; });",
            "port.postMessage('ping');",
          ].join('\n'),
        },
      ],
      runAt: 'document_end',
    },
    { id: 'frames', matches: ['*://127.0.0.1/*'], allFrames: true, js: [{ file: 'frame.js' }], world: 'MAIN' },
  ]);
}
setup();
chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
  sendResponse({ ok: 'eco ' + message.hola + ' ' + (sender.tab ? 'con pestaña' : 'sin pestaña') });
});
chrome.runtime.onUserScriptConnect.addListener((port) => {
  port.onMessage.addListener((m) => port.postMessage(m + '-pong ' + port.name));
});
