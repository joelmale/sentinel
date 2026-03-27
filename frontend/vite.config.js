import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import path from 'path';

function resolveGitCommitHash() {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'dev';
    }
    catch {
        return 'dev';
    }
}

export default defineConfig({
    plugins: [react()],
    define: {
        __APP_COMMIT_HASH__: JSON.stringify(resolveGitCommitHash()),
    },
    // Force Vite/esbuild to pre-bundle maplibre-gl during the dep-optimisation
    // pass.  @vis.gl/react-maplibre loads it via a runtime dynamic import
    // (import('maplibre-gl')), which Vite's static scanner may not discover.
    // Without explicit inclusion, the UMD bundle can be served raw to the
    // browser before esbuild converts it to ESM, producing
    //   "Cannot read properties of undefined (reading 'Map')"
    // at the Map-constructor check in @vis.gl/react-maplibre/dist/components/map.js.
    optimizeDeps: {
        include: ['maplibre-gl'],
    },
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
                manualChunks: function (id) {
                    if (!id.includes('node_modules'))
                        return undefined;
                    if (id.includes('maplibre-gl') || id.includes('react-map-gl') || id.includes('@vis.gl/react-maplibre')) {
                        return 'map-vendor';
                    }
                    if (id.includes('@deck.gl') || id.includes('@luma.gl') || id.includes('@math.gl') || id.includes('@loaders.gl')) {
                        return 'deck-vendor';
                    }
                    if (id.includes('recharts') || id.includes('d3-')) {
                        return 'charts-vendor';
                    }
                    if (id.includes('@tanstack/react-query')) {
                        return 'query-vendor';
                    }
                    return 'vendor';
                },
            },
        },
    },
});
