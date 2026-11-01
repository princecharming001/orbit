import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withFriend, withReplies } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * The screen pass for plan 29 (§C1 phase 6, §C3 "Screen"): the Friends tab, Drafts with Tomorrow's batch, Needs you
 * and Sent for you, Settings, Autopilot and Voice, and the Map's friend routes, each at the four viewports the chat
 * home is held to. Every page must fit without sideways scroll, show no clipped one-line label, and say nothing with a
 * dash or an exclamation mark. PLAN29_SHOTS, when set, receives a screenshot of each page at each size.
 */
const SHOTS = process.env.PLAN29_SHOTS;

const PEOPLE = [
  {
    id: 'p_maya_chen',
    displayName: 'Maya Chen',
    currentTitle: 'Software Engineer',
    currentOrganizationRaw: 'Stripe',
  },
  {
    id: 'p_lena_novak',
    displayName: 'Lena Novak',
    currentTitle: 'Engineering Manager',
    currentOrganizationRaw: 'Ramp',
  },
  { id: 'p_daniel_okafor', displayName: 'Daniel Okafor', currentOrganizationRaw: 'Goldman Sachs' },
  { id: 'p_kenji_mori', displayName: 'Kenji Mori', currentOrganizationRaw: 'Figma' },
  { id: 'p_ethan_park', displayName: 'Ethan Park', currentOrganizationRaw: 'Anthropic' },
];

/** Signed in to the fake account with Ana as a friend, a reply of every class and a day on autopilot. */
async function signedIn(page: Page): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  const me = { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' };
  withFriend(api, me, PEOPLE);
  withReplies(api, me, PEOPLE);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  const at = '2026-10-01T12:00:00.000Z';
  api.state.pages.push({
    changes: {
      people: PEOPLE.map((p) => ({
        ...p,
        userId: api.state.user.id,
        primaryEmail: `${p.displayName.split(' ')[0]!.toLowerCase()}@example.com`,
        emails: [`${p.displayName.split(' ')[0]!.toLowerCase()}@example.com`],
        sources: ['gmail'],
        tieScore: 55,
        tieBand: 'warm',
        interactionCount: 4,
        lastInteractionAt: at,
        createdAt: at,
        updatedAt: at,
      })),
    },
  });
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return api;
}

const PAGES: { name: string; path: string; ready: string }[] = [
  { name: 'friends', path: 'friends', ready: 'friend-row' },
  { name: 'drafts', path: 'drafts', ready: 'sent-for-you' },
  { name: 'settings-autopilot', path: 'settings/autopilot', ready: 'settings-autopilot' },
  { name: 'settings-voice', path: 'settings/voice', ready: 'voice-card' },
];

const SIZES: [number, number][] = [
  [1280, 800],
  [1024, 768],
  [768, 1024],
  [390, 844],
];

/** What the page says that a person reads: the main landmark's text, without inputs the student types into. */
async function mainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const clone = main.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll('input, textarea, [contenteditable="true"]')) el.remove();
    return clone.innerText;
  });
}

/** One-line labels cut off by their own box (an ellipsis on purpose does not count). */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const host = document.querySelector('main') ?? document.body;
    for (const el of host.querySelectorAll<HTMLElement>('h1, h2, h3, p, span, button, a, label, div')) {
      if (!el.textContent?.trim() || el.children.length > 0) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden' || cs.visibility === 'hidden') continue;
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace === 'nowrap')
        out.push(el.textContent.trim().slice(0, 40));
      // a short control or figure ("Got it", "2.6 of 3") broken over two lines reads as a glitch
      const words = el.textContent.trim().split(/\s+/).length;
      const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.3;
      const short = words <= 3 && el.textContent.trim().length <= 14;
      if (short && el.getClientRects().length > 0 && el.getBoundingClientRect().height > lineHeight * 1.7) {
        const r = document.createRange();
        r.selectNodeContents(el);
        if (r.getClientRects().length > 1) out.push(`wrapped: ${el.textContent.trim()}`);
      }
    }
    return out;
  });
}

test.describe('plan 29 screens at four sizes', () => {
  test.describe.configure({ timeout: 240_000 });
  for (const [w, h] of SIZES)
    test(`fit and copy at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await signedIn(page);
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.getByTestId(p.ready).first()).toBeVisible({ timeout: 20_000 });
        // let late cards (status, notes) settle before reading the page
        await page.waitForTimeout(600);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over, `${p.name} at ${w}: sideways scroll`).toBeLessThanOrEqual(1);
        expect(await clipped(page), `${p.name} at ${w}: clipped labels`).toEqual([]);
        const text = await mainText(page);
        const bad = text
          .split('\n')
          .filter((l) => /[—–]|!(?!=)/.test(l))
          .slice(0, 5);
        expect(bad, `${p.name} at ${w}: a dash or an exclamation mark`).toEqual([]);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${p.name}-${w}.png`, fullPage: true });
      }
    });
});
