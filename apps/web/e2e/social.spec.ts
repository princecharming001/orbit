import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * Instagram and X on the demo account (plan 43 §8.7): the sample student's made-up accounts. Connect Instagram and see
 * it read, check the target and see the bridge on the person's page, in the routes card with the platform named and in
 * the Map's list, detach a wrong match, switch Instagram off and see the path go; X's consent, then a check that shows
 * its price first. Nothing leaves the browser.
 */

const TARGET = 'p_social_jules';
const composer = (page: Page) => page.getByTestId('composer-input');
async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
}

async function connectInstagram(page: Page) {
  await page.goto('settings/integrations');
  const row = page.getByTestId('settings-instagram');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('settings-instagram-status')).toHaveText('Not connected');
  await page.getByTestId('settings-instagram-switch').click();
  await expect(page.getByTestId('instagram-risk')).toContainText('Instagram does not allow automation');
  await page.getByTestId('instagram-connect').click();
  // reading step by step, then up to date
  await expect(page.getByTestId('settings-instagram-status')).toContainText(/On · @/);
  await expect(page.getByTestId('settings-instagram-status')).toContainText('up to date', {
    timeout: 20_000,
  });
  // the friends' switch is off by default
  await expect(page.getByTestId('settings-instagram-share-switch')).toHaveAttribute('aria-checked', 'false');
}

test.describe('Instagram and X on the demo', () => {
  test.setTimeout(240_000);

  test('connect Instagram, check a target, see the bridge, detach a wrong match, switch it off', async ({
    page,
  }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      // the platforms themselves (an app's logo from the icon service does not reach them)
      const host = new URL(r.url()).hostname;
      if (/(^|\.)(instagram\.com|ig\.me|unipile\.com|x\.com|twitter\.com)$/i.test(host))
        external.push(r.url());
    });
    await loadDemo(page);
    await connectInstagram(page);

    // the target's page: her handle, and the check
    await page.goto(`people/${TARGET}`);
    await expect(page.getByTestId('person-instagram-handle')).toContainText('@jules.makes');
    await page.getByTestId('check-instagram').click();
    const bridge = page.getByTestId('check-instagram-bridge').first();
    await expect(bridge).toContainText(/follow each other on Instagram/, { timeout: 20_000 });
    await expect(bridge.getByRole('link').first()).toHaveAttribute('href', /\/people\//);
    await expect(page.getByTestId('social-bridge-evidence').first()).toContainText('from Instagram');
    await page.screenshot({ path: 'test-results/social-person.png', fullPage: true });

    // the routes card names the platform
    await page.goto('');
    await ask(page, 'warm intro to Jules Moreau');
    const routes = page.getByTestId('result-routes').last();
    await expect(routes).toBeVisible({ timeout: 30_000 });
    await expect(routes.getByTestId('route-platform').first()).toContainText('on Instagram');
    await page.screenshot({ path: 'test-results/social-routes.png' });

    // the Map's "People who know" list says it too
    await page.goto(`map?reach=${TARGET}`);
    await expect(page.getByTestId('social-bridge').first()).toContainText('from Instagram', {
      timeout: 30_000,
    });

    // a wrong match: "Not their account", after a question
    const wrong = await page.evaluate(async () => {
      const idb: IDBDatabase = await new Promise((res, rej) => {
        const o = indexedDB.open('orbit');
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      const rows: { personId: string; via: string; platform: string }[] = await new Promise((res) => {
        const r = idb.transaction('socialLinks').objectStore('socialLinks').getAll();
        r.onsuccess = () => res(r.result);
      });
      idb.close();
      return rows.find((l) => l.via === 'score' && l.platform === 'instagram')!.personId;
    });
    await page.goto(`people/${wrong}`);
    await expect(page.getByTestId('person-social')).toContainText('.photo');
    await page.getByTestId('person-social-detach').first().click();
    await expect(page.getByTestId('person-social-detach-confirm')).toContainText('takes the account off');
    await page.getByTestId('person-social-detach-yes').click();
    await expect(page.getByTestId('toasts')).toContainText('is no longer attached');
    await expect(page.getByTestId('person-instagram-handle')).toHaveCount(0);

    // Off: the path through Instagram goes, the handle is hidden
    await page.goto('settings/integrations');
    await page.getByTestId('settings-instagram-switch').click();
    await expect(page.getByTestId('settings-instagram-status')).toHaveText(
      'Off · kept, left out of closeness and paths',
    );
    await page.goto(`people/${TARGET}`);
    await expect(page.getByTestId('person-instagram-handle')).toHaveCount(0);
    await expect(page.getByTestId('check-instagram')).toHaveCount(0);
    await page.goto('');
    await ask(page, 'warm intro to Jules Moreau');
    await expect(
      page.getByTestId('result-routes').last().or(page.getByTestId('result-text').last()),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('route-platform')).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test('X: what Orbit stores first, then a check that shows its price before reading', async ({ page }) => {
    await loadDemo(page);
    await connectInstagram(page);
    await page.getByTestId('settings-x-switch').click();
    await expect(page.getByTestId('x-consent-lines')).toContainText('Your last 30 days of X messages');
    await expect(page.getByTestId('x-connect')).toBeDisabled();
    await page.getByTestId('x-consent-agree').check();
    await page.getByTestId('x-connect').click();
    await expect(page.getByTestId('settings-x-status')).toContainText(/On · @.+ · \$0 of \$15 this month/);
    await page.screenshot({ path: 'test-results/social-settings.png', fullPage: true });

    await page.goto(`people/${TARGET}`);
    await page.getByTestId('check-x').click();
    await expect(page.getByTestId('x-quote-line')).toHaveText(
      'This reads about 400 people on X and costs about $4. Go ahead?',
    );
    // nothing is read until the student says go
    await expect(page.getByTestId('check-x-result')).toHaveCount(0);
    await page.getByTestId('x-quote-go').click();
    await expect(page.getByTestId('check-x-bridge').first()).toContainText('follow each other on X', {
      timeout: 20_000,
    });
    await page.goto('settings/integrations');
    await expect(page.getByTestId('settings-x-status')).toContainText('$4 of $15 this month');
    // X has no friends' switch: its data is never shared
    await expect(page.getByTestId('settings-x').getByRole('switch')).toHaveCount(1);
  });

  test('the same-person question shows on the person page and Yes attaches it', async ({ page }) => {
    await loadDemo(page);
    await connectInstagram(page);
    const asked = await page.evaluate(async () => {
      const idb: IDBDatabase = await new Promise((res, rej) => {
        const o = indexedDB.open('orbit');
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      const rows: { personId: string }[] = await new Promise((res) => {
        const r = idb.transaction('socialAsks').objectStore('socialAsks').getAll();
        r.onsuccess = () => res(r.result);
      });
      idb.close();
      return rows[0]!.personId;
    });
    await page.goto(`people/${asked}`);
    await expect(page.getByTestId('social-ask-question')).toContainText(
      /^Is @.+ on Instagram the .+ you know/,
    );
    await expect(page.getByTestId('social-ask-for')).toContainText('The same name');
    await expect(page.getByTestId('social-ask-against')).toBeVisible();
    await page.getByTestId('social-ask-yes').click();
    await expect(page.getByTestId('social-ask')).toHaveCount(0);
    await expect(page.getByTestId('person-instagram-handle')).toBeVisible();
  });
});
