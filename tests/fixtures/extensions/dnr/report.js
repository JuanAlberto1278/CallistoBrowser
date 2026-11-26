// Para la prueba: los conjuntos activos y apagar uno (como lo haría la configuración de un bloqueador)
window.reglas = {
  activas: () => chrome.declarativeNetRequest.getEnabledRulesets(),
  apagar: (id) => chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [id] }).then(() => chrome.declarativeNetRequest.getEnabledRulesets()),
};
