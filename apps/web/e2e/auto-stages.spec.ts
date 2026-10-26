import { expect, test } from '@playwright/test';
import { loadDemo, openDrafts } from './helpers';

/**
 * Plan 18: cards move on their own. The reply check runs when the app opens, about every ten minutes and on "Check now";
 * the board and Drafts say when it last ran. The sample student has no inbox to read, so the clock rules are what
 * can be seen here: a booked chat whose meeting ended is finished, with the thank-you ready in Drafts.
 */
test.describe('Automatic stages', () => {
  test('a booked chat whose meeting ended is finished when the app opens, and the line says when it checked', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people');
    const line = page.getByTestId('replies-checked');
    await expect(line).toContainText(/Checked for replies (just now|\d+ min ago)/);
    // a chat the calendar booked for an hour and a half ago, written straight into the database as a sync would
    const name = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const all = <T>(store: string): Promise<T[]> =>
        new Promise((res) => {
          const r = idb.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result as T[]);
        });
      type Chat = { id: string; userId: string; personId: string; stage: string; scheduledEventId?: string };
      type Person = { id: string; displayName: string; isHuman: boolean; hiddenAt?: string };
      const people = await all<Person>('people');
      const chat = (await all<Chat>('chats')).find(
        (c) =>
          c.stage === 'scheduling' && people.some((p) => p.id === c.personId && p.isHuman && !p.hiddenAt),
      )!;
      const person = people.find((p) => p.id === chat.personId)!;
      const now = Date.now();
      const ev = {
        id: 'ev_e2e_done',
        userId: chat.userId,
        externalEventId: 'gcal_e2e_done',
        title: `Coffee chat: ${person.displayName}`,
        startAt: new Date(now - 95 * 60_000).toISOString(),
        endAt: new Date(now - 65 * 60_000).toISOString(),
        status: 'confirmed',
        attendees: [],
        attendeePersonIds: [chat.personId],
        isCoffeeChat: true,
        coffeeChatConfidence: 0.9,
        chatId: chat.id,
      };
      await new Promise<void>((res, rej) => {
        const tx = idb.transaction(['chats', 'events'], 'readwrite');
        tx.objectStore('events').put(ev);
        tx.objectStore('chats').put({
          ...chat,
          stage: 'scheduled',
          stageEnteredAt: new Date(now - 2 * 86_400_000).toISOString(),
          scheduledEventId: ev.id,
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      return person.displayName;
    });
    // opening the app again checks at once: the meeting is over, so the chat is done
    await page.reload();
    await expect(page.getByTestId('chat-card-completed').filter({ hasText: name })).toBeVisible({
      timeout: 20_000,
    });
    const move = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res) => {
        open.onsuccess = () => res(open.result);
      });
      const events: { toStage: string; actor: string; reason: string; status: string; chatId: string }[] =
        await new Promise((res) => {
          const r = idb.transaction('stageEvents').objectStore('stageEvents').getAll();
          r.onsuccess = () => res(r.result);
        });
      const chats: { id: string; scheduledEventId?: string }[] = await new Promise((res) => {
        const r = idb.transaction('chats').objectStore('chats').getAll();
        r.onsuccess = () => res(r.result);
      });
      const chat = chats.find((c) => c.scheduledEventId === 'ev_e2e_done')!;
      return events.filter((e) => e.chatId === chat.id && e.toStage === 'completed');
    });
    // one move, recorded with its reason and by whom
    expect(move).toHaveLength(1);
    expect(move[0]).toMatchObject({ actor: 'system', status: 'applied', reason: 'calendar:event_ended' });

    // Check now runs a check this second, and the line says so; the clock then counts the minutes
    await page.getByTestId('replies-check-now').click();
    await expect(line).toContainText('Checked for replies just now');
    // (the words are refreshed every half minute)
    await page.clock.runFor(150_000);
    await expect(line).toContainText('Checked for replies 2 min ago');
    // the timer checks again on its own within 7 to 13 minutes, and nothing moves twice
    for (let i = 0; i < 14; i++) {
      await page.clock.runFor(60_000);
      if (/Checked for replies (just now|1 min ago)/.test((await line.textContent()) ?? '')) break;
    }
    await expect(line).toContainText(/Checked for replies (just now|1 min ago)/);
    await expect(page.getByTestId('chat-card-completed').filter({ hasText: name })).toHaveCount(1);

    // the thank-you is in Drafts, and Drafts shows the same line
    await openDrafts(page);
    await expect(page.getByTestId('replies-checked')).toContainText(/Checked for replies/);
    await expect(page.getByTestId('suggestion-thank_you').filter({ hasText: name }).first()).toBeVisible();
  });
});
