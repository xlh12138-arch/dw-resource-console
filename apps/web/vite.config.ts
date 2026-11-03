import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 共享契约层直接引用 TS 源码，保证前后端类型同源
      '@dw/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ['@dw/shared'] },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // 开发态用同源代理访问后端，避免 CORS 与跨域 Cookie 问题
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
    fs: { allow: [repoRoot] },
  },
  build: { outDir: 'dist', sourcemap: true },
});
