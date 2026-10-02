import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:4173${process.env.ORBIT_BASE ?? '/orbit/'}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: { command: 'pnpm preview', port: 4173, reuseExistingServer: true, timeout: 60_000 },
  reporter: [['list']],
});
