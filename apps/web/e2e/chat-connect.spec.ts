import { expect, type Page, test } from '@playwright/test';

/**
 * Connecting LinkedIn and Gmail from the chat, and live LinkedIn (Unipile) plus warm intros (Village) across the app.
 * The demo runs on the mock connector, so connect, sync, mutual connections and warm intros all work with no keys
 * and no network; every test checks that nothing reached the connector proxy or the providers.
 */

/** A Tuesday morning (the demo is laid out on business days around "now"), no popups, and a log of requests. */
async function prep(page: Page): Promise<string[]> {
  await page.clock.install({ time: new Date('2026-10-06T10:00:00') });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const external: string[] = [];
  page.on('request', (r) => {
    // a call to the providers themselves; an app's logo from the icon service does not reach them
    const url = r.url();
    if (/orbit-connectors|unipile|village/i.test(url) && !url.startsWith('https://icons.duckduckgo.com/'))
      external.push(url);
  });
  return external;
}

/** Load the demo and wait for it, wherever the demo lands. */
async function loadDemo(page: Page): Promise<string[]> {
  const external = await prep(page);
  await page.goto('');
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 90_000 });
  return external;
}

const composer = (page: Page) => page.getByTestId('composer-input');
async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
}

/** The chat home for the loaded account. */
async function chatHome(page: Page) {
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

test.describe('Connect LinkedIn and Gmail, live LinkedIn and warm intros', () => {
  test.setTimeout(150_000);

  test('the demo: no connect strip, and the LinkedIn widget connects live with no popup', async ({
    page,
  }) => {
    const external = await loadDemo(page);
    await chatHome(page);
    await expect(page.getByTestId('chips')).toBeVisible();
    // the sample student has nothing to connect
    await expect(page.getByTestId('connect-strip')).toHaveCount(0);
    await ask(page, 'connect my linkedin');
    const widget = page.getByTestId('setup-linkedin');
    await expect(widget).toBeVisible();
    await expect(widget).toContainText('Connect your LinkedIn');
    // the export is the secondary path
    await expect(widget.getByTestId('linkedin-dropzone')).toHaveCount(0);
    await widget.getByTestId('linkedin-live-connect').click();
    await expect(widget.getByTestId('linkedin-done')).toContainText('4 people added', { timeout: 30_000 });
    await expect(widget.getByTestId('linkedin-live-connected')).toContainText('Synced live');
    await expect(widget).toContainText('LinkedIn is connected');
    await widget.getByTestId('linkedin-live-sync').click();
    await expect(widget.getByTestId('linkedin-done')).toContainText('0 people added', { timeout: 30_000 });
    expect(external).toEqual([]);
  });

  test('the demo: Settings connects, syncs and disconnects LinkedIn (live), and shows warm intros on', async ({
    page,
  }) => {
    const external = await loadDemo(page);
    await page.goto('settings/integrations');
    const card = page.getByTestId('settings-linkedin-live');
    await expect(card).toContainText('LinkedIn (live)');
    await card.getByTestId('settings-linkedin-live-connect').click();
    await expect(card.getByTestId('settings-linkedin-live-status')).toContainText(
      /Connected · \d+ connections · last synced/,
      {
        timeout: 30_000,
      },
    );
    await card.getByTestId('settings-linkedin-live-sync').click();
    await expect(page.getByTestId('toasts')).toContainText('LinkedIn synced: 0 new', { timeout: 30_000 });
    await card.getByTestId('settings-linkedin-live-disconnect').click();
    const confirm = page.getByTestId('settings-linkedin-live-confirm');
    await expect(confirm).toContainText('Everyone already in Orbit stays');
    await page.getByTestId('settings-linkedin-live-confirm-disconnect').click();
    await expect(card.getByTestId('settings-linkedin-live-status')).toHaveCount(0);
    await expect(card.getByTestId('settings-linkedin-live-connect')).toBeVisible();
    // the people stay (the list shows everyone; the board only people with a chat)
    await page.goto('people?view=list');
    await expect(page.getByText('Priya Raman').filter({ visible: true }).first()).toBeVisible();
    await page.goto('settings/integrations');
    await expect(page.getByTestId('settings-warm-intros-status')).toHaveText(/On/);
    await page.goto('settings/privacy');
    await expect(page.getByTestId('privacy-leaves')).toContainText(
      /LinkedIn\s*through Unipile, if you connect it live/,
    );
    expect(external).toEqual([]);
  });

  test('the demo: the routes card shows warm intros for a Stripe person and for Stripe itself', async ({
    page,
  }) => {
    const external = await loadDemo(page);
    await chatHome(page);
    await ask(page, 'warm intro to Daniel Okafor');
    const routes = page.getByTestId('result-routes').last();
    await expect(routes).toBeVisible();
    const warm = routes.getByTestId('warm-intro');
    await expect(warm.first()).toBeVisible();
    await expect(warm.first()).toContainText(/You → .+ → Daniel Okafor/);
    await expect(warm.first()).toContainText(/warm|good|a stretch/);
    await ask(page, 'warm intro to Stripe');
    const company = page.getByTestId('result-company').last();
    await expect(company).toBeVisible();
    await expect(company.getByTestId('warm-intro').first()).toContainText(/→ Stripe/);
    expect(external).toEqual([]);
  });

  test('the demo: a person page shows mutual connections, and the map shows warm intros you can act on', async ({
    page,
  }) => {
    const external = await loadDemo(page);
    // p9 is Maya Chen at Stripe in the demo
    await page.goto('people/p9');
    const mutuals = page.getByTestId('person-mutuals');
    await expect(mutuals).toContainText('Mutual connections');
    // her closest Stripe colleagues by tie score: a LinkedIn-connected alum ranks above a single unanswered email
    await expect(mutuals.getByTestId('person-mutual').filter({ hasText: 'Priya Ahmed' })).toBeVisible();
    // p1 is Daniel Okafor at Stripe
    await page.goto('map?reach=p1');
    // Village's warm intros join the routes: a tag on the route through the same person, or a route of their own
    const tagged = page.getByTestId('reach-path').filter({ has: page.getByTestId('reach-village') });
    const extra = page.getByTestId('map-warm-intro');
    await expect(tagged.or(extra).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Warm intros/)).toHaveCount(0);
    const ask = (await tagged.count())
      ? tagged.first().getByTestId('reach-path-action')
      : extra.first().getByTestId('map-warm-intro-ask');
    await ask.click();
    await expect(page.getByTestId('toasts')).toContainText('Intro request drafted');
    await page.goto('map?reach=1&company=Stripe');
    await expect(page.getByTestId('map-warm-intros').getByTestId('map-warm-intro').first()).toContainText(
      '→ Stripe',
      { timeout: 30_000 },
    );
    expect(external).toEqual([]);
  });

  test('a fresh account: the strip shows LinkedIn and Gmail missing, and Connect posts the widget', async ({
    page,
  }) => {
    const external = await prep(page);
    await page.goto('');
    await page.waitForFunction(() => !!(window as unknown as { __orbitDb?: unknown }).__orbitDb);
    await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: Record<'users' | 'settings' | 'kv', { put(row: unknown): Promise<unknown> }>;
        }
      ).__orbitDb;
      const now = new Date().toISOString();
      await db.users.put({
        id: 'u_fresh',
        email: 'jamie@umich.edu',
        fullName: 'Jamie Fresh',
        firstName: 'Jamie',
        lastName: 'Fresh',
        school: 'University of Michigan',
        majors: [],
        timezone: 'America/New_York',
        onboardingStep: 11,
        onboardingCompletedAt: now,
        createdAt: now,
      });
      await db.settings.put({
        userId: 'u_fresh',
        briefTimeLocal: '07:00',
        briefChannels: ['in_app'],
        quietDays: [],
        weeklyOutreachTarget: 4,
        dailySendCapGmail: 15,
        dailySendCapLinkedin: 10,
        perPersonCooldownHours: 72,
        maxBumps: 2,
        tonePreset: 'warm',
        warmUpEnabled: true,
        warmUpDays: 4,
      });
      await db.kv.put({ key: 'currentUserId', value: 'u_fresh' });
    });
    await chatHome(page);
    const strip = page.getByTestId('connect-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Connect your apps');
    await expect(page.getByTestId('connect-status-linkedin')).toHaveText(/Not connected/);
    // this build has no Google sign-in set up: Gmail is coming soon, with nothing to press
    await expect(page.getByTestId('connect-status-google')).toHaveText(/Coming soon/);
    await expect(page.getByTestId('connect-gmail')).toHaveCount(0);
    // an empty account's line under the greeting is the gentle setup one
    await expect(page.getByTestId('home-status')).toHaveText(/get you set up/);
    await page.getByTestId('connect-linkedin').click();
    await expect(page.getByTestId('turn-user').last()).toHaveText('Connect my LinkedIn.');
    await expect(page.getByTestId('setup-linkedin')).toBeVisible();
    // with a Google client id set, Gmail can be connected, and Connect Gmail posts the Gmail widget
    await page.evaluate(() =>
      localStorage.setItem(
        'orbit.prefs.v1',
        JSON.stringify({ googleClientId: 'e2e.apps.googleusercontent.com' }),
      ),
    );
    await page.reload();
    await chatHome(page);
    await expect(page.getByTestId('connect-status-google')).toHaveText(/Not connected/);
    await page.getByTestId('connect-gmail').click();
    await expect(page.getByTestId('setup-google')).toBeVisible();
    // dismissed, it stays away
    await chatHome(page);
    await page.getByTestId('connect-strip-dismiss').click();
    await expect(page.getByTestId('connect-strip')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('greeting')).toBeVisible();
    await expect(page.getByTestId('connect-strip')).toHaveCount(0);
    expect(external).toEqual([]);
  });
});
