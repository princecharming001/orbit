import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * The chat home against the REAL engine and tool registry, in router mode (no Claude key): chips and typed commands
 * run real tools on the demo, the draft card's Approve goes through the same hand-off as the pages, and the rail
 * still reaches every page. (chat.spec.ts drives the UI with the scripted engine instead.)
 */

async function home(page: Page) {
  await loadDemo(page);
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
}

const lastTurn = (page: Page) => page.getByTestId('turn-assistant').last();

test.describe('Chat home on the real engine (no key)', () => {
  test('greeting, chips, router note; a chip and typed commands render real cards', async ({ page }) => {
    await home(page);
    await expect(page.getByTestId('greeting')).toHaveText(/Hey Alex, what.s on your mind today\?/);
    const chips = page.locator('[data-testid^="chip-"]');
    await expect(chips).toHaveCount(8);
    for (const label of [
      'Who should I message today',
      'Draft a thank-you',
      'Find a route to a company',
      'Add a note from a chat',
      'Who went quiet',
      'Prep for my next chat',
      'Import my LinkedIn',
      'Show my pipeline',
    ])
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    await expect(page.getByTestId('router-note')).toContainText(/Without a Claude key/);
    await expect(page.getByTestId('composer-mode')).toContainText(/Templates/);

    // the demo has people waiting, so the greeting carries one small status line
    await expect(page.getByTestId('home-status')).toHaveText(/waiting on a message from you\.$/);

    // a chip runs a real tool: the brief's cards are the demo's own
    await page.getByTestId('chip-who-today').click();
    await expect(page.getByTestId('turn-user').last()).toHaveText(/Who should I message today/);
    const brief = lastTurn(page).getByTestId('result-brief');
    await expect(brief).toBeVisible({ timeout: 20_000 });
    await expect(brief.getByTestId(/^suggestion-/).first()).toBeVisible();

    // typed: the pipeline card lists real people with their stages
    await ask(page, 'show my pipeline');
    const pipeline = lastTurn(page).getByTestId('result-pipeline');
    await expect(pipeline).toBeVisible({ timeout: 20_000 });
    await expect(pipeline).toContainText('Daniel Okafor');
    await expect(pipeline).toContainText(/First message sent/);
    await expect(pipeline.getByTestId('open-in-app')).toHaveAttribute('href', /\/pipeline/);

    // a request that needs judgement says so plainly, with the way to fix it
    await ask(page, "why hasn't Daniel replied?");
    await expect(lastTurn(page)).toContainText(/needs a Claude key/, { timeout: 20_000 });
    await expect(page.getByText(/[—–]/)).toHaveCount(0);
  });

  test('a hello is answered like a friend: one line, the one useful thing, no menu', async ({ page }) => {
    await home(page);
    await ask(page, 'hey');
    const turn = lastTurn(page);
    await expect(turn).toContainText(/Hey Alex\./, { timeout: 20_000 });
    await expect(turn).toContainText(/waiting on a message today/);
    const text = (await turn.innerText()).trim();
    expect(text.split(/\s+/).length).toBeLessThan(60);
    await expect(turn.locator('ol, ul, h1, h2, h3, strong')).toHaveCount(0);
    expect(text).not.toMatch(/[—–!]/);
  });

  test('an empty account starts with three chips and one easy first step, not a manual', async ({ page }) => {
    await home(page);
    // nobody in the account: the sample student's people go
    await page.evaluate(async () => {
      const db = (window as unknown as { __orbitDb: { people: { clear(): Promise<void> } } }).__orbitDb;
      await db.people.clear();
    });
    await page.goto('');
    await expect(page.getByTestId('greeting')).toHaveText(/Hey Alex, what.s on your mind today\?/);
    const chips = page.locator('[data-testid^="chip-"]');
    await expect(chips).toHaveCount(3);
    await expect(chips).toHaveText(['Bring in my LinkedIn', 'Add someone I met', 'What can you do?']);
    await expect(page.getByTestId('home-status')).toHaveText(
      "Let's get you set up. It takes about two minutes.",
    );
    // "What can you do?" is a plain message: a short answer pointing at LinkedIn, no numbered list
    await page.getByTestId('chip-what-can-you-do').click();
    await expect(page.getByTestId('turn-user').last()).toHaveText('What can you do?');
    const turn = lastTurn(page);
    await expect(turn).toContainText(/LinkedIn/, { timeout: 20_000 });
    await expect(turn.locator('ol, ul, h1, h2, h3, strong')).toHaveCount(0);
    // the short answer is the prose; the LinkedIn drop-zone widget carries its own how-to text
    const prose = await turn.getByTestId('md').first().innerText();
    expect(prose.trim().split(/\s+/).length).toBeLessThan(60);
    // "Add someone I met" asks one question
    await ask(page, 'Add someone I met');
    await expect(lastTurn(page)).toContainText(/Who did you meet\?/, { timeout: 20_000 });
  });

  test('a thank-you draft card: Approve hands the edited text off and the card shows the hand-off', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'draft a thank-you to Lena');
    const card = lastTurn(page).getByTestId('result-draft');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('To Lena Novak');
    const body = card.getByLabel('Message body');
    await expect(body).toHaveValue(/Lena/);
    await body.fill(`${await body.inputValue()}\n\nPS edited in the chat`);
    if (await card.getByTestId('draft-attach-resume').isVisible())
      await card.getByTestId('draft-attach-confirm').check();
    // nothing went out yet
    const status = () =>
      page.evaluate(async () => {
        const db = (
          window as unknown as {
            __orbitDb: {
              outbound: { toArray(): Promise<{ kind: string; status: string; bodyFinal?: string }[]> };
            };
          }
        ).__orbitDb;
        return (await db.outbound.toArray()).find((o) => o.kind === 'thank_you');
      });
    expect((await status())?.status).toBe('draft');
    await card.getByRole('button', { name: /^open email to /i }).click();
    const outcome = lastTurn(page).getByTestId('result-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome.getByTestId(/^outbox-(handed_off|queued)$/)).toBeVisible();
    await expect(page.getByTestId('turn-decision').last()).toContainText(/Approved/);
    const after = await status();
    expect(['handed_off', 'queued']).toContain(after?.status);
    expect(after?.bodyFinal).toMatch(/PS edited in the chat/);
  });

  test('a risky command waits for Approve, and Cancel changes nothing', async ({ page }) => {
    await home(page);
    await ask(page, 'hide Victor');
    const confirm = lastTurn(page).getByTestId('result-needs_confirmation');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await expect(confirm.getByTestId('confirm-text')).toContainText(/Victor/);
    await confirm.getByTestId('confirm-cancel').click();
    await expect(confirm.getByTestId('confirm-decided')).toHaveText(/Cancelled/);
    const hidden = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { get(id: string): Promise<{ hiddenAt?: string }> } } }
      ).__orbitDb;
      return (await db.people.get('p7'))?.hiddenAt;
    });
    expect(hidden).toBeUndefined();
  });

  test('every page stays reachable from the rail', async ({ page }) => {
    await home(page);
    const rail = page.getByTestId('rail');
    const pages: [string, RegExp][] = [
      ['Today', /\/today$/],
      ['Pipeline', /\/pipeline/],
      ['People', /\/people$/],
      ['Map', /\/map/],
      ['Discover', /\/discover$/],
      ['Drafts', /\/inbox/],
      ['Settings', /\/settings/],
    ];
    for (const [name, url] of pages) {
      await rail.getByRole('link', { name: new RegExp(`^${name}`) }).click();
      await expect(page).toHaveURL(url);
      await expect(page.locator('main, [role="main"]').first()).toBeVisible();
      await expect(page.getByTestId('greeting')).toHaveCount(0);
    }
    await rail.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByTestId('greeting')).toBeVisible();
  });
});
