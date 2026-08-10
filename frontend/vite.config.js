import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies /api -> FastAPI backend so the frontend can use
// same-origin relative URLs (no CORS in dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Listen on the LAN too, so you can open the app from your phone at
    // http://<pc-ip>:5174 (same Wi-Fi). The /api proxy below runs on the PC,
    // so the backend itself can stay loopback-only.
    host: true,
    proxy: {
      '/api': 'http://127.0.0.1:8001',
    },
  },
})
