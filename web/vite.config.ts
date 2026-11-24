import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Matches LILY_WEB_BASE_URL's local default in packages/shared/src/config.
    // The API's CORS allowlist is built from that value, so this port is not free
    // to drift.
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The marketing page is the first paint for every visitor, so the React
    // runtime is split out to keep it cached across app deploys. Matched by
    // path rather than by package name: a name list misses deep entry points
    // like react-dom/client, which silently leaves react-dom in the app chunk.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
