import { defineConfig } from 'vite';

export default defineConfig({
  root: 'viewer',
  build: {
    outDir: '../dist-viewer',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4174,
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
});
