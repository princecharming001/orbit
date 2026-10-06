import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** The dev server injects an inline HMR preamble that the production CSP blocks, so drop the CSP tag in dev only. */
function stripCspInDev(): Plugin {
  return {
    name: 'orbit-strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, ''),
  };
}

export default defineConfig(({ mode }) => ({
  base: process.env.ORBIT_BASE ?? (mode === 'production' ? '/orbit/' : '/'),
  plugins: [react(), tailwindcss(), stripCspInDev()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
