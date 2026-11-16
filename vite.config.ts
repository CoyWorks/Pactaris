import { defineConfig } from 'vite';
export default defineConfig({ root: 'apps/instance/web', base: '/', build: { outDir: '../../../dist/web', emptyOutDir: true } });
