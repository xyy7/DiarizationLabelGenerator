import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    // The API container publishes 8000. In production the same FastAPI app
    // serves these static files, so /api is same-origin there and this proxy
    // exists only for `npm run dev`.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
