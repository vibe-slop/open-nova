import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Bundle @open-nova/core (it's TypeScript with no build step); externalize
    // everything else (electron, node builtins).
    plugins: [externalizeDepsPlugin({ exclude: ['@open-nova/core'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    // Bundle @open-nova/core (it's TypeScript with no build step); externalize
    // everything else (electron, node builtins).
    plugins: [externalizeDepsPlugin({ exclude: ['@open-nova/core'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
