import { buildDemoDataset, isWeekend, type User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';

// A Tuesday afternoon: the showcase chat happened this morning and the next one is tomorrow.
const NOW = new Date('2026-10-06T14:00:00');

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 60_000);

const pending = () =>
  db.suggestions
    .where('userId')
    .equals(user.id)
    .filter((s) => s.status === 'pending')
    .toArray();

describe('loaded demo', () => {
  it('derives every seeded relationship stage from the replayed mail, calendar and notes', async () => {
    const ds = buildDemoDataset({ now: NOW });
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    for (const seed of ds.chats) {
      const got = chats.find((c) => c.personId === seed.personId);
      const name = ds.people.find((p) => p.id === seed.personId)?.displayName;
      expect(got?.stage, name).toBe(seed.stage);
    }
    const stages = new Set(chats.map((c) => c.stage));
    for (const s of ['nurturing', 'declined', 'scheduling', 'scheduled', 'completed'])
      expect(stages).toContain(s);
    // stage timestamps come from the evidence, not from the moment the demo was loaded
    for (const c of chats.filter((x) => ['nurturing', 'declined'].includes(x.stage)))
      expect(new Date(c.stageEnteredAt).getTime()).toBeLessThan(NOW.getTime() - 86_400_000);
    // the recruiter's process email does not become a coffee chat
    const recruiter = ds.people.find((p) => p.relationshipType === 'recruiter' && p.primaryEmail)!;
    expect(chats.some((c) => c.personId === recruiter.id)).toBe(false);
  });

  it('thanks the person met today, not the mentor who was thanked seven weeks ago', async () => {
    const sugg = await pending();
    const thanks = sugg.filter((s) => s.kind === 'thank_you');
    expect(thanks).toHaveLength(1);
    const chat = (await db.chats.get(thanks[0]!.chatId!))!;
    expect(chat.stage).toBe('completed');
    const mentor = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.relationshipType === 'mentor',
    )!;
    expect(sugg.some((s) => s.personId === mentor.id && s.kind === 'thank_you')).toBe(false);
    expect((await db.chats.where('personId').equals(mentor.id).first())?.stage).toBe('nurturing');
  });

  it("drafts the thank-you from the meeting note's facts (the note is in before any draft is written)", async () => {
    const s = (await pending()).find((x) => x.kind === 'thank_you')!;
    const d = (await db.outbound.get(s.outboundMessageId!))!;
    const facts = await db.facts.where('personId').equals(s.personId!).toArray();
    expect(facts.some((f) => f.type === 'advice' && f.sourceTable === 'notes')).toBe(true);
    expect(d.claims?.length).toBeGreaterThan(0);
    expect((d.claims ?? []).every((c) => !c.factId || facts.some((f) => f.id === c.factId))).toBe(true);
    expect(d.bodyDraft).toMatch(/one concrete project story/);
  });

  it('opens with a brief that exercises the whole season, including a referral ask', async () => {
    const brief = (await db.briefs.where('userId').equals(user.id).toArray())[0]!;
    const sugg = await pending();
    const inBrief = sugg.filter((s) => brief.suggestionIds.includes(s.id));
    const kinds = new Set(inBrief.map((s) => s.kind));
    for (const k of [
      'thank_you',
      'prep_brief',
      'schedule_confirm',
      'schedule_propose',
      'follow_up_bump',
      'warm_up_engage',
    ])
      expect(kinds, k).toContain(k);
    expect(kinds.has('ask_referral') || kinds.has('nurture_checkin')).toBe(true);
    // the fresh decline waits for the student; the old one was confirmed at the time
    expect(sugg.filter((s) => s.kind === 'confirm_stage')).toHaveLength(1);
    // every pending card was computed today, on the final state
    for (const s of sugg) expect(s.createdAt).toBe(NOW.toISOString());
  });

  it('never asks to confirm a time that has passed', async () => {
    for (const s of (await pending()).filter((x) => x.kind === 'schedule_confirm')) {
      const t = s.payload.time as { startIso: string };
      expect(new Date(t.startIso) > NOW).toBe(true);
    }
  });

  it('keeps only notifications that are news today', async () => {
    const notes = await db.notifications.where('userId').equals(user.id).toArray();
    const replied = notes.filter((n) => n.kind === 'reply_received');
    expect(replied.length).toBeGreaterThan(0);
    expect(replied.length).toBeLessThanOrEqual(4);
  });
});

describe('demo loaded on a weekend', () => {
  it('books the next chat on Monday, never on a weekend', { timeout: 60_000 }, async () => {
    const saturday = new Date('2026-10-10T12:00:00');
    const u = await loadDemo({ reset: true, now: saturday });
    const events = await db.events.where('userId').equals(u.id).toArray();
    for (const e of events) expect(isWeekend(new Date(e.startAt))).toBe(false);
    const upcoming = events.filter((e) => new Date(e.startAt) > saturday);
    expect(upcoming).toHaveLength(1);
    expect(new Date(upcoming[0]!.startAt).getDay()).toBe(1);
    const sugg = await db.suggestions
      .where('userId')
      .equals(u.id)
      .filter((s) => s.status === 'pending')
      .toArray();
    expect(sugg.some((s) => s.kind === 'thank_you')).toBe(true);
    expect(sugg.some((s) => s.kind === 'schedule_confirm')).toBe(true);
  });
});
