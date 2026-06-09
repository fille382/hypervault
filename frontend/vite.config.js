import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies /api -> FastAPI backend so the frontend can use
// same-origin relative URLs (no CORS in dev).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8001',
    },
  },
})
