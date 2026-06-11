import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

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
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
