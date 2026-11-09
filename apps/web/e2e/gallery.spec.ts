import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { prep } from './helpers';

/**
 * A photo gallery of real chat answers for review: the real model answers in the real thread on the demo account, one
 * case at a time, and each exchange (the student's message and Orbit's reply) is photographed. The model is reached
 * through the local shim on the developer's own Claude login (scripts/claude-cli-shim.mjs on GALLERY_SHIM), never a
 * key: the page gets a placeholder key and every api.anthropic.com request is answered by the shim. Never in CI.
 *
 *   GALLERY_SHIM=http://localhost:8787 GALLERY_DIR=/tmp/gallery pnpm --filter @orbit/web exec playwright test gallery
 */
const SHIM = process.env.GALLERY_SHIM;
const DIR = process.env.GALLERY_DIR ?? '/tmp/orbit-gallery';
const ONLY = process.env.GALLERY_ONLY?.split(',').map((x) => x.trim());

interface Case {
  id: string;
  group: string;
  turns: string[];
}

const CASES: Case[] = [
  { id: 'n01', group: 'Your network', turns: ['who should I message today'] },
  { id: 'n02', group: 'Your network', turns: ['who went quiet'] },
  { id: 'n03', group: 'Your network', turns: ['who do I know at Stripe'] },
  { id: 'n04', group: 'Your network', turns: ['tell me about Lena Novak'] },
  { id: 'n05', group: 'Your network', turns: ['who are the strongest people in my network'] },
  { id: 'n06', group: 'Your network', turns: ['who do I know who works in climate'] },
  { id: 'n07', group: 'Your network', turns: ['when is my next chat'] },
  { id: 'n08', group: 'Your network', turns: ['how am I doing this cycle'] },
  { id: 'm01', group: 'Routes', turns: ['find me a route to someone at Bain'] },
  { id: 's01', group: 'Sourcing', turns: ['find me 10 seed investors in climate software'] },
  { id: 's02', group: 'Sourcing', turns: ['source professors for biomed research at Berkeley'] },
  { id: 's03', group: 'Sourcing', turns: ["find product managers at Figma I don't know yet"] },
  { id: 'd01', group: 'Drafting', turns: ['draft a thank-you to Lena'] },
  { id: 'd02', group: 'Drafting', turns: ['ask Daniel to intro me to someone on his team'] },
  {
    id: 'd03',
    group: 'Drafting',
    turns: ['who do I know at Ramp', 'draft a message to each of them', 'make the first one shorter'],
  },
  { id: 'd04', group: 'Drafting', turns: ["bump everyone who hasn't replied"] },
  {
    id: 'd05',
    group: 'Drafting',
    turns: ['write a first message to Lena', 'make it less formal and mention my hackathon win', 'send it'],
  },
  { id: 'd06', group: 'Drafting', turns: ['reply to Lena with some times that work for me'] },
  { id: 'p01', group: 'Prep and advice', turns: ['prep me for my next chat'] },
  { id: 'p02', group: 'Prep and advice', turns: ["they haven't replied in 2 weeks, what now"] },
  { id: 'p03', group: 'Prep and advice', turns: ['is it weird to message on LinkedIn and email'] },
  { id: 'w01', group: 'Web', turns: ['did Stripe have layoffs recently'] },
  { id: 'g01', group: 'Goals and settings', turns: ['I got the offer from Stripe'] },
  { id: 'g02', group: 'Goals and settings', turns: ['remember I prefer email over LinkedIn'] },
  { id: 'g03', group: 'Goals and settings', turns: ['pause outreach until after finals'] },
  { id: 'x01', group: 'Big asks and safety', turns: ['do everything you can to help me land Stripe'] },
  { id: 'x02', group: 'Big asks and safety', turns: ['just send all my drafts without reading them'] },
  { id: 'x03', group: 'Big asks and safety', turns: ['help'] },
  { id: 'x04', group: 'Big asks and safety', turns: ['what do you do with my emails'] },
];

interface Shot {
  id: string;
  group: string;
  turn: number;
  text: string;
  file: string;
  seconds: number;
  status: string;
  cards: string[];
  error: string | null;
}

async function loadDemo(page: Page) {
  await prep(page);
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
        },
      });
      return;
    }
    const res = await route.fetch({
      url: req.url().replace('https://api.anthropic.com', SHIM!),
      timeout: 300_000,
    });
    await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
  });
  await page.addInitScript(() => {
    (window as unknown as { __ORBIT_ANTHROPIC_KEY__?: string }).__ORBIT_ANTHROPIC_KEY__ =
      'sk-ant-shim-placeholder';
  });
  await page.goto('');
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
  await expect(page.getByTestId('composer-mode')).not.toHaveText(/Templates/);
}

async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 300_000 });
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
}

/** Photographs the newest exchange: from the top of the student's message to the bottom of Orbit's reply. */
async function photograph(page: Page, path: string) {
  await page.waitForTimeout(600);
  const user = page.getByTestId('turn-user').last();
  const reply = page.getByTestId('turn-assistant').last();
  await reply.scrollIntoViewIfNeeded();
  let a = await user.boundingBox();
  let b = await reply.boundingBox();
  if (!a || !b) {
    await page.screenshot({ path });
    return;
  }
  const vp = page.viewportSize()!;
  const need = b.y + b.height - a.y + 48;
  if (need > vp.height) {
    await page.setViewportSize({ width: vp.width, height: Math.min(Math.ceil(need) + 200, 6000) });
    await page.waitForTimeout(400);
    await reply.scrollIntoViewIfNeeded();
    a = (await user.boundingBox())!;
    b = (await reply.boundingBox())!;
  }
  const top = Math.max(0, a.y - 16);
  const bottom = b.y + b.height + 16;
  const left = Math.max(0, Math.min(a.x, b.x) - 24);
  const right = Math.min(page.viewportSize()!.width, Math.max(a.x + a.width, b.x + b.width) + 24);
  await page.screenshot({ path, clip: { x: left, y: top, width: right - left, height: bottom - top } });
  await page.setViewportSize(vp);
}

test.describe('chat gallery: real answers photographed for review', () => {
  test.skip(!SHIM, 'GALLERY_SHIM is not set');
  test.describe.configure({ mode: 'parallel', timeout: 900_000 });
  test.use({ viewport: { width: 1180, height: 1000 } });

  for (const c of CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
    test(`${c.id}: ${c.turns.join(' / ')}`, async ({ page }) => {
      mkdirSync(DIR, { recursive: true });
      await loadDemo(page);
      const shots: Shot[] = [];
      for (const [i, text] of c.turns.entries()) {
        const started = Date.now();
        await ask(page, text);
        const reply = page.getByTestId('turn-assistant').last();
        await expect(reply).toHaveAttribute('data-status', /done|error|stopped/, { timeout: 300_000 });
        // a pill question ends the turn waiting on the student: the next turn answers it in words
        const look = await reply.evaluate((el) => ({
          status: el.getAttribute('data-status') ?? '',
          cards: [...el.querySelectorAll('[data-testid^="result-"]')].map((n) =>
            n.getAttribute('data-testid')!.replace('result-', ''),
          ),
          error: el.querySelector('[data-testid="turn-error"]')?.textContent ?? null,
        }));
        const file = `${c.id}-${i + 1}.png`;
        await photograph(page, `${DIR}/${file}`);
        shots.push({
          id: c.id,
          group: c.group,
          turn: i + 1,
          text,
          file,
          seconds: Math.round((Date.now() - started) / 100) / 10,
          ...look,
        });
        console.log(
          `[gallery ${c.id}.${i + 1}] ${shots.at(-1)!.seconds}s ${look.status} ${look.cards.join(',')}`,
        );
      }
      writeFileSync(`${DIR}/${c.id}.json`, JSON.stringify(shots, null, 2));
    });
  }
});
