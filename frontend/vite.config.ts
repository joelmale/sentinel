import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      child_process: path.resolve(__dirname, './src/shims/child-process-browser.ts'),
    },
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
    // MapLibre is intrinsically large; use intentional vendor chunking so the
    // warning reflects real regressions instead of the baseline map payload.
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('maplibre-gl') || id.includes('react-map-gl') || id.includes('@vis.gl/react-maplibre')) {
            return 'map-vendor'
          }
          if (id.includes('@deck.gl') || id.includes('@luma.gl') || id.includes('@math.gl') || id.includes('@loaders.gl')) {
            return 'deck-vendor'
          }
          if (id.includes('recharts') || id.includes('d3-')) {
            return 'charts-vendor'
          }
          if (id.includes('@tanstack/react-query')) {
            return 'query-vendor'
          }
          return 'vendor'
        },
      },
    },
  },
})
