import { expect, type Page, test } from '@playwright/test';
import { prep } from './helpers';

/**
 * Tap-to-answer choices and the inline setup widgets, against the scripted FakeChatEngine (`?fakeEngine=1`; the trigger
 * phrases are listed in src/chat/testing/fakeEngine.ts). The widgets themselves run the app's real engine code.
 */
async function home(page: Page) {
  await prep(page);
  await page.goto('?fakeEngine=1');
  await page
    .getByRole('button', { name: /^try the demo$/i })
    .first()
    .click();
  // the demo lands on the chat, its home
  await expect(page.getByTestId('greeting')).toContainText(/^Hey /, { timeout: 90_000 });
  await page.goto('');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

const composer = (page: Page) => page.getByTestId('composer-input');
async function ask(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
}

type FakeCall = { method: string; args: unknown[] };
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeChat: { calls: FakeCall[] } }).__fakeChat.calls);

test.describe('Chat widgets', () => {
  test('tapping a choice sends it as the next turn, once, and the pills give way to a quiet line', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'show choices');
    const pills = page.getByTestId('choice-pill');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveText('Show my pipeline');
    await expect(pills.nth(1)).toHaveText('What else can you do?');
    await pills.nth(0).click();
    await expect(page.getByTestId('turn-user').last()).toHaveText('Show my pipeline');
    await expect(page.getByTestId('result-pipeline')).toBeVisible();
    const sent = (await calls(page)).filter((c) => c.method === 'send' && c.args[1] === 'Show my pipeline');
    expect(sent).toHaveLength(1);
    await expect(page.getByTestId('choice-pill')).toHaveCount(0);
    await expect(page.getByTestId('result-choices')).toContainText('You chose: Show my pipeline');
  });

  test('typing instead works and leaves no dead pills behind', async ({ page }) => {
    await home(page);
    await ask(page, 'show choices');
    await expect(page.getByTestId('choice-pill')).toHaveCount(2);
    await ask(page, 'who went quiet');
    await expect(page.getByTestId('result-people')).toBeVisible();
    await expect(page.getByTestId('choice-pill')).toHaveCount(0);
    await expect(page.getByTestId('result-choices')).toHaveCount(0);
  });

  test('the LinkedIn widget takes a file, imports it and links to the people and the map', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'setup linkedin');
    const widget = page.getByTestId('setup-linkedin');
    // the demo can connect live, so the export is the second way in
    await widget.getByTestId('linkedin-show-upload').click();
    await expect(widget).toContainText('Settings > Data privacy > Get a copy of your data > Connections');
    const csv = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Tara,Widgetson,https://www.linkedin.com/in/tara-widgetson,,Brex,Associate Product Manager,01 Oct 2026',
      'Dev,Widgetson,https://www.linkedin.com/in/dev-widgetson,,Ramp,Software Engineer,02 Oct 2026',
    ].join('\n');
    await widget
      .getByTestId('linkedin-file')
      .setInputFiles({ name: 'Connections.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByTestId('linkedin-done')).toContainText('2 people added, 0 updated', {
      timeout: 30_000,
    });
    await expect(page.getByRole('link', { name: 'Show the map' })).toBeVisible();
    // the card's links open in the side panel, so the student stays in the chat
    await page.getByRole('link', { name: 'See my people' }).click();
    await expect(page.getByTestId('panel-title')).toHaveText('People');
    await expect(page.getByTestId('panel').getByText('Tara Widgetson').first()).toBeAttached();
  });

  test('the Claude key widget saves and tests a key and never shows it back', async ({ page }) => {
    const KEY = 'sk-ant-api03-e2e-widget-key-0123456789';
    let tested = 0;
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    // never reach the real API: answer the one small test request as Anthropic would for a working key
    await page.route('https://api.anthropic.com/**', (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      tested++;
      return r.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'msg_e2e',
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      });
    });
    await home(page);
    await ask(page, 'setup claude');
    const widget = page.getByTestId('setup-claude_key');
    await expect(widget).toContainText('Without a key');
    const input = widget.getByTestId('claude-key-input');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(widget.getByTestId('claude-key-save')).toBeDisabled();
    await input.fill(KEY);
    await widget.getByTestId('claude-key-save').click();
    await expect(widget.getByTestId('claude-key-result')).toContainText('Saved, and it works');
    expect(tested).toBe(1);
    await expect(input).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    await expect(widget.getByTestId('claude-key-remove')).toBeVisible();
    // the saved key is the one Settings sees, and Settings keeps it hidden as well
    await page.goto('settings/integrations');
    await expect(page.getByLabel('Anthropic API key')).toHaveValue(KEY);
    await expect(page.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
  });

  test('the Google widget in the demo explains the sample calendar without offering a sign-in', async ({
    page,
  }) => {
    await home(page);
    await ask(page, 'setup google');
    await expect(page.getByTestId('google-demo')).toContainText('demo');
    await expect(page.getByTestId('google-connect')).toHaveCount(0);
  });
});
