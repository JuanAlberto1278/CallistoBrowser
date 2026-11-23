// Para cada permiso, �existe el espacio de nombres chrome.* que le corresponde?
const NS = { 'downloads.open': 'downloads', 'downloads.ui': 'downloads', 'identity.email': 'identity', declarativeNetRequestFeedback: 'declarativeNetRequest', declarativeNetRequestWithHostAccess: 'declarativeNetRequest', webRequestBlocking: 'webRequest', webRequestAuthProvider: 'webRequest.onAuthRequired', nativeMessaging: 'runtime.connectNative', 'system.cpu': 'system.cpu', 'system.display': 'system.display', 'system.memory': 'system.memory', 'system.storage': 'system.storage', 'enterprise.deviceAttributes': 'enterprise.deviceAttributes', 'enterprise.hardwarePlatform': 'enterprise.hardwarePlatform', 'enterprise.networkingAttributes': 'enterprise.networkingAttributes', 'enterprise.platformKeys': 'enterprise.platformKeys' };
const SKIP = new Set(['activeTab', 'background', 'clipboardRead', 'clipboardWrite', 'favicon', 'geolocation', 'unlimitedStorage']);
const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), chrome);
const result = {};
for (const p of chrome.runtime.getManifest().permissions) {
  if (SKIP.has(p)) continue;
  result[p] = get(NS[p] ?? p) !== undefined;
}
result['action'] = !!chrome.action;
result['browser===chrome'] = typeof browser !== 'undefined' && browser === chrome;
document.title = JSON.stringify(result);

// Además de que exista: ¿responde una llamada real? (resultado: 'ok' o el error)
const CALLS = {
  alarms: () => chrome.alarms.getAll(),
  cookies: () => chrome.cookies.getAll({ url: 'https://example.com/' }),
  declarativeNetRequest: () => chrome.declarativeNetRequest.getDynamicRules(),
  downloads: () => chrome.downloads.search({}),
  idle: () => new Promise((r) => chrome.idle.queryState(60, r)),
  management: () => chrome.management.getAll(),
  notifications: () => chrome.notifications.getAll(),
  offscreen: () => chrome.offscreen.hasDocument(),
  power: () => (chrome.power.requestKeepAwake('display'), chrome.power.releaseKeepAwake(), Promise.resolve()),
  privacy: () => chrome.privacy.network.webRTCIPHandlingPolicy.get({}),
  proxy: () => chrome.proxy.settings.get({}),
  scripting: () => chrome.scripting.getRegisteredContentScripts(),
  storage: () => chrome.storage.local.get(null),
  'storage.sync': () => chrome.storage.sync.get(null),
  'storage.session': () => chrome.storage.session.get(null),
  'system.cpu': () => chrome.system.cpu.getInfo(),
  'system.display': () => chrome.system.display.getInfo(),
  'system.memory': () => chrome.system.memory.getInfo(),
  'system.storage': () => chrome.system.storage.getInfo(),
  tabs: () => chrome.tabs.query({}),
  topSites: () => chrome.topSites.get(),
  webNavigation: () => chrome.webNavigation.getAllFrames({ tabId: 1 }),
  windows: () => chrome.windows.getAll(),
  contextMenus: () => chrome.contextMenus.removeAll(),
  i18n: () => chrome.i18n.getAcceptLanguages(),
  permissions: () => chrome.permissions.getAll(),
  nativeMessaging: () => chrome.runtime.sendNativeMessage('com.callisto.inexistente', {}),
};
(async () => {
  const calls = {};
  for (const [k, f] of Object.entries(CALLS)) {
    try {
      await Promise.race([Promise.resolve().then(f), new Promise((_, rej) => setTimeout(() => rej(new Error('sin respuesta')), 1500))]);
      calls[k] = 'ok';
    } catch (e) {
      calls[k] = String(e && e.message ? e.message : e).slice(0, 80);
    }
  }
  document.title = JSON.stringify({ exists: result, calls });
})();
