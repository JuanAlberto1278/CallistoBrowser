// Registra lo que pasa (la prueba lo lee de chrome.storage.local)
// (en fila: dos eventos seguidos no se pisan)
let chain = Promise.resolve();
const log = (...e) => (chain = chain.then(() => chrome.storage.local.get({ events: [] }).then(({ events }) => chrome.storage.local.set({ events: [...events, e] }))));
chrome.runtime.onInstalled.addListener((d) => log('runtime.onInstalled', d.reason));
chrome.commands.onCommand.addListener((name) => log('commands.onCommand', name));
if (chrome.omnibox) {
  chrome.omnibox.onInputStarted.addListener(() => log('omnibox.onInputStarted'));
  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    log('omnibox.onInputChanged', text);
    suggest([{ content: 'sugerida ' + text, description: 'Sugerencia de la extensión' }]);
  });
  chrome.omnibox.onInputEntered.addListener((text, disposition) => log('omnibox.onInputEntered', text, disposition));
}
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: 'en-boton', title: 'Ítem del botón', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'en-pagina', title: 'Ítem de la página', contexts: ['page'] });
});
chrome.contextMenus.onClicked.addListener((info) => log('contextMenus.onClicked', info.menuItemId));
chrome.alarms.onAlarm.addListener((a) => log('alarms.onAlarm', a.name));
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m === 'ping-sw') reply('pong-sw');
});
chrome.history.onVisited.addListener((item) => log('history.onVisited', item.url));
chrome.downloads.onCreated.addListener((d) => log('downloads.onCreated', d.id));
chrome.contextMenus.onClicked.addListener(() => {});
