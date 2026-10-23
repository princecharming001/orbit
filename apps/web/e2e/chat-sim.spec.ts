import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

/**
 * Multi-turn threads on the REAL engine in router mode (no key), the way the offline simulation plays them
 * (src/chat/__tests__/sim/offline): each follow-up is read against what the last card showed ("draft a message to
 * each of them", "make it shorter", "what should I ask him", "send it"), and nothing goes out without Approve.
 * CHAT_SHOTS_DIR, when set, receives chat-sim-*.png at laptop and phone sizes.
 */
const SHOTS = process.env.CHAT_SHOTS_DIR;

async function home(page: Page) {
  await loadDemo(page);
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('turn-user').last()).toHaveText(text);
}

const lastTurn = (page: Page) => page.getByTestId('turn-assistant').last();

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/chat-sim-${name}.png` });
}

for (const size of [
  { name: 'laptop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`Chat threads on the real engine (${size.name})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('who I know at a company, a draft to each, shorter, send needs Approve', async ({ page }) => {
      await home(page);
      await ask(page, 'who do I know at Ramp');
      await expect(lastTurn(page).getByTestId('result-company')).toBeVisible({ timeout: 20_000 });
      await ask(page, 'draft a message to each of them');
      await expect(lastTurn(page).getByTestId('result-drafts')).toBeVisible({ timeout: 20_000 });
      await shot(page, `${size.name}-company-each`);
      await ask(page, 'make it shorter');
      // more than one draft: it asks which, with a pill each
      await expect(lastTurn(page)).toContainText(/Which one should I shorten\?/, { timeout: 20_000 });
      await lastTurn(page).getByTestId('choice-pill').first().click();
      await expect(lastTurn(page)).toContainText(/Cut it down to the ask/, { timeout: 20_000 });
      await ask(page, 'send it');
      const confirm = lastTurn(page).getByTestId('result-needs_confirmation');
      await expect(confirm).toBeVisible({ timeout: 20_000 });
      await expect(confirm).toContainText(/Needs your approval/i);
      await shot(page, `${size.name}-shorten-send`);
      await expect(page.getByText(/[—–]/)).toHaveCount(0);
    });

    test('prep for the next chat, then what to ask him', async ({ page }) => {
      await home(page);
      await ask(page, 'prep me for my next chat');
      const person = lastTurn(page).getByTestId('result-person');
      await expect(person).toBeVisible({ timeout: 20_000 });
      await expect(person).toContainText('Ethan Park');
      await ask(page, 'what should I ask him');
      await expect(lastTurn(page).getByTestId('result-person')).toContainText('Ethan Park', {
        timeout: 20_000,
      });
      await expect(lastTurn(page)).not.toContainText(/needs a Claude key/);
      await shot(page, `${size.name}-prep`);
    });

    test('who went quiet, then a tap on the next step', async ({ page }) => {
      await home(page);
      await ask(page, 'who went quiet');
      const pipeline = lastTurn(page).getByTestId('result-pipeline');
      await expect(pipeline).toBeVisible({ timeout: 20_000 });
      const step = pipeline.getByTestId('next-step').first();
      await expect(step).toBeVisible();
      await step.click();
      await expect(
        lastTurn(page).locator('[data-testid="result-drafts"], [data-testid="result-draft"]'),
      ).toBeVisible({
        timeout: 20_000,
      });
      await shot(page, `${size.name}-quiet-followup`);
    });
  });
}
