import type { OutboundMessage, User } from '@orbit/core';
import { newId, nextSendWindow, SEND_CAPS, WINDOW_END, WINDOW_START } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import {
  cancelScheduled,
  LINKEDIN_WAITS,
  planSchedule,
  planSpread,
  scheduledSends,
  scheduleSends,
} from './autopilot';
import { nextSlotAfter } from './autopilotTime';
import { loadDemo } from './demo';
import { sendDueQueued } from './send';
import { draftLists } from './today';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

const MIN = 60_000;

/** Weekday and minutes past midnight of an instant in a zone. */
function inZone(d: Date, tz: string): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
const windowStart = WINDOW_START.hour * 60 + WINDOW_START.minute;
const windowEnd = WINDOW_END.hour * 60 + WINDOW_END.minute;

describe('autopilot timing (plan 29 §B2.1: one window)', () => {
  it('spreads sends over the recipient’s Tuesday to Thursday mornings, a day at a time, never closer than 25 minutes', () => {
    // a Friday afternoon in New York: everything waits for Tuesday
    const start = new Date('2026-10-09T19:30:00Z');
    const tz = 'America/New_York';
    const times = planSpread({ count: 9, start, perDay: 3, seed: 3, zones: tz });
    expect(times).toHaveLength(9);
    const perDay = new Map<string, number>();
    for (const t of times) {
      const z = inZone(t, tz);
      expect(['Tue', 'Wed', 'Thu']).toContain(z.weekday);
      expect(z.minutes).toBeGreaterThanOrEqual(windowStart);
      expect(z.minutes).toBeLessThanOrEqual(windowEnd);
      const k = t.toDateString();
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(3);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i]!.getTime() - times[i - 1]!.getTime();
      expect(gap).toBeGreaterThanOrEqual(25 * MIN);
    }
    // the first one is never right away
    expect(times[0]!.getTime() - start.getTime()).toBeGreaterThanOrEqual(10 * MIN);
    // and never before the shared window says
    expect(times[0]!.getTime()).toBeGreaterThanOrEqual(
      Date.parse(nextSendWindow(start, tz, 'gmail', () => 0).notBefore),
    );
  });

  it('plans each send in its own recipient’s zone', () => {
    const start = new Date('2026-10-12T12:00:00Z');
    const zones = ['Asia/Tokyo', 'Europe/London', 'America/Los_Angeles'];
    const times = planSpread({ count: 3, start, perDay: 5, seed: 11, zones });
    times.forEach((t, i) => {
      const z = inZone(t, zones[i]!);
      expect(['Tue', 'Wed', 'Thu']).toContain(z.weekday);
      expect(z.minutes).toBeGreaterThanOrEqual(windowStart);
      expect(z.minutes).toBeLessThanOrEqual(windowEnd);
    });
  });

  it('a missed send moves to the next slot inside the window, a gap after the last one', () => {
    const tz = 'America/Chicago';
    // Wednesday 9:00 Chicago, the last one went at 8:50
    const now = new Date('2026-10-14T14:00:00Z');
    const last = new Date('2026-10-14T13:50:00Z');
    const next = nextSlotAfter(last, now, 5, tz);
    expect(next.getTime() - last.getTime()).toBeGreaterThanOrEqual(25 * MIN);
    const z = inZone(next, tz);
    expect(z.weekday).toBe('Wed');
    expect(z.minutes).toBeLessThanOrEqual(windowEnd);
    // after the window closed, the next send day
    const late = new Date('2026-10-14T17:00:00Z');
    expect(inZone(nextSlotAfter(undefined, late, 5, tz), tz).weekday).toBe('Thu');
  });
});

describe('autopilot in the demo', () => {
  it('schedules the day’s email drafts in their windows, sends one at a time with a gap, spreads out what it missed, and can be cancelled', async () => {
    const [suggestions, outbound, briefs] = await Promise.all([
      db.suggestions.where('userId').equals(user.id).toArray(),
      db.outbound.where('userId').equals(user.id).toArray(),
      db.briefs.where('userId').equals(user.id).toArray(),
    ]);
    const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
    const now = new Date();
    const ids = draftLists(suggestions, outbound, latest, now)
      .forToday.map((s) => s.outboundMessageId)
      .filter((x): x is string => !!x);
    const drafts = (await db.outbound.bulkGet(ids))
      .filter((d) => d && d.status === 'draft' && d.channel === 'gmail')
      .slice(0, 3);
    expect(drafts.length).toBeGreaterThan(1);
    const plan = await planSchedule(user, drafts as never, { perDay: 6, now });
    const results = await scheduleSends(user, plan, now);
    const scheduled = results.filter((r) => r.ok);
    expect(scheduled.length).toBeGreaterThan(1);
    const queue = await scheduledSends(user.id);
    expect(queue.map((o) => o.autopilot)).toEqual(queue.map(() => true));
    for (const o of queue) {
      const person = (await db.people.get(o.personId))!;
      const z = inZone(new Date(o.sendAt!), person.timezone ?? user.timezone);
      expect(['Tue', 'Wed', 'Thu']).toContain(z.weekday);
    }

    // Orbit was closed past every time: one goes, the rest move to later slots, never a burst
    const later = new Date(new Date(queue.at(-1)!.sendAt!).getTime() + 5 * MIN);
    const first = await sendDueQueued(user, later);
    expect(first.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const after = await scheduledSends(user.id);
    for (const o of after) expect(new Date(o.sendAt!).getTime()).toBeGreaterThanOrEqual(later.getTime());
    const moved = after.map((o) => new Date(o.sendAt!).getTime());
    for (let i = 1; i < moved.length; i++) expect(moved[i]! - moved[i - 1]!).toBeGreaterThanOrEqual(25 * MIN);

    // a planned send can be taken back: a draft again, untouched
    const one = after[0]!;
    expect(await cancelScheduled(user.id, one.id)).toBe(true);
    const back = (await db.outbound.get(one.id))!;
    expect(back.status).toBe('draft');
    expect(back.autopilot).toBeUndefined();
  });

  it('refuses a LinkedIn draft with the one reason: LinkedIn always waits for a tap', async () => {
    const person = (await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !!p.linkedinUrl)
      .first())!;
    const li: OutboundMessage = {
      id: newId('out'),
      userId: user.id,
      personId: person.id,
      channel: 'linkedin',
      kind: 'outreach',
      toLinkedinUrl: person.linkedinUrl,
      bodyDraft: `Hi ${person.firstName}, I would love to hear how you got into your work.`,
      status: 'draft',
      generatedBy: 'template',
      createdAt: new Date().toISOString(),
    };
    await db.outbound.add(li);
    const plan = await planSchedule(user, [li], { now: new Date() });
    const [r] = await scheduleSends(user, plan, new Date());
    expect(r).toEqual({ id: li.id, ok: false, error: LINKEDIN_WAITS });
    expect((await db.outbound.get(li.id))!.status).toBe('draft');
  });

  it('the review window and the pause hold a queued send where it is; afterwards it goes, on the record', async () => {
    // nothing else Orbit sent on its own in the way: the gap rule reads the last autopilot send
    const sentAuto = await db.outbound
      .where('status')
      .equals('sent')
      .filter((o) => o.userId === user.id && !!o.autopilot && !!o.sentAt)
      .toArray();
    const lastAuto = Math.max(0, ...sentAuto.map((o) => Date.parse(o.sentAt!)));
    const now = new Date(Math.max(Date.now(), lastAuto + 60 * MIN));
    const recent = new Set(
      (
        await db.outbound
          .where('userId')
          .equals(user.id)
          .filter((o) => ['sent', 'queued', 'sending', 'handed_off'].includes(o.status))
          .toArray()
      ).map((o) => o.personId),
    );
    const draft = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.channel === 'gmail' && o.status === 'draft' && !!o.toEmail && !recent.has(o.personId))
      .first();
    expect(draft).toBeTruthy();
    const [r] = await scheduleSends(
      user,
      [{ id: draft!.id, personId: draft!.personId, at: new Date(now.getTime() + 60 * MIN) }],
      now,
    );
    expect(r!.ok).toBe(true);
    // its time came a minute ago, but the evening review is not over
    const due = new Date(now.getTime() + 61 * MIN);
    const review = new Date(now.getTime() + 8 * 60 * MIN).toISOString();
    await db.outbound.update(draft!.id, { reviewUntil: review, autoSent: true, autoRung: draft!.kind });
    await sendDueQueued(user, due);
    let row = (await db.outbound.get(draft!.id))!;
    expect(row.status).toBe('queued');
    expect(row.sendAt).toBe(new Date(now.getTime() + 60 * MIN).toISOString());
    // the review is over, but autopilot is paused
    await db.outbound.update(draft!.id, { reviewUntil: new Date(now.getTime() + 60 * MIN).toISOString() });
    await db.settings.update(user.id, {
      autopilotPausedUntil: new Date(now.getTime() + 24 * 60 * MIN).toISOString(),
    });
    await sendDueQueued(user, due);
    row = (await db.outbound.get(draft!.id))!;
    expect(row.status).toBe('queued');
    // the pause is lifted: it goes, and the record says Orbit sent it
    await db.settings.update(user.id, { autopilotPausedUntil: undefined });
    const out = await sendDueQueued(user, due);
    expect(out.find((x) => x.id === draft!.id)?.ok).toBe(true);
    row = (await db.outbound.get(draft!.id))!;
    expect(row.status).toBe('sent');
    const audit = await db.audit
      .where('userId')
      .equals(user.id)
      .filter((a) => a.action === 'message.auto_sent' && a.objectId === draft!.id)
      .toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ rung: draft!.kind });
    const note = await db.notifications
      .where('userId')
      .equals(user.id)
      .filter((n) => n.title === 'Sent for you')
      .last();
    expect(note?.body).toMatch(/Orbit sent .* It is under Sent for you/);
  });

  it('the planner’s day is the student’s own email limit, never above the cap table', async () => {
    await db.settings.update(user.id, { dailySendCapGmail: 2 });
    const drafts = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.channel === 'gmail' && o.status === 'draft')
      .limit(5)
      .toArray();
    expect(drafts.length).toBeGreaterThan(2);
    const plan = await planSchedule(user, drafts, { perDay: 6, now: new Date() });
    const perDay = new Map<string, number>();
    for (const p of plan) perDay.set(p.at.toDateString(), (perDay.get(p.at.toDateString()) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(2);
    await db.settings.update(user.id, { dailySendCapGmail: SEND_CAPS.gmailPerDay });
  });
});
