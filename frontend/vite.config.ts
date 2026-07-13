import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // PORT lets a second instance (e.g. the Claude preview harness) run
    // alongside the default dev server on 5173.
    port: Number(process.env.PORT) || 5173,
    host: '127.0.0.1',
    proxy: {
      // Use explicit IPv4 — `localhost` can resolve to ::1 (IPv6) while the
      // backend listens on 127.0.0.1, which surfaces as an intermittent
      // ECONNREFUSED on /api. 127.0.0.1 matches the backend and avoids it.
      '/api': 'http://127.0.0.1:3001',
    },
  },
})
