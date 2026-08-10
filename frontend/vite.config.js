import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies /api -> FastAPI backend so the frontend can use
// same-origin relative URLs (no CORS in dev).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on the LAN too, so phones on the same Wi-Fi can open the app
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8001',
    },
  },
})
