window.us = {
  available: () => typeof chrome.userScripts,
  call: async (path, ...args) => {
    try {
      return await path.split('.').reduce((o, k) => o[k], chrome)(...args);
    } catch (e) {
      return 'ERROR: ' + (e && e.message ? e.message : e);
    }
  },
};
document.title = 'listo';
