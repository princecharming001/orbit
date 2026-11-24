import { expect, type Page, test } from '@playwright/test';
import { createFakeOrbitApi, type FakeOrbitApi, fakeDossier } from '../src/test/fakeOrbitApi';
import { prep, QUESTION_ADDRESSES, skipQuestions } from './helpers';

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
const P4 = '0b8f6a0e-1111-4c2e-8d1a-000000000004';
const P5 = '0b8f6a0e-1111-4c2e-8d1a-000000000005';

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
    // the written questions: what Maya is going for goes to the server and onto her recruiting goal
    await page
      .getByTestId('ob-q-aim')
      .fill('Product roles at climate startups, because I want my work to cut emissions.');
    await page.getByTestId('ob-q-success').fill('Three PM conversations by December.');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect
      .poll(() => api.state.profile.about)
      .toEqual({
        aim: 'Product roles at climate startups, because I want my work to cut emissions.',
        success: 'Three PM conversations by December.',
      });
    await expect
      .poll(() => api.state.goals.find((g) => g.kind === 'recruiting')?.successMetric)
      .toBe('Three PM conversations by December.');
    for (const step of QUESTION_ADDRESSES.slice(1)) {
      await expect(page.locator(`[data-testid="ob-q"][data-step="${step}"]`)).toBeVisible();
      await page.getByTestId('ob-q-skip').click();
    }
    // LinkedIn: the risk in one sentence before connecting live, and no export anywhere
    await expect(page.getByTestId('ob-linkedin-risk')).toContainText("LinkedIn's terms");
    await expect(page.getByTestId('ob-linkedin-live')).toBeVisible();
    await expect(page.getByTestId('ob-linkedin-upload')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/export/i);
    await expect.poll(() => api.state.goals.map((g) => g.kind).sort()).toEqual(['fundraising', 'recruiting']);
    await page.getByTestId('ob-skip').click();
    await page.getByTestId('ob-phone-skip').click();
    // no Rate step in setup: it is asked in a popup a couple of days later, once Orbit has read enough email
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
    await expect(page.getByTestId('home-status').filter({ hasText: /Gmail/ })).toHaveCount(0);
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

  test('Rate a few people is asked in a popup days after setup, and once only', async ({ page }) => {
    const api = await withFakeApi(page);
    seedNetwork(api);
    const at = '2026-10-05T12:00:00.000Z';
    const more = ['Ana Cole', 'Ben Ito', 'Cy Park'].map((name, i) => ({
      id: `0b8f6a0e-1111-4c2e-8d1a-00000000001${i}`,
      userId: api.state.user.id,
      displayName: name,
      currentTitle: 'Analyst',
      currentOrganizationRaw: 'Ramp',
      primaryEmail: `${name.split(' ')[0]!.toLowerCase()}@ramp.com`,
      emails: [`${name.split(' ')[0]!.toLowerCase()}@ramp.com`],
      sources: ['gmail'],
      tieScore: 30 - i,
      tieBand: 'light',
      lastInteractionAt: at,
      interactionCount: 4,
      createdAt: at,
      updatedAt: at,
    }));
    (api.state.pages[0]!.changes.people as unknown[]).push(...more);
    // setup finished three days before the tests' clock (Oct 6), past the two days the popup waits
    api.state.user.onboarding = { completed_at: '2026-10-03T12:00:00.000Z' };
    await page.addInitScript(() => {
      (window as unknown as { __ORBIT_RATE__: string }).__ORBIT_RATE__ = 'on';
    });
    await page.goto('');
    await page.getByTestId('landing-login').click();
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
    const prompt = page.getByTestId('rate-prompt');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt.getByTestId('ob-rate-person')).toHaveCount(6);
    await prompt.getByTestId('ob-rate-person').first().getByTestId('closeness-4').click();
    await expect.poll(() => api.state.labels.size).toBe(1);
    await page.getByTestId('rate-prompt-done').click();
    await expect(prompt).toHaveCount(0);
    // opened again: it is not asked twice
    await page.goto('');
    await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('rate-prompt')).toHaveCount(0);
  });

  test.describe('signed in', () => {
    async function signedIn(page: Page, more?: (api: FakeOrbitApi) => void): Promise<FakeOrbitApi> {
      const api = await withFakeApi(page);
      seedNetwork(api);
      more?.(api);
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
      await skipQuestions(page);
      await page.getByTestId('ob-skip').click();
      await page.getByTestId('ob-phone-skip').click();
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

    test("About: a role synced from the server shows its company, and LinkedIn's read never hangs", async ({
      page,
    }) => {
      await signedIn(page, (api) => {
        const changes = api.state.pages[0]!.changes as Record<string, Record<string, unknown>[]>;
        Object.assign(changes.people![0]!, {
          linkedinSlug: 'priya-shah',
          linkedinUrl: 'https://www.linkedin.com/in/priya-shah',
        });
        // the server's own names (orgRaw, orgId), as /sync/pull sent them before it renamed them
        changes.affiliations = [
          {
            id: '0b8f6a0e-2222-4c2e-8d1a-000000000001',
            userId: api.state.user.id,
            personId: P1,
            kind: 'employment',
            title: 'Product Lead',
            orgRaw: 'Stripe',
            isCurrent: true,
            source: 'linkedin',
          },
        ];
      });
      await page.goto(`people/${P1}`);
      await page.getByRole('tab', { name: /^about/i }).click();
      const history = page.getByTestId('linkedin-history');
      await expect(history.getByTestId('linkedin-role').first()).toContainText('Stripe');
      // no LinkedIn to read from in this build: it says so, instead of "Reading…" for ever
      await expect(history.getByTestId('linkedin-history-why')).toBeVisible({ timeout: 15_000 });
      await expect(history.getByTestId('linkedin-history-status')).not.toContainText('Reading');
    });

    test("a person's page loads the whole story: old recruiting mail, LinkedIn and a meeting, in Messages and the timeline", async ({
      page,
    }) => {
      const api = await signedIn(page);
      const u = api.state.user.id;
      const T1 = '0b8f6a0e-3333-4c2e-8d1a-000000000001';
      const T2 = '0b8f6a0e-3333-4c2e-8d1a-000000000002';
      // what /people/history answers for Priya: a recruiting thread from last year the pull never sends (not
      // networking, older than 180 days), a LinkedIn chat, and a coffee they had
      api.state.history.set(P1, {
        threads: [
          {
            id: T1,
            userId: u,
            provider: 'gmail',
            externalThreadId: 'g-1',
            subject: 'Product role at Stripe',
            participantPersonIds: [P1],
            participantEmails: [],
            firstMessageAt: '2025-03-01T15:00:00.000Z',
            lastMessageAt: '2025-03-01T15:00:00.000Z',
            messageCount: 1,
            isNetworking: false,
            category: 'recruiting_process',
          },
          {
            id: T2,
            userId: u,
            provider: 'linkedin',
            channel: 'linkedin',
            externalThreadId: 'li-1',
            participantPersonIds: [P1],
            participantEmails: [],
            firstMessageAt: '2026-10-01T15:00:00.000Z',
            lastMessageAt: '2026-10-01T15:00:00.000Z',
            messageCount: 1,
            isNetworking: true,
          },
        ],
        messages: [
          {
            id: '0b8f6a0e-4444-4c2e-8d1a-000000000001',
            userId: u,
            threadId: T1,
            direction: 'inbound',
            fromPersonId: P1,
            fromEmail: 'priya@stripe.com',
            toEmails: ['me@example.com'],
            ccEmails: [],
            sentAt: '2025-03-01T15:00:00.000Z',
            subject: 'Product role at Stripe',
            bodyText: 'Happy to tell you about the PM role whenever suits.',
            isAutomated: false,
          },
          {
            id: '0b8f6a0e-4444-4c2e-8d1a-000000000002',
            userId: u,
            threadId: T2,
            channel: 'linkedin',
            direction: 'outbound',
            fromEmail: '',
            toEmails: [],
            ccEmails: [],
            sentAt: '2026-10-01T15:00:00.000Z',
            bodyText: 'Thanks for the chat, Priya.',
            isAutomated: false,
          },
        ],
        events: [
          {
            id: '0b8f6a0e-5555-4c2e-8d1a-000000000001',
            userId: u,
            externalEventId: 'ev-1',
            title: 'Coffee with Priya',
            startAt: '2026-09-15T16:00:00.000Z',
            endAt: '2026-09-15T16:30:00.000Z',
            status: 'confirmed',
            attendees: [],
            attendeePersonIds: [P1],
          },
        ],
      });
      await page.goto(`people/${P1}`);
      const items = page.getByTestId('timeline-item');
      await expect(items.filter({ hasText: 'Email from Priya: Product role at Stripe' })).toHaveCount(1, {
        timeout: 15_000,
      });
      await expect(items.filter({ hasText: 'Meeting: Coffee with Priya' })).toHaveCount(1);
      await expect(items.filter({ hasText: 'LinkedIn message to Priya' })).toHaveCount(1);
      await expect(page.getByTestId('person-header')).not.toContainText('Not in touch yet');
      await page.getByRole('tab', { name: /^messages/i }).click();
      const said = page.getByTestId('conversation-message');
      await expect(said.filter({ hasText: 'Happy to tell you about the PM role' })).toHaveCount(1);
      await expect(said.filter({ hasText: 'Thanks for the chat, Priya.' })).toHaveCount(1);
      expect(api.routes()).toContain('/people/history');
    });

    test('Discover, Find people: one table of who fits, with the path, the match and Save', async ({
      page,
    }) => {
      const api = await signedIn(page);
      const u = api.state.user.id;
      const at = '2026-10-05T12:00:00.000Z';
      // two investors the student already has, beside the three from the seeded network
      api.state.pages.push({
        changes: {
          people: [
            {
              id: P4,
              userId: u,
              displayName: 'Nadia Okoro',
              currentTitle: 'Partner',
              currentOrganizationRaw: 'Gradient Ventures',
              headline: 'Partner at Gradient Ventures, a seed fund',
              linkedinUrl: 'https://www.linkedin.com/in/nadia-okoro',
              sources: ['linkedin'],
              tieScore: 62,
              tieBand: 'strong',
              createdAt: at,
              updatedAt: at,
            },
            {
              id: P5,
              userId: u,
              displayName: 'Theo Marsh',
              currentTitle: 'Investor',
              currentOrganizationRaw: 'Cove Fund',
              headline: 'Investor at Cove Fund',
              sources: ['linkedin'],
              tieScore: 18,
              tieBand: 'light',
              createdAt: at,
              updatedAt: at,
            },
          ],
        },
      });
      api.state.sourced = [
        {
          id: 'rec_a',
          name: 'Rhea Kapoor',
          title: 'Partner',
          org: 'Seedling Fund',
          headline: 'Seed investor in climate software',
          email: 'rhea@seedling.fund',
          url: 'https://seedling.fund/team',
          linkedinUrl: 'https://www.linkedin.com/in/rhea-kapoor',
          evidence: ['Works on seed rounds in climate software'],
          source: 'web',
          rank: 0.8,
          fit: 0.9,
          reach: 0.4,
          responsiveness: 0.5,
          reasons: ['Leads seed rounds in climate software'],
          bridge: { personId: P1, name: 'Priya Shah' },
          tier: 2,
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
          tier: 1,
        },
        {
          id: 'rec_c',
          name: 'Jonas Weber',
          title: 'Principal',
          org: 'Cherry Ventures',
          source: 'unipile',
          rank: 0.5,
          fit: 0.7,
          reach: 0.05,
          responsiveness: 0.5,
          reasons: ['Seed investor'],
          degree: 2,
          emailStatus: 'not looked up',
        },
      ];
      await page.goto('discover?tab=find');
      // one box and Search: no row of purposes to pick from
      await expect(page.locator('[data-testid^="find-purpose-"]')).toHaveCount(0);
      await page.getByTestId('find-query').fill('investors');
      await page.getByTestId('find-search').click();
      const rows = page.getByTestId('find-result');
      await expect(rows).toHaveCount(5);
      await expect(page.getByTestId('find-count')).toHaveText('5 matches');
      await expect(page.getByTestId('find-split')).toHaveText('2 you already know, 3 new.');
      // the header is the reference's: who, profile, path, title, company, match
      await expect(page.locator('[data-testid="find-results"] thead th')).toHaveText([
        'Name',
        'Profiles',
        'Paths',
        'Title',
        'Company',
        'Match',
        'Connect or save',
      ]);
      // the student's own investors: a link to their page, the strength of the tie, no button
      const nadia = rows.filter({ hasText: 'Nadia Okoro' });
      await expect(nadia).toHaveAttribute('data-own', 'true');
      await expect(nadia.getByTestId('find-name')).toHaveAttribute('href', new RegExp(`people/${P4}$`));
      await expect(nadia.getByTestId('result-path')).toHaveAttribute('data-kind', 'direct');
      await expect(nadia.getByTestId('result-path-bars')).toHaveAttribute('data-level', '3');
      await expect(nadia.getByTestId('find-add')).toHaveCount(0);
      await expect(nadia).toContainText('Gradient Ventures');
      await expect(nadia.getByTestId('find-linkedin')).toHaveAttribute(
        'href',
        'https://www.linkedin.com/in/nadia-okoro',
      );
      // someone new with a way in: through the person the student is warm with
      const rhea = rows.filter({ hasText: 'Rhea Kapoor' });
      await expect(rhea.getByTestId('result-path')).toHaveAttribute('data-kind', 'intro');
      await expect(rhea.getByTestId('result-path')).toContainText('Priya Shah');
      await expect(rhea.getByTestId('find-email')).toHaveAttribute('href', 'mailto:rhea@seedling.fund');
      await expect(rhea.getByTestId('find-match')).toHaveText('90%');
      // a second-degree stranger, and someone found outside whom the student already has
      await expect(rows.filter({ hasText: 'Jonas Weber' }).getByTestId('result-path')).toContainText(
        '2nd degree',
      );
      const sam = rows.filter({ hasText: 'Sam Lee' });
      await expect(sam.getByTestId('find-name')).toHaveAttribute('href', new RegExp(`people/${P2}$`));
      await expect(sam.getByTestId('find-add')).toHaveCount(0);
      // best match first, in steps of ten (within a step the warmer way in leads): no row is a step above the one
      // before it
      const steps = (await page.getByTestId('find-match').allTextContents()).map((t) =>
        Math.min(9, Math.floor(Number.parseInt(t, 10) / 10)),
      );
      expect(steps).toEqual([...steps].sort((a, b) => b - a));
      // who they say they are, under their name
      await expect(rhea.getByTestId('find-headline')).toHaveText('Seed investor in climate software');
      if (process.env.FIND_SHOT) {
        await page.addStyleTag({
          content: '[data-testid="toasts"],[data-testid="linkedin-progress"]{display:none!important}',
        });
        await page.screenshot({ path: process.env.FIND_SHOT });
      }
      await expect(page.getByTestId('find-quiet')).toContainText('Not searched yet: Apollo');
      // what the server was asked: people only, the investing titles, for fundraising
      const asked = api.state.sourceSearches.at(-1)!;
      expect(asked).toMatchObject({ purpose: 'fundraising', query: 'investors', peopleOnly: true });
      expect((asked.filters as { titles: string[] }).titles).toContain('investor');
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/find-table.png` });
      // nobody starts picked, whoever they are; Shift-click picks the rows in between
      const picks = page.getByTestId('find-pick');
      await expect(picks).toHaveCount(5);
      for (const box of await picks.all()) await expect(box).not.toBeChecked();
      await picks.nth(1).click();
      await picks.nth(3).click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('find-picked')).toContainText('3 picked');
      // a company opens its page in Orbit, or who the student knows there
      await expect(rhea.getByTestId('find-company')).toHaveAttribute(
        'href',
        /(companies\/|map\?reach=1&company=)/,
      );
      // open someone and come back: the search, its rows and the picks are as they were, and nothing ran again
      const searches = api.state.sourceSearches.length;
      await nadia.getByTestId('find-name').click();
      await expect(page).toHaveURL(new RegExp(`people/${P4}$`));
      await page.goBack();
      await expect(page.getByTestId('find-query')).toHaveValue('investors');
      await expect(rows).toHaveCount(5);
      await expect(page.getByTestId('find-picked')).toContainText('3 picked');
      // to Your network and back to Find people: still there
      await page
        .getByRole('tab', { name: 'Your network' })
        .or(page.getByRole('button', { name: 'Your network' }))
        .first()
        .click();
      await expect(rows).toHaveCount(0);
      await page
        .getByRole('tab', { name: 'Find people' })
        .or(page.getByRole('button', { name: 'Find people' }))
        .first()
        .click();
      await expect(rows).toHaveCount(5);
      await expect(page.getByTestId('find-count')).toHaveText('5 matches');
      expect(api.state.sourceSearches.length).toBe(searches);
      await page.getByTestId('find-pick-clear').click();
      // LinkedIn is not connected on this account, so the button says Save and saving is all it does: the row then
      // opens their page, and nothing says "added" or "to contact"
      await expect(rhea.getByTestId('find-add')).toHaveText('Save');
      await rhea.getByTestId('find-add').click();
      await expect(rhea.getByRole('link', { name: 'Saved, open' })).toBeVisible();
      await expect(page.getByTestId('toasts')).toContainText('Saved Rhea Kapoor to People.');
      expect(api.calls.find((c) => c.route === '/source/add')?.body).toEqual({
        recommendationIds: ['rec_a'],
      });
      expect(api.calls.some((c) => c.route === '/source/connect')).toBe(false);
      // an address is looked up only when asked
      await rows.filter({ hasText: 'Jonas Weber' }).getByTestId('find-email-lookup').click();
      await expect(rows.filter({ hasText: 'Jonas Weber' }).getByTestId('find-email-none')).toBeVisible();
    });

    test('Discover, Find people: Connect sends one LinkedIn request and the row says so; Save only saves', async ({
      page,
    }) => {
      const api = await signedIn(page);
      // the student's own LinkedIn is connected and active on their Orbit account
      api.state.linkedin.status = 'active';
      const base = {
        rank: 0.8,
        fit: 0.9,
        reach: 0.4,
        responsiveness: 0.5,
        reasons: [],
        source: 'unipile' as const,
      };
      api.state.sourced = [
        {
          ...base,
          id: 'rec_a',
          name: 'Rhea Kapoor',
          title: 'Partner',
          org: 'Seedling Fund',
          linkedinUrl: 'https://www.linkedin.com/in/rhea-kapoor',
          degree: 2,
        },
        {
          ...base,
          id: 'rec_b',
          name: 'Lena Fischer',
          title: 'Principal',
          org: 'Cherry Ventures',
          linkedinUrl: 'https://www.linkedin.com/in/lena-fischer',
          degree: 3,
        },
        // found on a web page: no LinkedIn profile, so there is nothing to send a request to
        {
          ...base,
          id: 'rec_c',
          name: 'Jonas Weber',
          title: 'Investor',
          org: 'Point Nine',
          source: 'web' as const,
        },
        // already a 1st-degree connection on LinkedIn: nothing to request
        {
          ...base,
          id: 'rec_d',
          name: 'Cy Near',
          title: 'Investor',
          org: 'Atomico',
          linkedinUrl: 'https://www.linkedin.com/in/cy-near',
          degree: 1,
        },
      ];
      await page.goto('discover?tab=find');
      await page.getByTestId('find-query').fill('investors');
      await page.getByTestId('find-search').click();
      const rows = page.getByTestId('find-result');
      const rhea = rows.filter({ hasText: 'Rhea Kapoor' });
      const lena = rows.filter({ hasText: 'Lena Fischer' });
      const jonas = rows.filter({ hasText: 'Jonas Weber' });
      const cy = rows.filter({ hasText: 'Cy Near' });
      // the button says what it does
      await expect(rhea.getByTestId('find-add')).toHaveText('Connect');
      await expect(lena.getByTestId('find-add')).toHaveText('Connect');
      await expect(jonas.getByTestId('find-add')).toHaveText('Save');
      await expect(cy.getByTestId('find-add')).toHaveText('Save');
      // one click (even a double one) sends one request, saves them, and the row says so
      await rhea.getByTestId('find-add').dblclick();
      await expect(rhea.getByRole('link', { name: 'Request sent, open' })).toBeVisible();
      await expect(page.getByTestId('toasts')).toContainText(
        'Connection request sent to Rhea Kapoor. Saved to People.',
      );
      expect(api.calls.filter((c) => c.route === '/source/connect').map((c) => c.body)).toEqual([
        { recommendationId: 'rec_a' },
      ]);
      expect(api.state.linkedin.connects).toEqual(['rec_a']);
      // nothing else went: no draft was written or sent
      expect(api.calls.some((c) => c.route.startsWith('/drafts/'))).toBe(false);
      // LinkedIn refuses the next one: said in its own words, and they are saved instead
      api.state.linkedin.connectError = 'weekly_limit';
      await lena.getByTestId('find-add').click();
      const refusal = "LinkedIn's weekly limit on connection requests is reached. Saved to People instead.";
      await expect(page.getByTestId('toasts')).toContainText(refusal);
      await expect(lena.getByRole('link', { name: 'Saved, open' })).toBeVisible();
      await expect(lena.getByTestId('find-open')).toHaveAttribute('title', refusal);
      expect(api.state.linkedin.connects).toEqual(['rec_a']);
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/find-connect.png` });
      // Save sends nothing
      api.state.linkedin.connectError = undefined;
      await jonas.getByTestId('find-add').click();
      await expect(jonas.getByRole('link', { name: 'Saved, open' })).toBeVisible();
      await expect(page.getByTestId('toasts')).toContainText('Saved Jonas Weber to People.');
      expect(api.calls.filter((c) => c.route === '/source/connect')).toHaveLength(2);
      expect(api.calls.find((c) => c.route === '/source/add')?.body).toEqual({
        recommendationIds: ['rec_c'],
      });
      // the row opens their page, and the pipeline has the request under a sent first step, never "To contact"
      await rhea.getByRole('link', { name: 'Request sent, open' }).click();
      await expect(page).toHaveURL(/people\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('person-header')).toContainText('Rhea Kapoor');
    });

    test('Discover, Find people: criteria and filters are read, shown, changed, and the search runs again', async ({
      page,
    }) => {
      const api = await signedIn(page);
      api.state.sourced = [
        {
          id: 'rec_a',
          name: 'Rhea Kapoor',
          title: 'Partner',
          org: 'Seedling Fund',
          source: 'web',
          rank: 0.8,
          fit: 0.9,
          reach: 0.4,
          responsiveness: 0.5,
          reasons: [],
          checks: [{ text: '', need: 'must', answer: 'yes' }],
        },
        {
          id: 'rec_b',
          name: 'Omar Haddad',
          title: 'Scout',
          org: 'Seedcamp',
          source: 'unipile',
          rank: 0.5,
          fit: 0.8,
          reach: 0,
          responsiveness: 0.5,
          reasons: [],
          checks: [{ text: '', need: 'must', answer: 'no' }],
        },
        {
          id: 'rec_c',
          name: 'Lena Fox',
          title: 'Associate',
          org: 'Atomico',
          source: 'unipile',
          rank: 0.5,
          fit: 0.5,
          reach: 0,
          responsiveness: 0.5,
          reasons: [],
        },
      ];
      await page.goto('discover?tab=find');
      await page.getByTestId('find-query').fill('investors in London');
      await page.getByTestId('find-search').click();
      await expect(page.getByTestId('find-result')).toHaveCount(3);
      // the sentence was read into filters: the kind of work and the place
      await expect(page.getByTestId('find-filters')).toHaveText('2');
      await expect(page.getByTestId('find-criteria')).toHaveText('0');
      expect(api.state.sourceSearches.at(-1)).toMatchObject({ filters: { locations: ['London'] } });

      // Criteria: write one as a must-have and Update
      await page.getByTestId('find-criteria').click();
      const criteria = page.getByTestId('criteria-dialog');
      await expect(criteria).toContainText('Must haves decide who fits; nice to haves rank people higher.');
      await criteria.getByTestId('criterion-text').fill('Works at a venture capital firm');
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/find-criteria.png` });
      await criteria.getByTestId('criteria-save').click();
      await expect(criteria).toHaveCount(0);
      // the must-have "no" is gone, the yes leads, and the criterion is a column with an answer on every row
      await expect(page.getByTestId('find-criteria')).toHaveText('1');
      await expect(page.getByTestId('find-criterion-head')).toHaveText('Works at a venture capital firm');
      await expect(page.getByTestId('find-name')).toHaveText(['Rhea Kapoor', 'Lena Fox']);
      await expect(page.getByTestId('find-thumb').first()).toHaveAttribute('data-answer', 'yes');
      await expect(page.getByTestId('find-thumb').nth(1)).toHaveAttribute('data-answer', 'unknown');
      expect(api.state.sourceSearches.at(-1)).toMatchObject({
        criteria: [{ text: 'Works at a venture capital firm', need: 'must' }],
      });
      if (process.env.SHOT_DIR)
        await page.screenshot({ path: `${process.env.SHOT_DIR}/find-criterion-column.png` });

      // nice to have: nobody is left out for it
      await page.getByTestId('find-criteria').click();
      await page.getByTestId('criterion-need-nice').click();
      await page.getByTestId('criteria-save').click();
      await expect(page.getByTestId('find-result')).toHaveCount(3);
      await expect(page.getByTestId('find-criterion-head')).toContainText('Nice to have');

      // Filters: the place is there as read; add a title, a seniority and a company, change the place, save
      await page.getByTestId('find-filters').click();
      const filters = page.getByTestId('filters-dialog');
      await expect(filters.getByTestId('filter-places-box-chip')).toHaveText(['London']);
      await filters.getByTestId('filters-role-tab-groups').click();
      await expect(filters.getByTestId('filter-families-investing')).toHaveAttribute('aria-pressed', 'true');
      await filters.getByTestId('filters-role-tab-titles').click();
      await filters.getByTestId('filter-titles-box-input').fill('partner, principal');
      await filters.getByTestId('filter-titles-box-input').press('Enter');
      await expect(filters.getByTestId('filter-titles-box-chip')).toHaveText(['partner', 'principal']);
      await filters.getByTestId('filter-seniority-options-director_head').click();
      await filters.getByTestId('filter-places-box-input').fill('Berlin');
      await filters.getByTestId('filter-places-box-input').press('Enter');
      await filters.getByTestId('filter-places-need-nice').click();
      await expect(filters.getByTestId('filter-places-need-nice')).toHaveAttribute('aria-pressed', 'true');
      if (process.env.SHOT_DIR)
        await page.screenshot({ path: `${process.env.SHOT_DIR}/find-filters-role.png` });
      await filters.getByTestId('filters-section-companies').click();
      await filters.getByTestId('filter-companies-box-input').fill('Google');
      await filters.getByTestId('filter-companies-box-input').press('Enter');
      if (process.env.SHOT_DIR)
        await page.screenshot({ path: `${process.env.SHOT_DIR}/find-filters-companies.png` });
      await filters.getByTestId('filters-section-advanced').click();
      await filters.getByTestId('filter-keywords-box-input').fill('seed');
      await filters.getByTestId('filter-keywords-box-input').press('Enter');
      if (process.env.SHOT_DIR)
        await page.screenshot({ path: `${process.env.SHOT_DIR}/find-filters-advanced.png` });
      const before = api.state.sourceSearches.length;
      await filters.getByTestId('filters-save').click();
      await expect(filters).toHaveCount(0);
      await expect.poll(() => api.state.sourceSearches.length).toBe(before + 1);
      // role (titles and group), seniority, place, companies, keywords
      await expect(page.getByTestId('find-filters')).toHaveText('5');
      expect(api.state.sourceSearches.at(-1)).toMatchObject({
        filters: {
          // the titles the search names go as they are: the group's other titles are not added to them
          titles: ['partner', 'principal'],
          locations: ['London', 'Berlin'],
          organizations: ['Google'],
          keywords: ['seed'],
          seniority: ['director'],
        },
      });

      // Only people I know: the server is not asked at all
      await page.getByTestId('find-filters').click();
      await page.getByTestId('filters-section-advanced').click();
      await page.getByTestId('filter-reach-mine').click();
      const asked = api.state.sourceSearches.length;
      await page.getByTestId('filters-save').click();
      await expect(page.getByTestId('find-busy')).toHaveCount(0);
      await expect(page.getByTestId('find-filters')).toHaveText('6');
      expect(api.state.sourceSearches.length).toBe(asked);
      // closing without saving changes nothing
      await page.getByTestId('find-filters').click();
      await page.getByTestId('filters-section-advanced').click();
      await page.getByTestId('filter-reach-everyone').click();
      await page.getByTestId('filters-close').click();
      await expect(page.getByTestId('find-filters')).toHaveText('6');
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
