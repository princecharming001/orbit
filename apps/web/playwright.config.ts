import { defineConfig } from '@playwright/test';

// E2E_PORT lets several checkouts run the suite at once without sharing a preview server.
const port = Number(process.env.E2E_PORT ?? 4173);
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}${process.env.ORBIT_BASE ?? '/orbit/'}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.E2E_PORT,
    timeout: 60_000,
  },
  reporter: [['list']],
});
