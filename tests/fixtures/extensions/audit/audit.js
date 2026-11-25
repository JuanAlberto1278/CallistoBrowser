// Cada prueba devuelve lo que pasó (o el error)
const run = async (f) => {
  try {
    return await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error('sin respuesta')), 4000))]);
  } catch (e) {
    return 'ERROR: ' + (e && e.message ? e.message : e);
  }
};
window.audit = {
  events: () => chrome.storage.local.get({ events: [] }).then((r) => r.events),
  download: (url) => run(() => chrome.downloads.download({ url })),
  downloadsSearch: () => run(() => chrome.downloads.search({}).then((l) => l.map((d) => [d.filename, d.state]))),
  capture: () => run(() => chrome.tabs.captureVisibleTab().then((u) => u.slice(0, 30))),
  offscreen: () => run(async () => {
    await chrome.offscreen.createDocument({ url: 'off.html', reasons: ['DOM_PARSER'], justification: 'prueba' });
    return chrome.runtime.sendMessage('ping-offscreen');
  }),
  topSites: () => run(() => chrome.topSites.get().then((l) => l.map((s) => s.url))),
  windowsCreate: (url) => run(() => chrome.windows.create({ url, type: 'popup', width: 400, height: 300 }).then((w) => [w.id, w.type])),
  discard: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); const d = await chrome.tabs.discard(t.id); return d && d.discarded; }),
  setZoom: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); await chrome.tabs.setZoom(t.id, 1.5); return chrome.tabs.getZoom(t.id); }),
  badge: () => run(async () => { await chrome.action.setBadgeText({ text: '7' }); return chrome.action.getBadgeText({}); }),
  uiLanguage: () => chrome.i18n.getUILanguage(),
  commandsAll: () => run(() => chrome.commands.getAll().then((l) => l.map((c) => [c.name, c.shortcut]))),
  pingSw: () => run(() => chrome.runtime.sendMessage('ping-sw')),
  alarm: () => run(() => chrome.alarms.create('a1', { when: Date.now() + 1000 }).then(() => 'ok')),
  notify: () => run(() => chrome.notifications.create('n1', { type: 'basic', iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', title: 'Hola', message: 'Prueba' })),
  tabsReload: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); await chrome.tabs.reload(t.id); return 'ok'; }),
  tabsDuplicate: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); const d = await chrome.tabs.duplicate(t.id); return d && d.url; }),
  tabsMove: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); const m = await chrome.tabs.move(t.id, { index: 0 }); return m.index; }),
  openOptions: () => run(() => chrome.runtime.openOptionsPage().then(() => 'ok')),
  // 1.4.2: las APIs nuevas, para que la prueba las llame (devuelven el resultado o 'ERROR: …')
  call: (path, ...args) => run(() => path.split('.').reduce((o, k) => o[k], chrome)(...args)),
  mhtml: (url) => run(async () => { const [t] = await chrome.tabs.query({ url }); const blob = await chrome.pageCapture.saveAsMHTML({ tabId: t.id }); return [blob.size, (await blob.text()).includes('to2')]; }),
  updateMenu: () => run(() => chrome.contextMenus.update('en-boton', { title: 'Ítem renombrado' }).then(() => 'ok')),
};
document.title = 'listo';
