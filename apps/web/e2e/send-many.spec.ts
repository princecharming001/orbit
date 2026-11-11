import { expect, type Page, test } from '@playwright/test';
import { type FakeOrbitApi, withReplies } from '../src/test/fakeOrbitApi';
import { withFakeApi } from './fakeApi';
import { loadDemo } from './helpers';

/**
 * Plan 38: Send to many. Pick people on People, review the messages once, pick a pace, and schedule; the queue under
 * Drafts shows every email by day with Send now, Next day and Cancel; a group's funnel and the reply switch are kept;
 * the Chats page opens on the week's calls. In the demo, and on the fake account where the server writes and holds
 * each email.
 */

async function pickRecruitersOrEveryone(page: Page, n?: number) {
  await page.goto('people?view=list');
  await page.getByTestId('people-select').click();
  if (n === undefined) await page.getByTestId('people-select-all').click();
  else {
    const boxes = page.getByTestId('people-row-select');
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
  }
  await expect(page.getByTestId('people-selection-bar')).toBeVisible();
  await page.getByTestId('people-write-selected').click();
  await expect(page.getByTestId('send-many')).toBeVisible();
}

test.describe('Send to many, in the demo (plan 38)', () => {
  test('select people, read the messages, a plan by day under the limit, schedule, and the queue', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    await pickRecruitersOrEveryone(page, 6);
    await expect(page.getByTestId('send-many-schedule')).toBeEnabled({ timeout: 60_000 });
    // the plan: days, none over the pace's number, and a summary that says when the last one goes
    const days = page.getByTestId('send-many-day');
    await expect(days.first()).toBeVisible();
    await expect(page.getByTestId('send-many-summary')).toContainText(/at most 8 a day/);
    // Gentle caps a day at 4
    await page.getByTestId('send-many-pace-gentle').click();
    await expect(page.getByTestId('send-many-summary')).toContainText(/at most 4 a day/);
    await page.getByTestId('send-many-pace-steady').click();
    // a message opens to be read and changed in place
    await page.getByTestId('send-many-row').first().locator('button').first().click();
    await expect(page.getByTestId('send-many-editor')).toBeVisible();
    // no dash and no exclamation mark in what the page says
    const text = await page.getByTestId('send-many').innerText();
    expect(text.split('\n').filter((l) => /[—–]|!(?!=)/.test(l))).toEqual([]);
    const n = Number((await page.getByTestId('send-many-schedule').innerText()).match(/\d+/)?.[0]);
    expect(n).toBeGreaterThan(0);
    await page.getByTestId('send-many-schedule').click();
    await expect(page.getByTestId('send-many-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('send-many-done-first')).toContainText('The first goes to');
    await page.getByTestId('send-many-see-queue').click();
    // the queue: by day, each with its count against the limit, the batch with its progress
    await expect(page.getByTestId('drafts-scheduled')).toBeVisible();
    await expect(page.getByTestId('queue-next')).toContainText(
      `${n} ${n === 1 ? 'email' : 'emails'} scheduled`,
    );
    await expect(page.getByTestId('queue-batch').first()).toContainText('to go');
    const items = page.getByTestId('scheduled-item');
    await expect(items).toHaveCount(n);
    // Next day moves one; Cancel makes one a draft again
    await items.first().getByTestId('scheduled-move').click();
    await expect(page.getByTestId('toasts')).toContainText('Moved to the next working day');
    await items.first().getByTestId('scheduled-cancel').click();
    await expect(items).toHaveCount(n - 1);
    // Cancel the rest empties the batch
    await page.getByTestId('queue-cancel-rest').first().click();
    await expect(page.getByTestId('scheduled-item')).toHaveCount(0);
  });

  test("the student's own message, filled in per person", async ({ page }) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    await pickRecruitersOrEveryone(page, 3);
    await page.getByTestId('send-many-mode-own').click();
    await page.getByTestId('send-many-template-body').fill('Hi {first}, a quick question about {company}.');
    await page.getByTestId('send-many-insert-title').click();
    await expect(page.getByTestId('send-many-template-body')).toHaveValue(/\{title\}/);
    // each row reads the filled message (the first name in place of the field)
    const row = page.getByTestId('send-many-row').first();
    await expect(row).not.toContainText('{first}', { timeout: 20_000 });
    await expect(row).toContainText('a quick question about');
  });

  test('a group funnel: the booking link reply and the follow-up are kept with the batch', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadDemo(page);
    await pickRecruitersOrEveryone(page, 2);
    await page.getByTestId('send-many-interested-link').click();
    await expect(page.getByTestId('send-many-link-reply')).toHaveValue(/\{link\}/);
    await page.getByTestId('send-many-follow-up').fill('Hi {first}, floating this back up.');
    await expect(page.getByTestId('send-many-schedule')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('send-many-schedule').click();
    await expect(page.getByTestId('send-many-done')).toBeVisible({ timeout: 30_000 });
    const kept = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res) => {
        open.onsuccess = () => res(open.result);
      });
      const rows: { replyFunnels?: { interested: string; followUp?: string; personIds: string[] }[] }[] =
        await new Promise((res) => {
          const r = idb.transaction('settings').objectStore('settings').getAll();
          r.onsuccess = () => res(r.result);
        });
      return rows.flatMap((r) => r.replyFunnels ?? []);
    });
    expect(kept.at(-1)).toMatchObject({ interested: 'link', followUp: 'Hi {first}, floating this back up.' });
    expect(kept.at(-1)!.personIds.length).toBeGreaterThan(0);
  });

  test('the calls: a week on the Chats page, with the next week a click away', async ({ page }) => {
    await loadDemo(page);
    await page.goto('chats');
    await expect(page.getByTestId('chats-week')).toBeVisible();
    await expect(page.getByTestId('chats-week-call').first()).toBeVisible();
    await page.getByTestId('chats-week-next').click();
    await expect(page.getByTestId('chats-week')).toContainText(/Next week/);
    // a month, and a list of what is coming and what happened
    await page.getByTestId('chats-view-month').click();
    await expect(page.getByTestId('chats-month')).toBeVisible();
    await expect(page.getByTestId('chats-month-call').first()).toBeVisible();
    await page.getByTestId('chats-view-list').click();
    await expect(page.getByTestId('chats-list-upcoming')).toBeVisible();
    await expect(page.getByTestId('chats-list-call').first()).toBeVisible();
    // the choice is kept for the next visit
    await page.reload();
    await expect(page.getByTestId('chats-list')).toBeVisible();
  });
});

const PEOPLE = [
  { name: 'Priya Shah', org: 'Stripe', title: 'University Recruiter' },
  { name: 'Sam Lee', org: 'Ramp', title: 'Technical Recruiter' },
  { name: 'Noor Haddad', org: 'Figma', title: 'Talent Acquisition' },
];

async function signedInWithRecruiters(page: Page): Promise<{ api: FakeOrbitApi; ids: string[] }> {
  const api = await withFakeApi(page);
  api.state.status.google.scopes = ['https://www.googleapis.com/auth/gmail.send'];
  withReplies(api, { id: api.state.user.id, firstName: api.state.user.firstName ?? 'Maya' }, []);
  api.state.user.onboarding = { completed_at: '2026-10-05T12:00:00.000Z' };
  const at = '2026-10-01T12:00:00.000Z';
  const ids = PEOPLE.map(() => crypto.randomUUID());
  api.state.pages.push({
    changes: {
      people: PEOPLE.map((p, i) => ({
        id: ids[i],
        displayName: p.name,
        currentOrganizationRaw: p.org,
        currentTitle: p.title,
        userId: api.state.user.id,
        primaryEmail: `${p.name.split(' ')[0]!.toLowerCase()}@${p.org.toLowerCase()}.com`,
        emails: [`${p.name.split(' ')[0]!.toLowerCase()}@${p.org.toLowerCase()}.com`],
        sources: ['gmail'],
        tieScore: 20,
        tieBand: 'weak',
        interactionCount: 2,
        lastInteractionAt: at,
        createdAt: at,
        updatedAt: at,
      })),
    },
  });
  await page.goto('');
  await page.getByTestId('landing-login').click();
  await expect(page.getByTestId('greeting')).toBeVisible({ timeout: 20_000 });
  return { api, ids };
}

test.describe('Send to many, on an account (plan 38)', () => {
  test('the server writes each draft and holds each email for its time; the reply switch and the group go up', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { api, ids } = await signedInWithRecruiters(page);
    await page.goto('people?view=list&f=recruiters');
    await expect(page.getByTestId('people-row')).toHaveCount(3);
    await page.getByTestId('people-select').click();
    await page.getByTestId('people-select-all').click();
    await expect(page.getByTestId('people-selected-count')).toHaveText('3 selected');
    await page.getByTestId('people-write-selected').click();
    await expect(page.getByTestId('send-many')).toBeVisible();
    await expect(page.getByTestId('send-many')).toContainText('Recruiters,');
    await page.getByTestId('send-many-auto-replies').getByRole('switch').click();
    await expect(page.getByTestId('send-many-schedule')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('send-many-schedule').click();
    await expect(page.getByTestId('send-many-done')).toBeVisible({ timeout: 30_000 });
    // each one composed on the server, then approved there with its own time, all different, all ahead
    const composed = api.calls.filter((c) => c.route === '/drafts/compose');
    expect(composed.map((c) => c.body.personId).sort()).toEqual([...ids].sort());
    const approved = api.calls.filter((c) => c.route === '/drafts/approve');
    expect(approved).toHaveLength(3);
    const times = approved.map((c) => Date.parse(String(c.body.sendAt)));
    expect(new Set(times).size).toBe(3);
    // ahead of the page's clock (the tests run the app on 6 October 2026, 10:00)
    for (const t of times) expect(t).toBeGreaterThan(Date.parse('2026-10-06T10:00:00'));
    // one recruiter a company a day: three companies, so the day holds all three, spaced apart
    const settings = api.calls.filter((c) => c.route === '/settings/profile').map((c) => c.body);
    expect(settings.some((b) => b.autoReplies === true)).toBe(true);
    const funnels = settings.flatMap((b) => (b.replyFunnels as { personIds: string[] }[] | undefined) ?? []);
    expect(funnels.at(-1)?.personIds.sort()).toEqual([...ids].sort());
    // the queue shows the server's held emails
    await page.getByTestId('send-many-see-queue').click();
    await expect(page.getByTestId('scheduled-item')).toHaveCount(3);
    // Next day asks the server for the new time
    await page.getByTestId('scheduled-item').first().getByTestId('scheduled-move').click();
    await expect.poll(() => api.calls.filter((c) => c.route === '/drafts/approve').length).toBe(4);
    // Cancel asks the server to stop it
    await page.getByTestId('scheduled-item').first().getByTestId('scheduled-cancel').click();
    await expect.poll(() => api.calls.filter((c) => c.route === '/drafts/cancel').length).toBe(1);
  });
});
