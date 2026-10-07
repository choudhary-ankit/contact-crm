import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // Same-origin in dev: /api/* -> NestJS on :3000 (no CORS needed)
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: { environment: 'jsdom', globals: false },
});
