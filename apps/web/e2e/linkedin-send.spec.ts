import { expect, type Page, test } from '@playwright/test';
import type { FakeOrbitApi } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * "Always send in app". A student signed in to an Orbit account, with LinkedIn linked, writes a message to a LinkedIn
 * connection on that person's page and presses Send: Orbit sends it itself, on that tap, and LinkedIn is never opened.
 * When LinkedIn is not connected, the page says so with a link to Settings, Integrations, and pasting it into LinkedIn
 * is the other way the student can pick, never something Send does on its own.
 */

const KELLY = '5c2a9e74-3b1f-4d86-a0c7-91e4f2b6d835';
const TEXT = 'hey kelly, hope things are good.';

async function signedInWithKelly(page: Page, linkedin: 'active' | 'not_connected'): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  await watchOpens(page);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  api.state.linkedin.status = linkedin;
  const at = '2026-10-01T12:00:00.000Z';
  api.state.pages.push({
    changes: {
      people: [
        {
          id: KELLY,
          displayName: 'Kelly Gieryn',
          currentOrganizationRaw: 'Figma',
          currentTitle: 'Product Designer',
          userId: api.state.user.id,
          linkedinUrl: 'https://www.linkedin.com/in/kellygieryn',
          linkedinSlug: 'kellygieryn',
          linkedinConnectedOn: '2025-03-02',
          emails: [],
          sources: ['linkedin'],
          tieScore: 30,
          tieBand: 'light',
          interactionCount: 0,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
  });
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return api;
}

/**
 * Every address the app asks the browser to open in a new tab (LinkedIn would be one). The app opens tabs only with
 * `window.open`, which the tests replace so nothing real is opened: here each call is kept, for the page it was made on.
 */
async function watchOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (url?: string | URL) => {
      w.__opened.push(String(url));
      return null;
    };
  });
}
const opens = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

async function openMessages(page: Page) {
  await page.goto(`people/${KELLY}?tab=conversation`);
  await expect(page.getByRole('heading', { name: 'Kelly Gieryn', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  const conv = page.getByTestId('conversation');
  await expect(conv.getByTestId('conversation-input')).toBeVisible({ timeout: 30_000 });
  return conv;
}

test.describe('LinkedIn messages on an Orbit account are sent in the app', () => {
  test('LinkedIn linked: Send sends the message the student wrote, on that tap, and LinkedIn never opens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const api = await signedInWithKelly(page, 'active');
    const conv = await openMessages(page);
    await conv.getByTestId('conversation-input').fill(TEXT);
    await conv.getByTestId('conversation-send').click();
    await expect(conv.getByTestId('conversation-input')).toHaveValue('', { timeout: 20_000 });
    await expect(conv.getByTestId('conversation-error')).toHaveCount(0);
    // one approval: the tap, the words, and who they are for (the draft was made in this browser)
    const approved = api.calls.filter((c) => c.route === '/drafts/approve');
    expect(approved).toHaveLength(1);
    expect(approved[0]!.body).toMatchObject({
      body: TEXT,
      confirm: true,
      write: { personId: KELLY, kind: 'reply', channel: 'linkedin' },
    });
    expect([...api.state.drafts.values()].map((d) => d.status)).toEqual(['sent']);
    await expect(page.getByText('Sent to Kelly on LinkedIn.')).toBeVisible();
    // nothing to paste anywhere, no "I sent it" to press, and no LinkedIn tab
    await expect(page.getByText(/Paste it into LinkedIn/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /I sent it/ })).toHaveCount(0);
    expect(await opens(page)).toEqual([]);
  });

  test('LinkedIn not connected: the page says why with a link to reconnect, and pasting is the second choice', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const api = await signedInWithKelly(page, 'not_connected');
    const conv = await openMessages(page);
    await conv.getByTestId('conversation-input').fill(TEXT);
    await conv.getByTestId('conversation-send').click();
    await expect(conv.getByTestId('conversation-error')).toHaveText(
      'LinkedIn is not connected. Reconnect it to send from Orbit.',
      { timeout: 20_000 },
    );
    const fix = conv.getByTestId('conversation-linkedin-fix');
    await expect(fix).toHaveText('Reconnect LinkedIn');
    await expect(fix).toHaveAttribute('href', /\/settings\/integrations$/);
    // the words are still in the box, nothing was sent, and LinkedIn was not opened behind the student's back
    await expect(conv.getByTestId('conversation-input')).toHaveValue(TEXT);
    expect(api.calls.filter((c) => c.route === '/drafts/approve')).toHaveLength(0);
    expect(await opens(page)).toEqual([]);
    // pressing Send again does not pile up copies of the draft
    await conv.getByTestId('conversation-send').click();
    await expect(conv.getByTestId('conversation-error')).toBeVisible();
    // the other way, when the student picks it: LinkedIn is opened on their chat, and the message waits for "I sent it"
    await conv.getByTestId('conversation-linkedin-paste').click();
    await expect(conv.getByTestId('conversation-input')).toHaveValue('', { timeout: 20_000 });
    const opened = await opens(page);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/www\.linkedin\.com\//);
    await expect(page.getByRole('button', { name: 'I sent it to Kelly' })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByText('Paste it into LinkedIn and send it, then press I sent it.')).toBeVisible();
    expect(api.calls.filter((c) => c.route === '/drafts/approve')).toHaveLength(0);
  });
});
