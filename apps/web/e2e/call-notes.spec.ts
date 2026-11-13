import { expect, type Page, test } from '@playwright/test';
import { loadDemo } from './helpers';

type Db = {
  __orbitDb: {
    events: {
      toArray(): Promise<
        {
          id: string;
          startAt: string;
          status: string;
          isCoffeeChat?: boolean;
          chatId?: string;
          attendeePersonIds: string[];
        }[]
      >;
      update(id: string, changes: Record<string, unknown>): Promise<number>;
    };
    notes: { toArray(): Promise<{ source: string; calendarEventId?: string; rawText: string }[]> };
  };
};

/** The demo's next coffee chat, moved so it ended half an hour ago on a call with this link. */
async function chatJustHeldOn(page: Page, conferenceUrl: string) {
  return page.evaluate(async (url) => {
    const db = (window as unknown as Db).__orbitDb;
    const now = Date.now();
    const ev = (await db.events.toArray())
      .filter((e) => e.status !== 'cancelled' && (e.isCoffeeChat || e.chatId) && Date.parse(e.startAt) > now)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0]!;
    const start = new Date(now - 60 * 60_000);
    await db.events.update(ev.id, {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      conferenceUrl: url,
    });
    return { id: ev.id, personId: ev.attendeePersonIds[0]! };
  }, conferenceUrl);
}

const notesFor = (page: Page, eventId: string) =>
  page.evaluate(
    async (id) =>
      (await (window as unknown as Db).__orbitDb.notes.toArray()).filter((n) => n.calendarEventId === id),
    eventId,
  );

/** Zoom and Google Meet beside the notetakers: the call's own transcript lands on the Chats row. */
test.describe('Notes from the call', () => {
  for (const app of [
    { key: 'zoom', name: 'Zoom', url: 'https://us02web.zoom.us/j/85012345678?pwd=demo', source: 'zoom' },
    { key: 'meet', name: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij', source: 'google_meet' },
  ])
    test(`${app.name}: connect, and the chat's transcript notes land on the Chats row`, async ({ page }) => {
      test.setTimeout(120_000);
      await loadDemo(page);
      const ev = await chatJustHeldOn(page, app.url);
      await page.goto('settings/integrations');
      const row = page.getByTestId(`settings-${app.key}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId(`settings-${app.key}-line`)).toHaveText(
        app.key === 'zoom'
          ? 'Notes come in when Zoom records the call to the cloud.'
          : 'Notes come in when your Google account records a transcript.',
      );
      await row.getByTestId(`settings-${app.key}-connect`).click();
      await expect(row.getByTestId(`settings-${app.key}-status`)).toContainText('Connected');
      await expect(row.getByTestId(`settings-${app.key}-status`)).toContainText('1 call');
      expect(await row.innerText()).not.toMatch(/[–—!]/);
      const notes = await notesFor(page, ev.id);
      expect(notes.map((n) => n.source)).toEqual([app.source]);
      expect(notes[0]!.rawText).toContain('Transcript:');
      // the Chats row says the notes are in
      await page.goto('chats');
      const past = page.getByTestId('chats-just-happened').locator(`[data-person-id="${ev.personId}"]`);
      await expect(past.getByTestId('chats-after')).toHaveAttribute('data-kind', 'notes_in');
      await expect(past.getByTestId('chats-after')).toContainText('Notes in');
      // opening the page again never files the same call twice
      await page.reload();
      await expect(past.getByTestId('chats-after')).toHaveAttribute('data-kind', 'notes_in');
      expect(await notesFor(page, ev.id)).toHaveLength(1);
    });

  test('a chat that ends after Zoom is on: the check brings its notes when the Chats page opens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await page.goto('settings/integrations');
    await page.getByTestId('settings-zoom-connect').click();
    await expect(page.getByTestId('settings-zoom-status')).toContainText('Connected');
    const ev = await chatJustHeldOn(page, 'https://us02web.zoom.us/j/85012345678?pwd=demo');
    expect(await notesFor(page, ev.id)).toHaveLength(0);
    await page.goto('chats');
    const past = page.getByTestId('chats-just-happened').locator(`[data-person-id="${ev.personId}"]`);
    await expect(past.getByTestId('chats-after')).toHaveAttribute('data-kind', 'notes_in', {
      timeout: 20_000,
    });
    expect((await notesFor(page, ev.id)).map((n) => n.source)).toEqual(['zoom']);
  });

  test('the call link on invites: Google Meet by default, and the choice is kept', async ({ page }) => {
    test.setTimeout(120_000);
    await loadDemo(page);
    await page.goto('settings/integrations');
    const pick = page.getByTestId('settings-meeting-link');
    await expect(pick).toBeVisible();
    await expect(pick.getByTestId('settings-meeting-link-meet')).toHaveAttribute('aria-checked', 'true');
    await pick.getByTestId('settings-meeting-link-zoom').click();
    await expect(pick.getByTestId('settings-meeting-link-zoom')).toHaveAttribute('aria-checked', 'true');
    await expect(pick.getByTestId('settings-meeting-link-hint')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('settings-meeting-link-zoom')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('settings-zoom-connect').click();
    await expect(page.getByTestId('settings-meeting-link-hint')).toHaveCount(0);
    await page.goto('chats');
    await page.goto('settings/integrations');
    await expect(page.getByTestId('settings-meeting-link-zoom')).toHaveAttribute('aria-checked', 'true');
    expect(await page.getByTestId('settings-meeting-link').innerText()).not.toMatch(/[–—!]/);
  });
});
