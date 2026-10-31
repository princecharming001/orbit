import type { Page } from '@playwright/test';
import { createFakeOrbitApi, type FakeOrbitApi } from '../src/test/fakeOrbitApi';
import { prep } from './helpers';

/**
 * Account mode against the in-memory fake orbit-api, the way account.spec.ts does it: a browser under automation sets
 * `window.__ORBIT_API__` before the app loads (see src/integrations/orbitApi.ts), the tests point it at
 * `<app origin>/__fake-orbit-api`, a same-origin path the page's CSP allows, and every request there is answered by
 * `page.route` from the fake the unit tests use. Google's consent screen is the fake's /auth/google/start, which
 * redirects straight back to /auth/done with a login code. Nothing leaves the test.
 */
export async function withFakeApi(page: Page): Promise<FakeOrbitApi> {
  await prep(page);
  const base = `http://localhost:${process.env.E2E_PORT ?? 4173}/__fake-orbit-api`;
  const api = createFakeOrbitApi({ base });
  await page.addInitScript((b) => {
    (window as unknown as { __ORBIT_API__: string }).__ORBIT_API__ = b;
  }, base);
  await page.route(`${base}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith('/auth/google/start')) {
      // Google's consent screen, said yes to: straight back to the app with a one-time code
      const back = url.searchParams.get('redirect')!;
      await route.fulfill({ status: 302, headers: { location: `${back}/auth/done#code=${api.code}` } });
      return;
    }
    const res = await api.fetch(req.url(), {
      method: req.method(),
      headers: req.headers(),
      body: req.method() === 'POST' ? (req.postData() ?? '') : undefined,
    });
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
    });
  });
  return api;
}
