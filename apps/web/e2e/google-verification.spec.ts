import { expect, test } from '@playwright/test';

/**
 * What Google's app verification reads: a public home page about Orbit (no sign-in, nothing that needs script), and a
 * privacy policy that names every Google permission Orbit's sign-in asks for. Google turned the app down once with
 * "Your home page is behind a login page"; these keep the pages it reads honest and reachable.
 */

/** Every Google permission, in the words the pages use for it. */
const PERMISSIONS = [
  'Gmail (read)',
  'Gmail (send)',
  'Google Calendar (read)',
  'Google Calendar (events)',
  'Google Contacts',
  'Google Meet',
];

test.describe('Google verification pages', () => {
  test.use({ javaScriptEnabled: false });

  test('the about page is public, plain HTML, about Orbit, with every permission and the policy links', async ({
    page,
  }) => {
    const res = await page.goto('about/');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Orbit/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Orbit');
    const text = await page.locator('body').innerText();
    for (const p of PERMISSIONS) expect(text).toContain(p);
    expect(text).toContain('Limited Use');
    // not a sign-in page: no password box, no sign-in form, no Google button
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.locator('form')).toHaveCount(0);
    expect(text).not.toMatch(/sign in with google/i);
    // the links Google follows
    await expect(page.locator('a[href="/privacy/"]').first()).toBeVisible();
    await expect(page.locator('a[href="/terms/"]').first()).toBeVisible();
    await expect(page.locator('a[href^="mailto:"]').first()).toBeVisible();
    // plain words, as everywhere in Orbit
    expect(text).not.toMatch(/[–—!]/);
  });

  test('the privacy policy names every permission the sign-in asks for, and the Limited Use statement', async ({
    page,
  }) => {
    const res = await page.goto('privacy/');
    expect(res?.status()).toBe(200);
    const text = await page.locator('body').innerText();
    for (const p of PERMISSIONS) expect(text).toContain(p);
    expect(text).toContain('Limited Use');
  });

  test('the home page, read without script, describes Orbit and links the about page and the policy', async ({
    page,
  }) => {
    const res = await page.goto('');
    expect(res?.status()).toBe(200);
    const about = page.locator('main.orbit-about');
    await expect(about).toBeVisible();
    await expect(about).toContainText('A networking assistant for college students');
    await expect(about.locator('a[href="/about/"]')).toBeVisible();
    await expect(about.locator('a[href="/privacy/"]')).toBeVisible();
  });
});

test('the landing page links the about page beside the privacy policy', async ({ page }) => {
  await page.goto('');
  await expect(page.getByTestId('landing-about')).toHaveAttribute('href', /about\/$/);
  await expect(page.getByTestId('landing-privacy-policy')).toHaveAttribute('href', /privacy\/$/);
});
