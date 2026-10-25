import { expect, type Page, test } from '@playwright/test';
import { createFakeOrbitApi, type FakeOrbitApi, fakeDossier } from '../src/test/fakeOrbitApi';
import { prep } from './helpers';

/**
 * Account mode (plan 16 §17, §19 P6) against a mocked orbit-api, on the same build as every other test.
 *
 * How it works: account mode is normally a build flag (VITE_ORBIT_API). A browser under automation may instead set
 * `window.__ORBIT_API__` before the app loads (see src/integrations/orbitApi.ts); these tests point it at
 * `<app origin>/__fake-orbit-api`, a same-origin path the page's CSP allows, and answer every request there with
 * `page.route` from the in-memory fake the unit tests use (src/test/fakeOrbitApi.ts). Google's consent screen is the
 * fake's /auth/google/start, which redirects straight back to /auth/done with a login code. Nothing leaves the test.
 */

const P1 = '0b8f6a0e-1111-4c2e-8d1a-000000000001';
const P2 = '0b8f6a0e-1111-4c2e-8d1a-000000000002';
const P3 = '0b8f6a0e-1111-4c2e-8d1a-000000000003';

async function withFakeApi(page: Page): Promise<FakeOrbitApi> {
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

function seedNetwork(api: FakeOrbitApi) {
  const u = api.state.user.id;
  const at = '2026-10-05T12:00:00.000Z';
  const person = (id: string, name: string, title: string, org: string, score: number, band: string) => ({
    id,
    userId: u,
    displayName: name,
    currentTitle: title,
    currentOrganizationRaw: org,
    primaryEmail: `${name.split(' ')[0]!.toLowerCase()}@${org.toLowerCase()}.com`,
    emails: [`${name.split(' ')[0]!.toLowerCase()}@${org.toLowerCase()}.com`],
    sources: ['gmail'],
    tieScore: score,
    tieBand: band,
    tieExplanation: ['14 messages between you (6 from them)', 'You both went to Cornell'],
    lastInteractionAt: at,
    interactionCount: 14,
    createdAt: at,
    updatedAt: at,
  });
  api.state.status.counts = {
    people: 186,
    messages: 1240,
    threads: 300,
    ties: 410,
    goals: 0,
    chats: 0,
    drafts: 0,
  };
  api.state.pages.push({
    changes: {
      people: [
        person(P1, 'Priya Shah', 'Product Lead', 'Stripe', 78, 'strong'),
        person(P2, 'Sam Lee', 'Engineer', 'Ramp', 45, 'warm'),
        person(P3, 'Dana Ruiz', 'Designer', 'Figma', 22, 'light'),
      ],
    },
  });
  api.state.scores.set(P1, {
    score: 78,
    band: 'strong',
    explanation: [
      '14 messages between you (6 from them)',
      '3 meetings in the last 2 years',
      'You both went to Cornell',
    ],
  });
}

test.describe('account mode (mocked orbit-api)', () => {
  test('Log in on the landing page: an account that finished setup elsewhere goes straight to Orbit', async ({
    page,
  }) => {
    const api = await withFakeApi(page);
    seedNetwork(api);
    api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
    await page.goto('');
    await page.getByTestId('landing-login').click();
    await expect(page).toHaveURL(/\/(orbit\/?)?$/, { timeout: 20_000 });
    expect(page.url()).not.toContain('code=');
    expect(api.routes()).toContain('/auth/session');
    // the chat, Orbit's home, not setup and not the landing page
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('landing-login')).toHaveCount(0);
  });

  test('sign in with Google, see the import, pick goals, rate people and land on the first brief', async ({
    page,
  }) => {
    const api = await withFakeApi(page);
    seedNetwork(api);
    await page.goto('');
    await page
      .getByRole('button', { name: /^get started/i })
      .first()
      .click();
    await expect(page.getByTestId('ob-welcome')).toBeVisible();
    await page.getByTestId('ob-google-signin').click();
    // /auth/done trades the code for a session and goes on to You, with Google's name and email filled in
    await expect(page).toHaveURL(/\/onboarding\/1$/, { timeout: 20_000 });
    expect(page.url()).not.toContain('code=');
    expect(api.routes()).toContain('/auth/session');
    await expect(page.getByTestId('ob-import-progress')).toContainText(
      "Hi Maya. I'm reading your last 90 days of email first.",
    );
    await expect(page.getByTestId('ob-import-count')).toHaveText('1,240 messages · 186 people so far');
    await expect(page.getByTestId('ob-name')).toHaveValue('Maya Lin');
    await expect(page.getByTestId('ob-email')).toHaveValue('maya@cornell.edu');
    await page.getByTestId('ob-year').selectOption('2027');
    await page.getByRole('button', { name: /^continue$/i }).click();
    // Goals: every kind is offered; recruiting starts picked
    await expect(page.getByTestId('ob-goal-recruiting')).toHaveAttribute('aria-pressed', 'true');
    for (const k of ['fundraising', 'sales', 'hiring', 'advice', 'cofounder', 'community', 'collaboration'])
      await expect(page.getByTestId(`ob-goal-${k}`)).toBeVisible();
    await page.getByTestId('ob-goal-fundraising').click();
    await page.getByTestId('ob-fn-pm').click();
    await page.getByRole('button', { name: /^continue$/i }).click();
    // LinkedIn: the risk in one sentence before connecting live, the export next to it
    await expect(page.getByTestId('ob-linkedin-risk')).toContainText("LinkedIn's terms");
    await expect(page.getByTestId('ob-linkedin-upload')).toBeVisible();
    await expect.poll(() => api.state.goals.map((g) => g.kind).sort()).toEqual(['fundraising', 'recruiting']);
    await page.getByTestId('ob-skip').click();
    // Rate a few people (optional): one rating goes to the server
    await expect(page.getByRole('heading', { name: 'Rate a few people' })).toBeVisible();
    await expect(page.getByTestId('ob-rate-person')).toHaveCount(3);
    await page.getByTestId('ob-rate-person').first().getByTestId('closeness-4').click();
    await expect.poll(() => api.state.labels.get(P1)).toBe(4);
    await page.getByTestId('ob-rate-done').click();
    await expect(page.getByTestId('ob-ready-gmail')).toContainText('Connected as maya@cornell.edu');
    await expect(page.getByTestId('ob-ready-goals')).toContainText(/Product management and Fundraising/i);
    await page.getByRole('button', { name: /open orbit/i }).click();
    await expect(page.getByTestId('greeting')).toContainText(/Hey Maya/, { timeout: 30_000 });
    // the first brief is built in the browser from what the server sent, and Gmail counts as connected
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = (
            window as unknown as { __orbitDb: { briefs: { toArray(): Promise<{ kind: string }[]> } } }
          ).__orbitDb;
          return (await db.briefs.toArray()).map((b) => b.kind);
        }),
      )
      .toContain('welcome');
    await expect(page.getByTestId('home-status')).not.toContainText(/Gmail/);
    await page.goto('people?view=list');
    await expect(page.getByText('Priya Shah').locator('visible=true').first()).toBeVisible();
  });

  test('access denied at Google says invite-only and offers Orbit without Google', async ({ page }) => {
    await withFakeApi(page);
    await page.goto('auth/done#error=access_denied');
    await expect(page.getByTestId('auth-error')).toContainText('invite-only during the pilot');
    expect(page.url()).not.toContain('error=');
    await page.getByTestId('auth-without-google').click();
    await expect(page).toHaveURL(/\/onboarding\/\d/);
  });

  test.describe('signed in', () => {
    async function signedIn(page: Page): Promise<FakeOrbitApi> {
      const api = await withFakeApi(page);
      seedNetwork(api);
      await page.goto('');
      await page
        .getByRole('button', { name: /^get started/i })
        .first()
        .click();
      await page.getByTestId('ob-google-signin').click();
      await expect(page).toHaveURL(/\/onboarding\/1$/, { timeout: 20_000 });
      await page.getByTestId('ob-year').selectOption('2027');
      await page.getByRole('button', { name: /^continue$/i }).click();
      await page.getByTestId('ob-fn-pm').click();
      await page.getByRole('button', { name: /^continue$/i }).click();
      await page.getByTestId('ob-skip').click();
      await page.getByTestId('ob-skip').click();
      await page.getByRole('button', { name: /open orbit/i }).click();
      await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 30_000 });
      return api;
    }

    test('person page: score with its reasons, Not right?, and a researched dossier with sources', async ({
      page,
    }) => {
      const api = await signedIn(page);
      api.state.researchQueue.set(P1, fakeDossier(api.state.user.id, P1));
      await page.goto(`people/${P1}`);
      await expect(page.getByTestId('person-score')).toHaveText('78 · Strong');
      await expect(page.getByTestId('person-score-why')).toContainText('3 meetings in the last 2 years');
      await page.getByTestId('person-score-not-right').click();
      await page.getByTestId('person-score-card').getByTestId('closeness-5').click();
      await expect(page.getByTestId('person-score')).toHaveText('90 · Close');
      await expect.poll(() => api.state.labels.get(P1)).toBe(5);
      // research: queued, then ready, with numbered sources
      await page.getByTestId('dossier-research').click();
      await expect(page.getByTestId('dossier-content')).toBeVisible({ timeout: 20_000 });
      // the card says who they are; the whole brief, openers and links included, is on About
      await page.getByTestId('dossier-open-about').click();
      const debrief = page.getByTestId('research-debrief');
      await expect(debrief.getByTestId('debrief-openers')).toContainText(
        'Your talk on fraud models stuck with me.',
      );
      await expect(debrief.getByTestId('debrief-ref').first()).toHaveAttribute('href', /example\.com/);
    });

    test('Discover, Find people: search, see who you know, add one', async ({ page }) => {
      const api = await signedIn(page);
      api.state.sourced = [
        {
          id: 'rec_a',
          name: 'Rhea Kapoor',
          title: 'Partner',
          org: 'Seedling Fund',
          source: 'exa',
          rank: 0.8,
          fit: 0.9,
          reach: 0.4,
          responsiveness: 0.5,
          reasons: ['Leads seed rounds in climate software'],
        },
        {
          id: 'rec_b',
          name: 'Sam Lee',
          title: 'Engineer',
          org: 'Ramp',
          source: 'apollo',
          rank: 0.6,
          fit: 0.6,
          reach: 0.9,
          responsiveness: 0.5,
          reasons: ['Knows the climate team'],
          knownPersonId: P2,
        },
      ];
      await page.goto('discover?tab=find');
      await page.getByTestId('find-purpose-fundraising').click();
      await page.getByTestId('find-query').fill('seed investors in climate software');
      await page.getByTestId('find-search').click();
      await expect(page.getByTestId('find-result')).toHaveCount(2);
      await expect(page.getByTestId('find-result').nth(1)).toContainText('You know them');
      await expect(page.getByTestId('find-quiet')).toContainText('Not searched yet: Apollo');
      await page.getByTestId('find-add').first().click();
      await expect(
        page
          .getByTestId('find-result')
          .first()
          .getByRole('link', { name: /added, open/i }),
      ).toBeVisible();
      expect(api.calls.find((c) => c.route === '/source/add')?.body).toEqual({
        recommendationIds: ['rec_a'],
      });
    });

    test('Drafts, Replies: draft a reply with times, approve it; LinkedIn needs a second tap', async ({
      page,
    }) => {
      const api = await signedIn(page);
      api.state.replies = [
        {
          messageId: 'm1',
          threadId: 't1',
          personId: P1,
          personName: 'Priya Shah',
          channel: 'gmail',
          replyClass: 'scheduling',
          confidence: 0.9,
          receivedAt: '2026-10-06T08:00:00.000Z',
          snippet: 'Happy to chat. What times work next week?',
          draftId: null,
        },
        {
          messageId: 'm2',
          threadId: 't2',
          personId: P2,
          personName: 'Sam Lee',
          channel: 'linkedin',
          replyClass: 'interested',
          confidence: 0.8,
          receivedAt: '2026-10-05T08:00:00.000Z',
          snippet: 'Sounds great.',
          draftId: null,
        },
      ];
      await page.goto('inbox?tab=replies');
      const cards = page.getByTestId('reply-card');
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toContainText('Picking a time');
      await cards.first().getByTestId('reply-draft-button').click();
      await expect(cards.first().getByTestId('reply-slot')).toHaveCount(3);
      await cards.first().getByTestId('reply-approve').click();
      await expect(cards.first().getByTestId('reply-approved')).toContainText('Approved. It goes out');
      // LinkedIn: Approve asks once more before anything goes
      await cards.nth(1).getByTestId('reply-draft-button').click();
      await cards.nth(1).getByTestId('reply-approve').click();
      await expect(cards.nth(1).getByTestId('reply-confirm')).toContainText('your own LinkedIn account');
      expect(api.calls.filter((c) => c.route === '/drafts/approve')).toHaveLength(1);
      await cards.nth(1).getByTestId('reply-confirm-yes').click();
      await expect(cards.nth(1).getByTestId('reply-approved')).toBeVisible();
      expect(api.calls.filter((c) => c.route === '/drafts/approve').at(-1)?.body).toMatchObject({
        confirm: true,
      });
    });

    test('Settings: the postal address and the booking link reach the server', async ({ page }) => {
      const api = await signedIn(page);
      await page.goto('settings/outreach');
      await page.getByTestId('settings-postal').fill('20 Elm St, Ithaca, NY 14850');
      await page.getByTestId('settings-postal').blur();
      await expect.poll(() => api.state.profile.postalAddress).toBe('20 Elm St, Ithaca, NY 14850');
      await page.goto('settings/integrations');
      await page.locator('#lim-sched').fill('https://cal.com/maya/20min');
      await expect.poll(() => api.state.profile.schedulingLink).toBe('https://cal.com/maya/20min');
      // what the server holds comes back after a reload too
      await page.reload();
      await expect(page.locator('#lim-sched')).toHaveValue('https://cal.com/maya/20min');
    });

    test('Settings: the Google row says what the server says, and offers Sign in again when signed out', async ({
      page,
    }) => {
      const api = await signedIn(page);
      await page.goto('settings/integrations');
      await expect(page.getByTestId('google-via-account-status')).toContainText(
        'Connected as maya@cornell.edu',
      );
      api.state.status.google.status = 'needs_reauth';
      await page.reload();
      await expect(page.getByTestId('google-via-account-status')).toContainText('Signed out by Google');
      await expect(page.getByTestId('google-via-account-signin')).toBeVisible();
    });

    test('Chat: a goal the student talks about is offered, and tracked on yes', async ({ page }) => {
      const api = await signedIn(page);
      api.state.proposals = [
        {
          kind: 'fundraising',
          title: 'Raise a pre-seed round',
          targets: { organizations: [], roles: ['angel investor'], geographies: [], people: [] },
          criteria: {},
          successMetric: null,
          dueAt: null,
          isUpdateOf: null,
          quote: "I'm trying to raise a pre-seed round",
        },
      ];
      api.state.extractable = [
        { text: 'Is raising a pre-seed round for a climate startup', kind: 'goal_detail' },
      ];
      await page
        .getByTestId('composer-input')
        .fill("I'm trying to raise a pre-seed round for my climate startup");
      await page.keyboard.press('Enter');
      await expect(
        page.getByText('Want me to track this as a goal? Fundraising: Raise a pre-seed round.'),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect
        .poll(() => api.state.memories.map((m) => m.text))
        .toContain('Is raising a pre-seed round for a climate startup');
      // offered, not saved
      const goals = () => api.state.goals.map((g) => `${g.kind}: ${g.title}`);
      expect(goals()).not.toContain('fundraising: Raise a pre-seed round');
      await page.getByTestId('choice-pill').filter({ hasText: 'Yes, track it' }).click();
      await expect.poll(goals).toContain('fundraising: Raise a pre-seed round');
    });

    test('Settings, Memory: list and delete; Account shows who is signed in', async ({ page }) => {
      const api = await signedIn(page);
      api.state.memories = [
        {
          id: 'mem_1',
          kind: 'preference',
          text: 'Prefers morning calls',
          personId: null,
          importance: 0.6,
          createdAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: '2026-10-01T10:00:00.000Z',
        },
        {
          id: 'mem_2',
          kind: 'person_fact',
          text: 'Priya prefers LinkedIn',
          personId: P1,
          importance: 0.5,
          createdAt: '2026-10-02T10:00:00.000Z',
          lastSeenAt: '2026-10-02T10:00:00.000Z',
        },
      ];
      await page.goto('settings/memory');
      await expect(page.getByTestId('memory-item')).toHaveCount(2);
      await expect(page.getByTestId('memory-item').nth(1)).toContainText('Priya Shah');
      await page.getByTestId('memory-delete').first().click();
      await expect(page.getByTestId('memory-item')).toHaveCount(1);
      expect(api.state.memories.map((m) => m.id)).toEqual(['mem_2']);
      await page.goto('settings/account');
      await expect(page.getByTestId('settings-account-email')).toHaveText('maya@cornell.edu');
      await expect(page.getByTestId('settings-delete-account')).toBeDisabled();
      await page.getByTestId('settings-delete-confirm').fill('DELETE');
      await expect(page.getByTestId('settings-delete-account')).toBeEnabled();
    });
  });
});
