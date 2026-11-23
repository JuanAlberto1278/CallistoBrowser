// Registra los eventos que recibe, para que la prueba los lea
window.events = [];
for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) chrome.bookmarks.onCreated && chrome.bookmarks[name].addListener((...args) => window.events.push(['bookmarks.' + name, ...args]));
for (const name of ['onCreated', 'onUpdated', 'onRemoved']) chrome.tabGroups && chrome.tabGroups[name].addListener((g) => window.events.push(['tabGroups.' + name, g]));
