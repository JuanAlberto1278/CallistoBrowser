// Registra qué APIs existen en distintos momentos del arranque del service worker.
const snap = (when) => console.log(`PROBE ${when}: ` + JSON.stringify({
  commands: typeof chrome.commands,
  windows: typeof chrome.windows,
  tabsCreate: typeof (chrome.tabs && chrome.tabs.create),
  action: typeof chrome.action,
  storageLocal: typeof (chrome.storage && chrome.storage.local),
  browserGlobal: typeof globalThis.browser,
  browserIsChrome: globalThis.browser === chrome,
  browserCommands: typeof (globalThis.browser && globalThis.browser.commands),
  browserWindows: typeof (globalThis.browser && globalThis.browser.windows),
  browserTabsCreate: typeof (globalThis.browser && globalThis.browser.tabs && globalThis.browser.tabs.create),
}));
snap('top-level');
queueMicrotask(() => snap('microtask'));
setTimeout(() => snap('timeout-0'), 0);
setTimeout(() => snap('timeout-500'), 500);
