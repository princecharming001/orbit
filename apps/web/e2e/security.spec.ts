import { expect, type Page, test } from '@playwright/test';

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

async function prep(page: Page) {
  await page.addInitScript(() => {
    window.open = () => null;
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  // Never let a test reach the real API: answer as Anthropic does for a bad key.
  await page.route('https://api.anthropic.com/**', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    }),
  );
}

async function loadDemo(page: Page) {
  await prep(page);
  await page.goto('');
  await page.getByRole('button', { name: /try it with demo data/i }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 90_000 });
}

test.describe('security', () => {
  test('the built app runs under its Content-Security-Policy without violations, and inline script is blocked', async ({
    page,
  }) => {
    await loadDemo(page);
    for (const path of [
      'pipeline',
      'people',
      'map',
      'inbox',
      'settings/integrations',
      'settings/privacy',
      'today',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client");
    expect(csp).toContain('connect-src');
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

    const ran = await page.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'window.__injected = true';
      document.body.appendChild(s);
      await new Promise((r) => setTimeout(r, 50));
      return (window as unknown as { __injected?: boolean }).__injected ?? false;
    });
    expect(ran).toBe(false);
    expect((await page.evaluate(() => window.__cspViolations)).some((v) => v.startsWith('script-src'))).toBe(
      true,
    );
  });

  test('a key saved by an older build moves out of localStorage; Claude use is opt-in per feature', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.evaluate(() =>
      localStorage.setItem('orbit.prefs.v1', JSON.stringify({ anthropicApiKey: 'sk-ant-e2e' })),
    );
    await page.goto('settings/integrations');
    await expect(page.getByText('Key saved.')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('orbit.prefs.v1'))).toBeNull();
    await expect(page.getByTestId('ai-feature-drafts')).toBeChecked();
    await expect(page.getByTestId('ai-feature-emailTriage')).not.toBeChecked();
    await expect(
      page.getByText('The text of emails is sent to Anthropic to sort them', { exact: false }),
    ).toBeVisible();
    await page.getByTestId('ai-feature-emailTriage').check();
    // daily limits and usage are advanced settings, behind a disclosure
    await expect(page.getByTestId('ai-cap-requests')).toBeHidden();
    await page.getByTestId('ai-advanced').locator('summary').click();
    await page.getByTestId('ai-cap-requests').fill('20');
    await page.waitForTimeout(200);
    await page.reload();
    await expect(page.getByTestId('ai-feature-emailTriage')).toBeChecked();
    await page.getByTestId('ai-advanced').locator('summary').click();
    await expect(page.getByTestId('ai-cap-requests')).toHaveValue('20');
    await expect(page.getByTestId('ai-usage-today')).toContainText('of 20 requests');

    await page.goto('settings/privacy');
    await expect(page.getByTestId('export-contents')).toContainText('full email text and headers');
    await expect(page.getByTestId('export-contents')).toContainText('does not include your Anthropic key');
  });
});
