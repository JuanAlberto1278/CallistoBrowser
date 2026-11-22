// Corrección probada en V0.1: Chromium expone un espacio de nombres `browser` nativo e incompleto,
// distinto del `chrome` que completa electron-chrome-extensions. Se iguala `browser` a `chrome`
// (en Chrome, `browser` es un alias del mismo espacio de nombres).
'use strict';
const { contextBridge } = require('electron');

const alias = () => {
  if (typeof globalThis.chrome === 'object' && globalThis.browser !== globalThis.chrome) {
    try {
      Object.defineProperty(globalThis, 'browser', { value: globalThis.chrome, configurable: true, writable: true, enumerable: false });
    } catch (e) {
      console.error('callisto browser-alias failed', e);
    }
  }
};

if (process.type === 'service-worker' || (typeof location !== 'undefined' && location.href.startsWith('chrome-extension://'))) {
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: alias });
}
