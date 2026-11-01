import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withReplies } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * Autopilot (plan 29 Part B, B7 acceptance): a week on autopilot against the fake orbit-api. Phase 3 made the reply
 * flows real: Tomorrow's batch with Hold, a seeded reply of each class producing its card or send, Needs you answered
 * from the chat, a confirmed slot booking the call, the breaker, Sent for you and the pause. Phase 4 made Settings,
 * Voice real; the flows that wait on phase 5 (the Autopilot page, the morning send of a first message) stay `fixme`
 * with what they will prove.
 */

const STUDENT_PEOPLE = [
  { id: 'p_lena_novak', displayName: 'Lena Novak', currentOrganizationRaw: 'Ramp' },
  { id: 'p_daniel_okafor', displayName: 'Daniel Okafor', currentOrganizationRaw: 'Goldman Sachs' },
  { id: 'p_kenji_mori', displayName: 'Kenji Mori', currentOrganizationRaw: 'Figma' },
  { id: 'p_ethan_park', displayName: 'Ethan Park', currentOrganizationRaw: 'Anthropic' },
];

/** Signed in to the fake account (setup finished), with a reply of every class and a day on autopilot seeded. */
async function signedInOnAutopilot(page: Page): Promise<FakeOrbitApi> {
  const api = await withFakeApi(page);
  withReplies(api, { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' }, STUDENT_PEOPLE);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  // the people the replies came from, as the first sync page brings them
  const at = '2026-10-01T12:00:00.000Z';
  api.state.pages.push({
    changes: {
      people: STUDENT_PEOPLE.map((p) => ({
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

const composer = (page: Page) => page.getByTestId('composer-input');
async function say(page: Page, text: string) {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
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

  test("the batch is shown in the evening as Tomorrow's batch, with Hold, Edit and Send now", async ({
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

  test('a hold keeps one message back; the rest stays queued', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    await page
      .getByTestId('batch-item')
      .filter({ hasText: 'Grace Liu' })
      .getByRole('button', { name: /^hold/i })
      .click();
    await expect(page.getByTestId('tomorrow-batch').getByTestId('batch-item')).toHaveCount(1);
    await expect(page.getByTestId('tomorrow-batch')).toContainText('Omar Haddad');
    expect(api.state.autopilot.held.map((h) => h.personName)).toContain('Grace Liu');
    expect(api.state.autopilot.queued.map((h) => h.personName)).toEqual(['Omar Haddad']);
  });

  test.fixme('the morning: the clock passes the send time and Sent for you gains the one that went', async ({
    page,
  }) => {
    // phase 5: the first-message rung and the morning send
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    await page.clock.fastForward('18:00:00');
    await expect(page.getByTestId('sent-for-you')).toContainText('Omar Haddad');
  });

  test('a seeded reply of each class produces the right card or send', async ({ page }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    // question: Needs you, with the question in their words
    await expect(page.getByTestId('needs-you')).toContainText('Daniel Okafor');
    await expect(page.getByTestId('needs-you')).toContainText('applied through the portal');
    // scheduling: the confirmation went this morning under Sent for you
    await expect(page.getByTestId('sent-for-you')).toContainText('Lena Novak');
    // decline and unsubscribe: closed, do not contact, no draft, said so
    for (const name of ['Jonah Reyes', 'Chloe Dubois']) {
      await expect(page.getByTestId('closed-threads')).toContainText(name);
      await expect(page.getByTestId('needs-you-item').filter({ hasText: name })).toHaveCount(0);
    }
    await expect(page.getByTestId('closed-threads')).toContainText('asked to stop');
    await expect(page.getByTestId('closed-threads')).toContainText('declined');
    // objection, referral and interested wait for the student as the server's drafts (agents-funnel.test.ts): nothing
    // of theirs is under Sent for you (Ethan's not now came after this morning's bump, which is there)
    for (const name of ['Victor Castro', 'Sofia Bennett', 'Maya Chen'])
      await expect(page.getByTestId('sent-for-you').filter({ hasText: name })).toHaveCount(0);
  });

  test('Needs you is answered from the chat and the reply drafts itself around the answer', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    // the card arrives with the first reply check, then the chat finds it by name
    await page.goto('drafts');
    await expect(page.getByTestId('needs-you')).toContainText('Daniel Okafor');
    await page.goto('');
    await say(page, 'answer Dan: yes, applied Monday');
    const turn = page.getByTestId('turn-assistant').last();
    await expect(turn).toContainText(/Drafted the reply to Daniel/);
    await expect(turn).toContainText('yes, applied Monday');
    expect(api.state.drafts.get('draft_daniel_question')?.needsInput).toEqual([]);
    expect(api.state.drafts.get('draft_daniel_question')?.body).toContain('yes, applied Monday');
    expect(api.state.autopilot.needsYou).toHaveLength(0);
    // nothing was sent: the draft waits
    expect(api.state.drafts.get('draft_daniel_question')?.status).toBe('draft');
  });

  test('Needs you is answered from the card and the card is done', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    const item = page.getByTestId('needs-you-item').filter({ hasText: 'Daniel Okafor' });
    await item.getByTestId('needs-you-answer').fill('yes, applied Monday');
    await item.getByTestId('needs-you-send').click();
    await expect(page.getByTestId('needs-you-item').filter({ hasText: 'Daniel Okafor' })).toHaveCount(0);
    expect(api.state.drafts.get('draft_daniel_question')?.body).toContain('yes, applied Monday');
  });

  test('a confirmed slot books the call and puts it on the calendar for its prep card', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    await expect(
      page.getByTestId('sent-for-you').getByTestId('sent-item').filter({ hasText: 'Lena Novak' }),
    ).toContainText('booked');
    // the call is on the calendar at once; its prep card follows the day before, the way plan 22 raises it
    // (the next reply check puts it there too, when the first one raced the first sync)
    await expect(async () => {
      if (!(await page.getByTestId('coming-up').textContent())?.includes('Lena Novak')) {
        await page.reload();
        await expect(page.getByTestId('coming-up')).toContainText('Lena Novak', { timeout: 3000 });
      }
    }).toPass({ timeout: 20_000 });
    expect(api.routes()).toContain('/calendar/book');
    const book = api.calls.find((c) => c.route === '/calendar/book')!;
    expect(book.body).toEqual({ draftId: 'draft_lena_slots', slotStart: '2026-10-08T15:00:00Z' });
    // once: a second look books nothing again
    await page.reload();
    await expect(page.getByTestId('sent-for-you')).toContainText('Lena Novak');
    expect(api.calls.filter((c) => c.route === '/calendar/book')).toHaveLength(1);
  });

  test('the breaker pauses first messages at the first unsubscribe and tells the student', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    const card = page.getByTestId('autopilot-breaker-card');
    await expect(card).toContainText('Chloe Dubois');
    await expect(card).toContainText('Paused Ramp first messages');
    expect(api.state.autopilot.pausedGoals.length).toBeGreaterThan(0);
    expect(api.state.autopilot.pausedGoals[0]!.goalId).toBe('goal_internships');
    // nothing is said with a dash or an exclamation mark
    await expect(card).not.toContainText(/[–—!]/);
  });

  test('Sent for you lists the replies answered and the calls booked, each with when it went', async ({
    page,
  }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    const sent = page.getByTestId('sent-for-you');
    await expect(sent.getByTestId('sent-item')).toHaveCount(3);
    await expect(sent).toContainText('Sent 8:41 am their time');
    await expect(sent).toContainText('Kenji Mori');
    await expect(sent).toContainText('Ethan Park');
    // everything seeded went already: Undo is only for a send still ahead (SentForYou.test.tsx pins the window)
    await expect(sent.getByRole('button', { name: /^undo/i })).toHaveCount(0);
  });

  test('pause from the chat stops everything and says what stopped', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('');
    await say(page, 'pause everything');
    await expect(page.getByTestId('turn-assistant').last()).toContainText(
      /Paused everything Orbit sends on its own/,
    );
    expect(api.state.autopilot.pausedUntil).toBeTruthy();
    expect(api.state.autopilot.queued).toHaveLength(0);
    await say(page, 'what did you send today');
    await expect(page.getByTestId('turn-assistant').last()).toContainText(/Sent 3 on its own today/);
  });

  test('Settings, Voice: the card as prose and the learned notes with Keep and Forget', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('settings/voice');
    await expect(page.getByTestId('voice-card')).toContainText('You greet with Hi');
    await expect(page.getByTestId('voice-score')).toContainText('2.6 of 3');
    const notes = page.getByTestId('voice-note');
    await expect(notes).toHaveCount(3);
    await notes
      .filter({ hasText: 'Thanks either way' })
      .getByRole('button', { name: /^forget/i })
      .click();
    await expect(notes).toHaveCount(2);
    expect(api.state.voice.notes.find((n) => n.id === 'vn_thanks_either_way')?.forgottenAt).toBeTruthy();
    await notes.filter({ hasText: 'first name' }).getByRole('button', { name: /^keep/i }).click();
    await expect(notes.filter({ hasText: 'first name' })).toContainText('Kept');
    await page.getByTestId('voice-relearn').click();
    await expect.poll(() => api.state.voice.relearnRequests).toBe(1);
    // plain words: no dash and no exclamation mark anywhere on the page
    await expect(page.locator('main')).not.toContainText(/[\u2014\u2013!]/);
    // the chat reads the same notes, the forgotten one gone
    await page.goto('');
    await say(page, 'what have you learned about how I write');
    await expect(page.getByTestId('turn-assistant').last()).toContainText(
      'You sign with your first name only',
    );
    await expect(page.getByTestId('turn-assistant').last()).not.toContainText('Thanks either way');
  });
});
