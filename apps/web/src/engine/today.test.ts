import type { Suggestion, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { moveChat, scheduleChatAt, upcomingMeeting } from './move';
import { runTimedStageRules } from './stages';
import { draftLists, todayCards, todaySummaryText } from './today';

const NOW = new Date('2026-10-06T10:00:00');

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 60_000);

async function screen() {
  const briefs = await db.briefs.where('userId').equals(user.id).toArray();
  const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]!;
  const pending = (await db.suggestions.where('userId').equals(user.id).toArray()).filter(
    (s) => s.status === 'pending',
  );
  const events = await db.events.where('userId').equals(user.id).toArray();
  const people = (await db.people.where('userId').equals(user.id).toArray()).filter((p) => p.isHuman).length;
  return { latest, ...todayCards(pending, latest, NOW), events, people };
}

const count = (cards: Suggestion[], kind: string) => cards.filter((s) => s.kind === kind).length;

describe("Today's summary line (L27)", () => {
  it('counts every card on screen, including stage updates raised after the brief was made', async () => {
    const { cards, events, people } = await screen();
    expect(count(cards, 'confirm_stage')).toBeGreaterThan(0);
    const text = todaySummaryText(cards, events, people, NOW);
    // a short count, not a list of every kind (the cards say what each one is)
    expect(text).toBe(`${cards.length} things for today, most urgent first. 1 chat coming up this week.`);
  });

  it('stops counting a card once it is handled', async () => {
    const { cards, events, people } = await screen();
    expect(count(cards, 'schedule_confirm')).toBe(1);
    expect(todaySummaryText(cards, events, people, NOW)).toMatch(new RegExp(`^${cards.length} things`));
    const left = cards.filter((s) => s.kind !== 'schedule_confirm');
    expect(todaySummaryText(left, events, people, NOW)).toMatch(new RegExp(`^${left.length} things`));
    expect(todaySummaryText([], events, people, NOW)).toMatch(/^Nothing to send today/);
  });

  it('a stored demo never shows a confirm-time card for a chat that is already booked', async () => {
    const { cards } = await screen();
    for (const s of cards.filter((x) => x.kind === 'schedule_confirm')) {
      const chat = await db.chats.get(s.chatId!);
      expect(chat?.stage).not.toBe('scheduled');
    }
  });
});

describe('usability round 2: drafts, hand-offs and chats moved by hand', () => {
  it('the Drafts list counts a draft once: opened in the mail app, it leaves Ready to send', async () => {
    const { latest } = await screen();
    const all = await db.suggestions.where('userId').equals(user.id).toArray();
    const outbound = await db.outbound.where('userId').equals(user.id).toArray();
    const before = draftLists(all, outbound, latest, NOW);
    expect(before.forToday.length).toBeGreaterThan(0);
    // the badge and Today agree: every draft for today is also a card on Today
    const { cards } = todayCards(
      all.filter((s) => s.status === 'pending'),
      latest,
      NOW,
    );
    for (const s of before.forToday) expect(cards.map((c) => c.id)).toContain(s.id);
    const opened = before.forToday.find((s) => s.outboundMessageId)!;
    const after = draftLists(
      all,
      outbound.map((o) => (o.id === opened.outboundMessageId ? { ...o, status: 'handed_off' as const } : o)),
      latest,
      NOW,
    );
    expect(after.forToday.map((s) => s.id)).not.toContain(opened.id);
    expect(after.later.map((s) => s.id)).not.toContain(opened.id);
  });

  it('a time typed for a chat puts it under Upcoming, and it moves to Completed once it has passed', async () => {
    const chat = (await db.chats.where('userId').equals(user.id).toArray()).find(
      (c) => c.stage === 'outreach_sent',
    )!;
    const at = new Date(Date.now() + 2 * 86_400_000);
    const ev = await scheduleChatAt(user, chat, at, 30);
    const fresh = (await db.chats.get(chat.id))!;
    expect(fresh.stage).toBe('scheduled');
    expect(fresh.scheduledEventId).toBe(ev.id);
    expect(ev.isCoffeeChat).toBe(true);
    expect((await upcomingMeeting(fresh))?.id).toBe(ev.id);
    await runTimedStageRules(user.id, 2, new Date(at.getTime() + 2 * 3_600_000));
    expect((await db.chats.get(chat.id))!.stage).toBe('completed');
  });

  it('a chat moved to Completed by hand gets its thank-you card at once', async () => {
    const chat = (await db.chats.where('userId').equals(user.id).toArray()).find(
      (c) => c.stage === 'replied' || c.stage === 'scheduling',
    )!;
    await moveChat(user, chat, 'completed', 'user:drag');
    const thanks = await db.suggestions
      .where('chatId')
      .equals(chat.id)
      .filter((s) => s.kind === 'thank_you' && s.status === 'pending')
      .count();
    expect(thanks).toBe(1);
  });
});
