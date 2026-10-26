import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** In development, /public/<station>/… pages are served by the public app, like the API does in production. */
const publicPages = (): Plugin => ({
  name: 'hrs-public-pages',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/public\/[^/?#]+/.test(req.url) && !req.url.includes('.')) req.url = '/public.html';
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), publicPages()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', ws: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), public: resolve(import.meta.dirname, 'public.html') } },
  },
});
