import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  optimizeDeps: {
    // maplibre-gl ships a malformed source map in this environment.
    // Excluding it from prebundling avoids esbuild trying to parse it.
    exclude: ['maplibre-gl'],
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, the API is exposed directly on port 8000 (see docker-compose.dev.yml).
      // Requests to /api/* and /ws/* are forwarded straight to FastAPI,
      // bypassing Caddy entirely — same as pointing a debugger at the process.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
