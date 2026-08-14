import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  // Tauri drives the dev server: fixed port, no screen clearing.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
