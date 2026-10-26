import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri serves the build from disk; in a browser (`pnpm dev`) the client runs with a simulated sound card.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // In the browser, use this page's own address as the server: /api goes to a local API.
  server: { port: 5174, strictPort: true, proxy: { '/api': { target: process.env.HRS_API ?? 'http://127.0.0.1:8000' } } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
