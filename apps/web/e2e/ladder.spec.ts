import { expect, test } from '@playwright/test';
import { loadDemo, openDrafts } from './helpers';

type Row = Record<string, unknown> & { id: string };
type Table = {
  toArray(): Promise<Row[]>;
  put(r: unknown): Promise<unknown>;
  update(id: string, c: Record<string, unknown>): Promise<number>;
  delete(id: string): Promise<void>;
};
type Db = {
  __orbitDb: Record<
    'users' | 'people' | 'outbound' | 'feedback' | 'suggestions' | 'chats' | 'settings',
    Table
  >;
};

/** Plan 23 §4.9: the trust ladder, earned by ten untouched approvals, with a minute to undo what Orbit sends. */
test.describe('the trust ladder', () => {
  test('ten untouched bumps earn the offer; yes sends the next bump on its own with Undo; Settings shows the ladder', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await loadDemo(page);
    // ten bumps the student approved without changing a word
    await page.evaluate(async () => {
      const db = (window as unknown as Db).__orbitDb;
      const user = (await db.users.toArray())[0]!;
      const someone = (await db.people.toArray()).find((p) => p.isHuman)!;
      for (let i = 0; i < 10; i++) {
        const at = new Date(Date.now() - (30 - i) * 86_400_000).toISOString();
        await db.outbound.put({
          id: `e2e_bump_${i}`,
          userId: user.id,
          personId: someone.id,
          channel: 'gmail',
          kind: 'bump',
          bodyDraft: 'x',
          status: 'sent',
          sentAt: at,
          generatedBy: 'template',
          createdAt: at,
        });
        await db.feedback.put({
          id: `e2e_fb_${i}`,
          userId: user.id,
          kind: 'approve',
          outboundMessageId: `e2e_bump_${i}`,
          createdAt: at,
        });
      }
    });
    await page.reload();
    await openDrafts(page);
    const offer = page.getByTestId('suggestion-trust_offer');
    await expect(offer).toBeVisible({ timeout: 20_000 });
    await expect(offer).toContainText("You've approved 10 bumps without changing a word.");
    await offer.getByTestId('trust-offer-yes').click();
    await expect(offer).toHaveCount(0);
    // the app's own work after opening (the demo's LinkedIn sync recomputes every tie score) settles first, so the
    // score set below for the test is not recomputed under it on a slow machine
    await expect(page.getByTestId('activity-line')).toHaveAttribute('data-state', 'idle', {
      timeout: 60_000,
    });
    // a bump card whose draft is written now goes out on its own, in the recipient's morning
    const name = await page.evaluate(async () => {
      const db = (window as unknown as Db).__orbitDb;
      const people = await db.people.toArray();
      const withEmail = new Set(people.filter((p) => !!p.primaryEmail).map((p) => p.id));
      // a card whose draft is a bump (a bump to someone who answered is written as the scheduling reply instead)
      const drafts = new Map((await db.outbound.toArray()).map((o) => [o.id, o]));
      const s = (await db.suggestions.toArray()).find(
        (x) =>
          x.kind === 'follow_up_bump' &&
          x.status === 'pending' &&
          withEmail.has(x.personId as string) &&
          drafts.get(x.outboundMessageId as string)?.kind === 'bump' &&
          drafts.get(x.outboundMessageId as string)?.channel === 'gmail',
      )!;
      if (s.outboundMessageId) await db.outbound.delete(s.outboundMessageId as string);
      await db.suggestions.update(s.id, { outboundMessageId: undefined });
      await db.people.update(s.personId as string, { tieScore: 60, location: 'Chicago, IL' });
      const p = (await db.people.toArray()).find((x) => x.id === s.personId)!;
      return p.firstName as string;
    });
    // no reload: Drafts sees the card without a draft and writes it at once (a reload would also recompute every
    // tie score, and this one was set for the test)
    // the card's draft is written as Drafts opens (or with Draft a message): Orbit sends it on its own instead of waiting
    const sent = page.getByTestId('sent-for-you');
    const draftNow = page
      .getByTestId('suggestion-follow_up_bump')
      .filter({ hasText: name })
      .getByTestId('draft-now');
    // a loaded machine can take a while to draft the card: the wait is generous
    await expect(sent.or(draftNow).first()).toBeVisible({ timeout: 45_000 });
    if (!(await sent.isVisible())) await draftNow.click({ timeout: 3000 }).catch(() => undefined);
    // why a handed-over bump waited, if it did: Orbit keeps its last answer
    const why = () =>
      page.evaluate(async () => {
        const db = (
          window as unknown as {
            __orbitDb: { kv: { toArray(): Promise<{ key: string; value: unknown }[]> } };
          }
        ).__orbitDb;
        return JSON.stringify(
          (await db.kv.toArray()).find((r) => r.key.startsWith('trust:last:'))?.value ?? null,
        );
      });
    await expect(sent, await why())
      .toBeVisible({ timeout: 45_000 })
      .catch(async (e) => {
        throw new Error(`${String(e)}\nlast auto-send answer: ${await why()}`);
      });
    const row = sent.getByTestId('sent-for-you-row').first();
    await expect(row).toContainText(name);
    await expect(row.getByTestId('sent-for-you-when')).toHaveText(/^(Sending in \d+ s|Goes .+ their time)$/);
    // Undo puts it back in the student's hands
    await row.getByTestId('sent-for-you-undo').click();
    await expect(page.getByTestId('toasts')).toContainText('Not sent. The draft is back in Drafts.');
    await expect(sent).toHaveCount(0);
    // Settings shows the ladder as it stands
    await page.goto('settings/limits');
    const ladder = page.getByTestId('settings-ladder');
    await expect(ladder.getByTestId('settings-ladder-row').first()).toContainText('Bumps');
    await expect(ladder.getByTestId('settings-ladder-state').first()).toHaveText('Orbit sends');
    await expect(ladder.getByTestId('settings-ladder-never')).toHaveText(
      'Never on its own: first messages, intro asks, anything on LinkedIn.',
    );
    expect(await ladder.innerText()).not.toMatch(/[–—]/);
  });
});
