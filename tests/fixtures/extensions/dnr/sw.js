// Reglas que la extensión agrega por código, al instalarse: dinámicas (se guardan) y de sesión (duran la sesión)
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [10], addRules: [{ id: 10, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'dinamica=1', resourceTypes: ['main_frame'] } }] });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [20], addRules: [{ id: 20, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'sesion=1', resourceTypes: ['main_frame'] } }] });
});
