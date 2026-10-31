import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withReplies } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * Autopilot (plan 29 Part B, B7 acceptance): a week on autopilot against the fake orbit-api. Each flow is written
 * down as the test it will become and kept `fixme` until phases 3 to 5 land the class table, Tomorrow's batch,
 * Needs you, Sent for you, the Autopilot and Voice pages and the chat tools (C1). The fake already seeds a reply of
 * every class and a day on autopilot through `withReplies`, so every row has its data the day the screen exists.
 */

const STUDENT_PEOPLE = [
  { id: 'p_lena_novak', displayName: 'Lena Novak', currentOrganizationRaw: 'Ramp' },
  { id: 'p_daniel_okafor', displayName: 'Daniel Okafor', currentOrganizationRaw: 'Goldman Sachs' },
  { id: 'p_kenji_mori', displayName: 'Kenji Mori', currentOrganizationRaw: 'Figma' },
  { id: 'p_ethan_park', displayName: 'Ethan Park', currentOrganizationRaw: 'Anthropic' },
];

async function signedInOnAutopilot(page: Page): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  withReplies(api, { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' }, STUDENT_PEOPLE);
  await page.goto('');
  return api;
}

test.describe('autopilot (plan 29 B7, fake orbit-api)', () => {
  test.fixme('Settings shows the three modes with their rules, and the rungs as they stand', async ({
    page,
  }) => {
    await signedInOnAutopilot(page);
    await page.goto('settings/autopilot');
    for (const mode of ['Off', 'Assist', 'Autopilot'])
      await expect(page.getByTestId(`autopilot-mode-${mode.toLowerCase()}`)).toContainText(mode);
    await expect(page.getByTestId('autopilot-rules')).toContainText('Email only, never LinkedIn');
    await expect(page.getByTestId('autopilot-rules')).toContainText('At most 5 sends a day on its own');
    await expect(page.getByTestId('autopilot-rung-first_touch')).toContainText('14 of 20');
  });

  test.fixme("the batch is shown in the evening as Tomorrow's batch, with Hold, Edit and Send now", async ({
    page,
  }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    const batch = page.getByTestId('tomorrow-batch');
    await expect(batch.getByTestId('batch-item')).toHaveCount(2);
    await expect(batch).toContainText('Grace Liu');
    await expect(batch).toContainText('8:40');
    for (const name of [/^hold/i, /^edit/i, /^send now/i])
      await expect(batch.getByRole('button', { name }).first()).toBeVisible();
  });

  test.fixme('a hold keeps one message back and the rest goes in the morning', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    await page
      .getByTestId('batch-item')
      .filter({ hasText: 'Grace Liu' })
      .getByRole('button', { name: /^hold/i })
      .click();
    await expect(page.getByTestId('tomorrow-batch').getByTestId('batch-item')).toHaveCount(1);
    expect(api.state.autopilot.held.map((h) => h.personName)).toContain('Grace Liu');
    // the morning: the clock passes the send time and Sent for you gains the one that went
    await page.clock.fastForward('18:00:00');
    await expect(page.getByTestId('sent-for-you')).toContainText('Omar Haddad');
    await expect(page.getByTestId('sent-for-you')).not.toContainText('Grace Liu');
  });

  test.fixme('a seeded reply of each class produces the right card or send', async ({ page }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    // interested: a slots reply drafted; scheduling: booked and confirmed; question: Needs you
    await expect(page.getByTestId('needs-you')).toContainText('Daniel Okafor');
    await expect(page.getByTestId('needs-you')).toContainText('applied through the portal');
    await expect(page.getByTestId('sent-for-you')).toContainText('Lena Novak');
    await expect(page.getByTestId('draft-card').filter({ hasText: 'Maya Chen' })).toContainText('times');
    // objection, not now, referral: drafts for approval, never sent
    for (const name of ['Victor Castro', 'Ethan Park', 'Sofia Bennett'])
      await expect(page.getByTestId('draft-card').filter({ hasText: name })).toBeVisible();
    // decline and unsubscribe: closed, do not contact, no draft
    for (const name of ['Jonah Reyes', 'Chloe Dubois']) {
      await expect(page.getByTestId('draft-card').filter({ hasText: name })).toHaveCount(0);
      await expect(page.getByTestId('closed-threads')).toContainText(name);
    }
  });

  test.fixme('Needs you is answered from the chat and the reply drafts itself around the answer', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('chat');
    await page.getByTestId('chat-input').fill('answer Dan: yes, applied Monday');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('draft-card').filter({ hasText: 'Daniel Okafor' })).toContainText(
      'applied on Monday',
    );
    expect(api.state.drafts.get('draft_daniel_question')?.needsInput).toEqual([]);
    expect(api.state.autopilot.needsYou).toHaveLength(0);
  });

  test.fixme('a confirmed slot books the call and raises the prep card', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    await expect(page.getByTestId('sent-for-you').filter({ hasText: 'Lena Novak' })).toContainText('booked');
    await expect(page.getByTestId('prep-card').filter({ hasText: 'Lena' })).toBeVisible();
    expect(api.routes()).toContain('/calendar/book');
  });

  test.fixme('the breaker pauses first messages at the first unsubscribe and tells the student', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('');
    await expect(page.getByTestId('autopilot-breaker-card')).toContainText('Chloe Dubois');
    await expect(page.getByTestId('autopilot-breaker-card')).toContainText('Paused Ramp first messages');
    expect(api.state.autopilot.pausedGoals.length).toBeGreaterThan(0);
  });

  test.fixme('Sent for you lists replies and first messages with Undo for a minute', async ({ page }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    const sent = page.getByTestId('sent-for-you');
    await expect(sent.getByTestId('sent-item')).toHaveCount(3);
    await expect(sent).toContainText('Sent 8:41 am their time');
    await expect(sent.getByRole('button', { name: /^undo/i }).first()).toBeVisible();
  });

  test.fixme('pause from the chat stops everything within the tick and says what stopped', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('chat');
    await page.getByTestId('chat-input').fill('pause everything');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('chat-message').last()).toContainText('Paused');
    expect(api.state.autopilot.pausedUntil).toBeTruthy();
    expect(api.state.autopilot.queued).toHaveLength(0);
  });

  test.fixme('Settings, Voice: the card as prose and the learned notes with Keep and Forget', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('settings/voice');
    await expect(page.getByTestId('voice-card')).toContainText('You greet with Hi');
    const notes = page.getByTestId('voice-note');
    await expect(notes).toHaveCount(3);
    await notes
      .filter({ hasText: 'Thanks either way' })
      .getByRole('button', { name: /^forget/i })
      .click();
    await expect(notes).toHaveCount(2);
    expect(api.state.voice.notes.find((n) => n.id === 'vn_thanks_either_way')?.forgottenAt).toBeTruthy();
    await page.getByTestId('voice-relearn').click();
    expect(api.state.voice.relearnRequests).toBe(1);
  });
});
