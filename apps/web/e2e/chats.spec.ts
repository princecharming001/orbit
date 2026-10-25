import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

type Db = {
  __orbitDb: {
    users: { toArray(): Promise<{ id: string; timezone: string }[]> };
    events: {
      toArray(): Promise<
        {
          id: string;
          startAt: string;
          endAt: string;
          status: string;
          isCoffeeChat?: boolean;
          chatId?: string;
          attendeePersonIds: string[];
          conferenceUrl?: string;
        }[]
      >;
      update(id: string, changes: Record<string, unknown>): Promise<number>;
    };
    notes: { put(row: unknown): Promise<unknown> };
  };
};

/** The demo's next coffee chat on the calendar, made a chat today a little ahead of the page clock. */
async function chatToday(page: Page) {
  return page.evaluate(async () => {
    const db = (window as unknown as Db).__orbitDb;
    const now = Date.now();
    const ev = (await db.events.toArray())
      .filter((e) => e.status !== 'cancelled' && (e.isCoffeeChat || e.chatId) && Date.parse(e.startAt) > now)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0]!;
    const start = new Date(now + 2 * 3_600_000);
    await db.events.update(ev.id, {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      conferenceUrl: ev.conferenceUrl ?? 'https://meet.google.com/abc-defg-hij',
    });
    return { id: ev.id, personId: ev.attendeePersonIds[0]! };
  });
}

/** Plan 23 §4.4: the week's chats, phone first, and what came back after them. */
test.describe('Chats', () => {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ])
    test(`Today with its chat, Join, Prep, the three lines, and a note flips the row (${size.width})`, async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await loadDemo(page);
      const ev = await chatToday(page);
      await page.goto('chats');
      const today = page.getByTestId('chats-day').filter({ hasText: 'Today' });
      await expect(today).toBeVisible();
      const row = today.locator(`[data-testid="chats-row"][data-person-id="${ev.personId}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId('chats-when')).toHaveText(/^\d{1,2}:\d\d [ap]m · 30 min$/);
      // Join opens the meeting in a new tab
      await expect(row.getByTestId('chats-join')).toHaveAttribute('target', '_blank');
      await expect(row.getByTestId('chats-join')).toHaveAttribute('href', /^https:\/\//);
      // the disclosure has its lines
      const more = row.getByTestId('chats-more');
      if (await more.count()) {
        await more.click();
        const lines = row.getByTestId('chats-lines').locator('li');
        expect(await lines.count()).toBeGreaterThan(0);
        expect(await lines.count()).toBeLessThanOrEqual(3);
      }
      // the sidebar (or the More sheet) counts today's chats as the page does
      if (size.width >= 768) {
        const shown = await today.getByTestId('chats-row').count();
        await expect(page.getByTestId('chats-badge')).toHaveText(String(shown));
      } else {
        await page.getByTestId('tab-more').click();
        await expect(page.getByTestId('more-sheet').getByRole('link', { name: 'Chats' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      // Prep opens the person's prep
      await row.getByTestId('chats-prep').click();
      await expect(page).toHaveURL(new RegExp(`/people/${ev.personId}\\?tab=facts&prep=1`));
      // after the chat: a note filed for it flips the row to what came back
      await page.evaluate(async (id) => {
        const db = (window as unknown as Db).__orbitDb;
        const start = new Date(Date.now() - 90 * 60_000);
        await db.events.update(id, {
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
        });
      }, ev.id);
      await page.goto('chats');
      const past = page.getByTestId('chats-just-happened').locator(`[data-person-id="${ev.personId}"]`);
      await expect(past.getByTestId('chats-after')).toBeVisible();
      await page.evaluate(
        async ({ id, personId }) => {
          const db = (window as unknown as Db).__orbitDb;
          const user = (await db.users.toArray())[0]!;
          await db.notes.put({
            id: 'n_e2e',
            userId: user.id,
            source: 'manual',
            occurredAt: new Date(Date.now() - 90 * 60_000).toISOString(),
            rawText: 'We talked about the payments team.',
            attendees: [],
            personIds: [personId],
            calendarEventId: id,
            matchStatus: 'auto',
            createdAt: new Date().toISOString(),
          });
        },
        { id: ev.id, personId: ev.personId },
      );
      await expect(past.getByTestId('chats-after')).toHaveAttribute('data-kind', 'notes_in');
      await expect(past.getByTestId('chats-after')).toContainText('Notes in');
      expect(await page.getByTestId('chats-page').innerText()).not.toMatch(/[–—]/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      void context;
    });
});
