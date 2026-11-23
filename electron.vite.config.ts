import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      // Las dependencias (electron-chrome-extensions/browser-action) van DENTRO del preload: en sandbox no puede cargar
      // módulos de node_modules
      externalizeDeps: false,
      rollupOptions: {
        // Los preloads en sandbox deben ser CommonJS de un solo archivo: ningún módulo con código puede ser compartido por
        // dos preloads (iría a un archivo aparte que el preload no puede cargar). Lo comprueban las pruebas e2e.
        output: { format: 'cjs', entryFileNames: '[name].js' },
        input: {
          // Interfaz del navegador (privilegiada, expone una API mínima)
          ui: resolve(__dirname, 'src/preload/ui.ts'),
          // Se inyecta en TODAS las páginas web: no expone nada, solo corrige capacidades WebAuthn
          'web-content': resolve(__dirname, 'src/preload/web-content.ts'),
          // Páginas internas (historial, configuración): API acotada a cada página
          internal: resolve(__dirname, 'src/preload/internal.ts'),
          // Menú de sugerencias de contraseñas (vista propia de la interfaz)
          autofill: resolve(__dirname, 'src/preload/autofill.ts'),
          // Páginas y service workers de las extensiones: `browser` = `chrome` y las APIs de Callisto
          'extension-apis': resolve(__dirname, 'src/preload/extension-apis.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          // Interfaz del navegador (callisto://ui)
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Páginas internas (callisto://history, callisto://settings)
          history: resolve(__dirname, 'src/renderer/history.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          downloads: resolve(__dirname, 'src/renderer/downloads.html'),
          bookmarks: resolve(__dirname, 'src/renderer/bookmarks.html'),
          profiles: resolve(__dirname, 'src/renderer/profiles.html'),
          passwords: resolve(__dirname, 'src/renderer/passwords.html'),
          extensions: resolve(__dirname, 'src/renderer/extensions.html'),
          // Menú de sugerencias de contraseñas (callisto://ui/autofill.html)
          autofill: resolve(__dirname, 'src/renderer/autofill.html'),
        },
      },
    },
  },
});
