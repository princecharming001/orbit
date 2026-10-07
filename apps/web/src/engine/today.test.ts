import type { Suggestion, User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { todayCards, todaySummaryText } from './today';

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
    const confirms = count(cards, 'schedule_confirm');
    expect(text).toContain(`${confirms} time${confirms > 1 ? 's' : ''} to confirm`);
    const updates = count(cards, 'confirm_stage');
    expect(text).toContain(`${updates} update${updates > 1 ? 's' : ''} to confirm`);
    expect(text).toContain('1 chat coming up this week');
  });

  it('stops counting a card once it is handled', async () => {
    const { cards, events, people } = await screen();
    expect(count(cards, 'schedule_confirm')).toBe(1);
    expect(todaySummaryText(cards, events, people, NOW)).toMatch(/1 time to confirm/);
    const left = cards.filter((s) => s.kind !== 'schedule_confirm');
    expect(todaySummaryText(left, events, people, NOW)).not.toMatch(/times? to confirm/);
  });

  it('a stored demo never shows a confirm-time card for a chat that is already booked', async () => {
    const { cards } = await screen();
    for (const s of cards.filter((x) => x.kind === 'schedule_confirm')) {
      const chat = await db.chats.get(s.chatId!);
      expect(chat?.stage).not.toBe('scheduled');
    }
  });
});
