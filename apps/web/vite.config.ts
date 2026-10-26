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

/**
 * Account mode (VITE_ORBIT_API): the page may call that orbit-api, so its origin joins the CSP's connect-src. Without
 * the variable the policy is left exactly as written.
 */
function allowOrbitApi(): Plugin {
  return {
    name: 'orbit-allow-orbit-api',
    transformIndexHtml: (html) => {
      const raw = process.env.VITE_ORBIT_API?.trim();
      if (!raw) return html;
      let origin: string;
      try {
        origin = new URL(raw).origin;
      } catch {
        return html;
      }
      return html.replace(/connect-src ([^;"]*)/, (m, list: string) =>
        list.split(/\s+/).includes(origin) ? m : `connect-src ${list} ${origin}`,
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: process.env.ORBIT_BASE ?? (mode === 'production' ? '/orbit/' : '/'),
  plugins: [react(), tailwindcss(), stripCspInDev(), allowOrbitApi()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // libraries that change rarely get chunks of their own, so a deploy leaves them cached
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'react';
          if (/[\\/]node_modules[\\/]dexie[\\/]/.test(id)) return 'dexie';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
