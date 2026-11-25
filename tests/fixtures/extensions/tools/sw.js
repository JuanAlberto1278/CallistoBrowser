// El botón empieza desactivado y se muestra solo en /page2 o donde haya un campo #field (reglas según el contenido)
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({ pageUrl: { pathEquals: '/page2' } }),
          new chrome.declarativeContent.PageStateMatcher({ css: ['input#field'] }),
        ],
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
});
const log = (...e) => chrome.storage.local.get({ events: [] }).then(({ events }) => chrome.storage.local.set({ events: [...events, e] }));
chrome.sidePanel.onOpened && chrome.sidePanel.onOpened.addListener((info) => log('sidePanel.onOpened', info.path));
