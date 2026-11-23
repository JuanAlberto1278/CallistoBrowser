// Al arrancar el service worker (no depende de runtime.onInstalled)
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: 'prueba', title: 'Callisto: ítem de prueba', contexts: ['page'] });
});
