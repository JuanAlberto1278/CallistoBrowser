// Mitigación probada en V0.1: retrasar URL.revokeObjectURL para que una descarga blob:
// cancelada pueda volver a pedirse tras la autorización del usuario.
'use strict';
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: (delayMs) => {
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { setTimeout(() => original(url), delayMs); };
  },
  args: [120000],
});
