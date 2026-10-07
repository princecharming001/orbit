// The demo must be true whatever the time of day it is loaded: these tests pin the clock to just after midnight UTC,
// when the old seed put the prep chat 35 hours out and every chat looked like it entered its stage at load time.
import type { User } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';

const LOAD = new Date('2026-10-07T00:40:00Z');
let user: User;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LOAD);
  user = await loadDemo({ reset: true });
}, 60_000);
afterAll(() => {
  vi.useRealTimers();
});

describe('demo loaded at 00:40', () => {
  it('still offers prep for the scheduled chat', async () => {
    const kinds = (await db.suggestions.where('userId').equals(user.id).toArray())
      .filter((s) => s.status === 'pending')
      .map((s) => s.kind);
    expect(kinds).toContain('prep_brief');
  });

  it('enters each stage when the evidence happened, not when the demo was loaded', async () => {
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const atLoad = chats.filter((c) => c.stageEnteredAt === LOAD.toISOString());
    expect(atLoad.map((c) => c.stage)).toEqual([]);
    const entered = new Set(chats.map((c) => c.stageEnteredAt.slice(0, 10)));
    expect(entered.size).toBeGreaterThan(3);
    for (const c of chats) expect(new Date(c.stageEnteredAt).getTime()).toBeLessThanOrEqual(LOAD.getTime());
  });

  it('dates the completed chat at the meeting, so the thank-you does not say "just now"', async () => {
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const done = chats.find((c) => c.stage === 'completed')!;
    const ev = await db.events.get(done.scheduledEventId!);
    expect(done.completedAt).toBe(ev!.endAt);
    const thanks = (await db.suggestions.where('userId').equals(user.id).toArray()).find(
      (s) => s.kind === 'thank_you',
    );
    expect(thanks?.reasonText).not.toMatch(/just now/);
  });
});
