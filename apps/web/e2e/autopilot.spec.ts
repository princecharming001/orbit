import { expect, type Page, test } from '@playwright/test';
import {
  DANIEL_QUESTION_DRAFT,
  type FakeOrbitApi,
  sendTheBatch,
  withReplies,
} from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';

/**
 * Autopilot (plan 29 Part B, B7 acceptance): a week on autopilot against the fake orbit-api. Phase 3 made the reply
 * flows real: Tomorrow's batch with Hold, a seeded reply of each class producing its card or send, Needs you answered
 * from the chat, a confirmed slot booking the call, the breaker, Sent for you and the pause. Phase 4 made Settings,
 * Voice real; phase 5 the Autopilot page, the first messages in the evening batch that wait for a tap, and the
 * morning send of a first message once the rung is earned.
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
  test('Settings shows the three modes with their rules, and the rungs as they stand', async ({ page }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('settings/autopilot');
    for (const mode of ['Off', 'Assist', 'Autopilot'])
      await expect(page.getByTestId(`autopilot-mode-${mode.toLowerCase()}`)).toContainText(mode);
    await expect(page.getByTestId('autopilot-rules')).toContainText('Email only, never LinkedIn');
    await expect(page.getByTestId('autopilot-rules')).toContainText('At most 5 sends a day on its own');
    await expect(page.getByTestId('autopilot-rung-first_touch')).toContainText('14 of 20');
    await expect(page.getByTestId('settings-autopilot')).not.toContainText(/[–—!]/);
    // a goal runs on autopilot on its own switch
    const goal = api.state.goals[0]!;
    await page.getByTestId(`goal-autopilot-${goal.id}`).getByRole('switch').click();
    await expect
      .poll(() => api.calls.filter((c) => c.route === '/autopilot/mode').map((c) => c.body))
      .toContainEqual(expect.objectContaining({ goalId: goal.id }));
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

  test('the evening: first messages wait for a tap before the rung, and a tap keeps one for the morning', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    const batch = page.getByTestId('tomorrow-batch');
    await expect(batch.getByTestId('batch-needs-tap')).toHaveCount(2);
    await expect(batch.getByTestId('batch-rung')).toContainText('14 of 20 first messages approved unchanged');
    await batch.getByTestId('batch-item').filter({ hasText: 'Grace Liu' }).getByTestId('batch-tap').click();
    await expect(batch.getByTestId('batch-needs-tap')).toHaveCount(1);
    // the morning: Grace was tapped and goes as the student's own; Omar was not, and waits as a draft with the reason
    sendTheBatch(api, '2026-10-07T13:00:00.000Z');
    await page.reload();
    await expect(page.getByTestId('tomorrow-batch')).toHaveCount(0);
    expect(api.state.drafts.get('draft_ap_grace')?.status).toBe('sent');
    expect(api.state.autopilot.held.find((h) => h.personName === 'Omar Haddad')?.reason).toContain(
      'It waited for your tap',
    );
    await expect(page.getByTestId('sent-for-you')).not.toContainText('Omar Haddad');
  });

  test('the morning: once the rung is earned, the send time passes and Sent for you gains the one that went', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    const first = api.state.autopilot.rungs.find((r) => r.kind === 'first_touch')!;
    Object.assign(first, { unchanged: 20, unlocked: true });
    for (const q of api.state.autopilot.queued) q.status = 'queued';
    await page.goto('drafts');
    await expect(page.getByTestId('tomorrow-batch').getByTestId('batch-item')).toHaveCount(2);
    await expect(page.getByTestId('tomorrow-batch').getByTestId('batch-needs-tap')).toHaveCount(0);
    sendTheBatch(api, '2026-10-07T13:00:00.000Z');
    await page.reload();
    await expect(page.getByTestId('sent-for-you')).toContainText('Omar Haddad');
    await expect(page.getByTestId('sent-for-you')).toContainText('Grace Liu');
  });

  test('a seeded reply of each class produces the right send, and Drafts lists no reply questions', async ({
    page,
  }) => {
    await signedInOnAutopilot(page);
    await page.goto('drafts');
    // scheduling: the confirmation went this morning under Sent for you
    await expect(page.getByTestId('sent-for-you')).toContainText('Lena Novak');
    // a reply's question is answered in the chat, not in a list on Drafts (plan 37 follow-up)
    await expect(page.getByTestId('needs-you')).toHaveCount(0);
    await expect(page.getByTestId('closed-threads')).toHaveCount(0);
    // objection, referral and interested wait for the student as the server's drafts (agents-funnel.test.ts): nothing
    // of theirs is under Sent for you (Ethan's not now came after this morning's bump, which is there)
    for (const name of ['Victor Castro', 'Sofia Bennett', 'Maya Chen'])
      await expect(page.getByTestId('sent-for-you').filter({ hasText: name })).toHaveCount(0);
  });

  test('Needs you is answered from the chat and the reply drafts itself around the answer', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    // the question arrives with the first reply check, then the chat finds it by name
    await page.goto('drafts');
    await expect(page.getByTestId('sent-for-you')).toContainText('Lena Novak');
    await page.goto('');
    await say(page, 'answer Dan: yes, applied Monday');
    const turn = page.getByTestId('turn-assistant').last();
    // the reply is shown as the draft itself, ready to look over, and goes into Daniel's thread with its subject
    await expect(turn).toContainText(/(Email|Two messages|LinkedIn message) to Daniel Okafor/);
    await expect(turn).toContainText('yes, applied Monday');
    await expect(turn).not.toContainText('Add a subject line');
    expect(api.state.drafts.get(DANIEL_QUESTION_DRAFT)?.needsInput).toEqual([]);
    expect(api.state.drafts.get(DANIEL_QUESTION_DRAFT)?.body).toContain('yes, applied Monday');
    expect(api.state.autopilot.needsYou).toHaveLength(0);
    // nothing was sent: the draft waits
    expect(api.state.drafts.get(DANIEL_QUESTION_DRAFT)?.status).toBe('draft');
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

  test('the breaker pauses first messages at the first unsubscribe, without a Paused list on Drafts', async ({
    page,
  }) => {
    const api = await signedInOnAutopilot(page);
    await page.goto('drafts');
    await expect.poll(() => api.state.autopilot.pausedGoals[0]?.goalId).toBe('goal_internships');
    // the student asked for no Paused section: replies like these are mostly marketers, not people to answer
    await expect(page.getByTestId('autopilot-paused')).toHaveCount(0);
    await expect(page.getByTestId('autopilot-breaker-card')).toHaveCount(0);
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
