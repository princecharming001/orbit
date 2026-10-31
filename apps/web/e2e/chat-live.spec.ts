import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { prep } from './helpers';

/**
 * The chat quality bench in the real UI (plan 28 §2b): the real model answers in the real thread, on the demo account,
 * and every reply is photographed at a laptop and a phone width and read for the rules the prompt states. Skipped
 * unless ORBIT_E2E_ANTHROPIC_KEY is set (the key is handed to the page once and never printed; see src/main.tsx).
 * CHAT_SHOTS_DIR receives the screenshots and a `live-<run>.json` of what each reply looked like. Never in CI.
 *
 *   ORBIT_E2E_ANTHROPIC_KEY=... CHAT_SHOTS_DIR=/tmp/chat-shots pnpm --filter @orbit/web exec playwright test chat-live
 */
const KEY = process.env.ORBIT_E2E_ANTHROPIC_KEY;
const SHOTS = process.env.CHAT_SHOTS_DIR;
const ONLY = process.env.LIVE_ONLY?.split(',').map((x) => x.trim());

/** What a user would type, with the id the scenario table (docs/qa/chat-scenarios.md) uses. */
const PROMPTS: { id: string; text: string; expectWeb?: boolean; noWeb?: boolean }[] = [
  { id: 'B16', text: 'who should I message today', noWeb: true },
  { id: 'B17', text: 'who went quiet', noWeb: true },
  { id: 'B18', text: 'who do I know at Stripe', noWeb: true },
  { id: 'B19', text: 'tell me about Lena Novak', noWeb: true },
  { id: 'B22', text: 'prep me for my next chat', noWeb: true },
  { id: 'C25', text: 'draft a thank-you to Lena', noWeb: true },
  { id: 'C27', text: 'ask Daniel to intro me to someone on his team', noWeb: true },
  { id: 'A1', text: 'when should I start reaching out to banks', noWeb: false },
  { id: 'A9', text: "someone hasn't replied in 2 weeks, what now", noWeb: true },
  { id: 'E41', text: 'did Stripe have layoffs recently', expectWeb: true },
  { id: 'E44', text: 'who do I know who works in climate', noWeb: true },
  {
    id: 'F47',
    text: 'find me people in my network who run a small business or ops and could use scheduling software',
    noWeb: true,
  },
  { id: 'F51', text: 'help', noWeb: true },
  { id: 'G54', text: 'research Lena for me', noWeb: true },
  { id: 'G57', text: 'what do you do with my emails', noWeb: true },
];

interface Look {
  id: string;
  text: string;
  words: number;
  workLog: string | null;
  cards: string[];
  webSearches: number;
  pills: number;
  dashOrExclaim: boolean;
  list: boolean;
  error: string | null;
  seconds: number;
  overflow: { laptop: number; phone: number };
}

async function loadDemo(page: Page) {
  await prep(page);
  await page.addInitScript((key) => {
    (window as unknown as { __ORBIT_ANTHROPIC_KEY__?: string }).__ORBIT_ANTHROPIC_KEY__ = key;
  }, KEY!);
  await page.goto('');
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
  // with a key saved the composer offers Smart and Quick, not Templates: the real model is on
  await expect(page.getByTestId('composer-mode')).not.toHaveText(/Templates/);
}

async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
}

/** Waits for the newest assistant turn to finish, then reads it the way a user would see it. */
async function readLast(page: Page, id: string, text: string, started: number): Promise<Look> {
  const turn = page.getByTestId('turn-assistant').last();
  await expect(turn).toHaveAttribute('data-status', /done|error|stopped/, { timeout: 180_000 });
  const look = await turn.evaluate((el) => {
    const q = (sel: string) => [...el.querySelectorAll(sel)];
    const prose = q('[data-testid="md"]')
      .map((n) => n.textContent ?? '')
      .join('\n');
    const cards = q('[data-testid^="result-"]').map((n) =>
      n.getAttribute('data-testid')!.replace('result-', ''),
    );
    return {
      prose,
      workLog: el.querySelector('[data-testid="work-log"]')?.textContent ?? null,
      cards,
      webSearches: q('[data-testid="web-search"]').length,
      pills: q('[data-testid="choice-pill"]').length,
      error: el.querySelector('[data-testid="turn-error"]')?.textContent ?? null,
    };
  });
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const laptop = await overflow();
  return {
    id,
    text,
    words: look.prose.split(/\s+/).filter(Boolean).length,
    workLog: look.workLog,
    cards: look.cards,
    webSearches: look.webSearches,
    pills: look.pills,
    dashOrExclaim: /[—–!]/.test(look.prose),
    list: /^\s*(#{1,6}\s|[-*•]\s|\d+\.\s)/m.test(look.prose),
    error: look.error,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    overflow: { laptop, phone: 0 },
  };
}

test.describe('chat quality bench: the real model in the real thread', () => {
  test.skip(!KEY, 'ORBIT_E2E_ANTHROPIC_KEY is not set');
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  const looks: Look[] = [];
  test.afterAll(() => {
    if (!SHOTS || !looks.length) return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/live-${Date.now()}.json`, JSON.stringify(looks, null, 2));
  });

  for (const p of PROMPTS.filter((x) => !ONLY || ONLY.includes(x.id))) {
    test(`${p.id}: ${p.text}`, async ({ page }) => {
      await loadDemo(page);
      const started = Date.now();
      await ask(page, p.text);
      const look = await readLast(page, p.id, p.text, started);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: `${SHOTS}/${p.id}-1280.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(300);
        look.overflow.phone = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        await page.screenshot({ path: `${SHOTS}/${p.id}-390.png`, fullPage: true });
      }
      looks.push(look);
      console.log(
        `[live ${p.id}] ${look.seconds}s, ${look.words} words, cards ${look.cards.join(',') || 'none'}, web ${look.webSearches}, work-log ${look.workLog ? 'yes' : 'no'}${look.error ? `, ERROR ${look.error}` : ''}`,
      );

      // the rules the prompt states, read off the screen
      expect(look.error, 'the turn errored').toBeNull();
      expect(look.dashOrExclaim, 'a dash or an exclamation mark').toBe(false);
      expect(look.list, 'a heading or a list in prose').toBe(false);
      expect(look.pills, 'more than three pills').toBeLessThanOrEqual(3);
      expect(look.overflow.laptop, 'horizontal overflow at 1280').toBeLessThanOrEqual(0);
      if (SHOTS) expect(look.overflow.phone, 'horizontal overflow at 390').toBeLessThanOrEqual(0);
      if (p.noWeb) expect(look.webSearches, 'searched the web for a question Orbit answers itself').toBe(0);
      if (p.expectWeb && process.env.SIM_STRICT)
        expect(look.webSearches, 'no web search for a current fact').toBeGreaterThan(0);
    });
  }
});
