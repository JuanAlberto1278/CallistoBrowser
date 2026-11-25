// Al ver la navegación a /page2, lleva la pestaña a /page1?visto=webRequest (así la prueba sabe que la vio)
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame' && d.url.includes('/page2') && !d.url.includes('visto')) chrome.tabs.update(d.tabId, { url: d.url.replace('/page2', '/page1?visto=webRequest') });
  },
  { urls: ['<all_urls>'] },
);
