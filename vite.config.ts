import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'web',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    // Keep the browser's Host header so the server's same-origin check passes in dev.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
