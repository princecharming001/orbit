import type { OutboundMessage, Person, User } from '@orbit/core';
import { newId, SEND_CAPS } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { laterTime } from '../components/approve';
import { db } from '../db/schema';
import {
  applyTemplate,
  batchName,
  batchProgress,
  createBatch,
  draftForBatch,
  planForBatch,
  recipientState,
  scheduleBatch,
  stateWords,
  takenSends,
} from './batch';
import { studentDay } from './batchTime';
import { callsList, callsMonth, callsWeek, monthStart, outreachFunnel, weekStart } from './callsWeek';
import { loadDemo } from './demo';
import { funnelWords, saveFunnel, setAutoReplies } from './funnels';
import { cancelSend, isScheduled, moveToNextDay, queueDays, sendNow } from './queue';
import { approveAndSend, checkSendAllowed, sendDueQueued } from './send';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

const emailed = async (n: number) =>
  (await db.people.where('userId').equals(user.id).toArray())
    .filter((p) => !!p.primaryEmail && !p.hiddenAt && !p.doNotContact && p.isHuman !== false)
    .slice(0, n);

async function freshDraft(
  p: Person,
  body = `Hi ${p.firstName}, a question about your team.`,
): Promise<OutboundMessage> {
  const d: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId: p.id,
    channel: 'gmail',
    kind: 'outreach',
    toEmail: p.primaryEmail,
    subject: 'A question',
    bodyDraft: body,
    status: 'draft',
    generatedBy: 'template',
    createdAt: new Date().toISOString(),
  };
  await db.outbound.add(d);
  return d;
}

describe('who can go (plan 38 §B1)', () => {
  it('someone with an address is ready; without one, set aside with the reason', async () => {
    const [p] = await emailed(1);
    expect((await recipientState(user, p!)).state).toMatch(/ready|wait/);
    const none = { ...p!, id: newId('p'), primaryEmail: undefined, emails: [] } as Person;
    await db.people.add(none);
    expect(await recipientState(user, none)).toEqual({ state: 'no_email' });
    expect(stateWords({ state: 'no_email' }, 'Sam')).toBe('No email address');
    expect(stateWords({ state: 'do_not_contact' }, 'Sam')).toBe('Sam asked not to be contacted');
  });
  it('a batch of recruiters is named for them', () => {
    const day = new Date('2026-11-12T12:00:00Z');
    expect(batchName([{ currentTitle: 'University Recruiter', relationshipType: 'unknown' }], day)).toMatch(
      /^Recruiters, Nov 1[12]$/,
    );
    expect(batchName([{ currentTitle: 'Engineer', relationshipType: 'unknown' }], day)).toMatch(
      /^1 person, /,
    );
  });
});

describe('the words (plan 38 §B2)', () => {
  it("the student's own message, filled in per person, and a gap left when a field is unknown", async () => {
    const [p] = await emailed(1);
    const d = await freshDraft(p!);
    const r = await applyTemplate(
      user,
      d,
      { ...p!, currentOrganizationRaw: undefined },
      {
        subject: 'Hello from {school}',
        body: 'Hi {first}, I would love to hear about {company}.',
      },
    );
    expect(r.missing).toEqual(['company']);
    const after = await db.outbound.get(d.id);
    expect(after!.bodyFinal ?? after!.bodyDraft).toBe(
      `Hi ${p!.firstName}, I would love to hear about {company}.`,
    );
    expect(after!.subject).toBe(`Hello from ${user.school}`);
  });
  it('a draft for someone in a batch is reopened, never written twice', async () => {
    const [, p] = await emailed(2);
    const a = await draftForBatch(user, p!.id);
    const b = await draftForBatch(user, p!.id);
    if (a.draft && b.draft) expect(b.draft.id).toBe(a.draft.id);
  });
});

describe('the plan and the send (plan 38 §B3, §B5)', () => {
  it('counts what is already scheduled, then schedules each at its time, with nothing on a day over the limit', async () => {
    const people = await emailed(20);
    const drafts: OutboundMessage[] = [];
    for (const p of people.slice(3, 15)) drafts.push(await freshDraft(p));
    const now = new Date();
    const plan = await planForBatch(user, drafts, 'faster', { now });
    expect(plan).toHaveLength(drafts.length);
    const b = await createBatch(
      user,
      drafts.map((d) => d.personId),
      { draftIds: drafts.map((d) => d.id) },
    );
    const out = await scheduleBatch(user, b.id, plan, now);
    const ok = out.filter((o) => o.ok);
    // the demo sends like an account: every one of them is queued for its own time
    expect(ok.length).toBe(drafts.length);
    const rows = (await db.outbound.bulkGet(drafts.map((d) => d.id))) as OutboundMessage[];
    for (const r of rows) expect(isScheduled(r)).toBe(true);
    const days = queueDays(rows);
    const cap = Math.min((await db.settings.get(user.id))?.dailySendCapGmail ?? 99, SEND_CAPS.gmailPerDay);
    for (const d of days) expect(d.rows.length).toBeLessThanOrEqual(cap);
    // the batch knows where it stands
    const progress = await batchProgress((await db.batches.get(b.id))!);
    expect(progress.scheduled).toBe(drafts.length);
    expect(progress.sent).toBe(0);
    // a second plan counts these as taken
    const taken = await takenSends(user.id, new Set(), now);
    expect(taken.length).toBeGreaterThanOrEqual(drafts.length);
  });

  it('Send now, Move to the next day and Cancel, on a queued email', async () => {
    const [p] = (await emailed(25)).slice(20);
    const d = await freshDraft(p!);
    const now = new Date();
    const [slot] = await planForBatch(user, [d], 'steady', { now });
    await scheduleBatch(user, (await createBatch(user, [p!.id], { draftIds: [d.id] })).id, [slot!], now);
    const queued = (await db.outbound.get(d.id))!;
    const before = studentDay(new Date(queued.sendAt!));
    const moved = await moveToNextDay(user, queued);
    expect(moved).toBeDefined();
    expect(studentDay(moved!) > before).toBe(true);
    const later = (await db.outbound.get(d.id))!;
    expect(await sendNow(user, later)).toBe(true);
    expect(Date.parse((await db.outbound.get(d.id))!.sendAt!) - Date.now()).toBeLessThan(10_000);
    expect(await cancelSend(user, (await db.outbound.get(d.id))!)).toBe(true);
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
  });

  it('a planned batch keeps its own spacing when it sends: no re-timing into autopilot’s gap', async () => {
    const people = (await emailed(30)).slice(25, 27);
    const drafts: OutboundMessage[] = [];
    for (const p of people) drafts.push(await freshDraft(p));
    const now = new Date();
    const at = new Date(now.getTime() - 60_000);
    for (const d of drafts) {
      const r = await approveAndSend(user, d.id, d.bodyDraft, d.subject, now, { scheduleAt: at });
      expect(r.ok).toBe(true);
    }
    // both are due; neither is autopilot's own (autoSent), so both go now rather than one being pushed back
    const sent = await sendDueQueued(user, new Date(now.getTime() + 1000));
    expect(sent.filter((s) => drafts.some((d) => d.id === s.id) && s.ok)).toHaveLength(2);
  });
});

describe('a limit is a later time (plan 38 §D)', () => {
  it('the day count holds to the day a message goes, and a refusal says so with a code', async () => {
    const [p] = await emailed(1);
    const settings = await db.settings.get(user.id);
    await db.settings.update(user.id, { dailySendCapGmail: 1 });
    // a quiet day well ahead, and one email queued for the day after it
    const day = new Date();
    day.setDate(day.getDate() + 60);
    day.setHours(9, 0, 0, 0);
    const next = new Date(day.getTime() + 86_400_000);
    const other = await freshDraft(p!);
    await db.outbound.update(other.id, {
      status: 'queued',
      autopilot: true,
      sendAt: next.toISOString(),
      queuedAt: next.toISOString(),
    });
    const d = await freshDraft(p!);
    // the email the day after does not count against this day (it used to: every later day counted)
    const free = await checkSendAllowed(user.id, p!.id, 'gmail', 'thank_you', day, {
      excludeMessageId: d.id,
    });
    expect(free.code).not.toBe('daily_cap');
    // on its own day it does, and the refusal carries the code that offers a later time
    const full = await checkSendAllowed(user.id, p!.id, 'gmail', 'thank_you', next, {
      excludeMessageId: d.id,
    });
    expect(full).toMatchObject({ allowed: false, code: 'daily_cap' });
    await db.outbound.delete(other.id);
    await db.settings.update(user.id, { dailySendCapGmail: settings?.dailySendCapGmail });
  });
  it('the next time after a full day is the next working morning, after a wait its end', async () => {
    const [p] = await emailed(1);
    const d = await freshDraft(p!);
    const now = new Date('2026-11-10T20:00:00Z');
    const t = await laterTime(user, d, undefined, now);
    expect(t!.getTime()).toBeGreaterThan(now.getTime());
    const after = await laterTime(user, d, '2026-11-13T15:00:00Z', now);
    expect(after!.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-13T15:00:00Z'));
  });
});

describe('a group’s funnel and the reply switch (plan 38 §E, §G)', () => {
  it('a follow-up and an interested reply to someone in the group get the group’s words', async () => {
    const [p] = await emailed(1);
    await db.settings.update(user.id, { schedulingLink: 'https://cal.com/alex/15' });
    await saveFunnel(user.id, {
      id: 'g-test',
      name: 'Recruiters',
      personIds: [p!.id],
      interested: 'link',
      followUp: 'Hi {first}, bumping this in case it got buried.',
      createdAt: new Date().toISOString(),
    });
    expect(await funnelWords(user, p!, 'bump')).toBe(
      `Hi ${p!.firstName}, bumping this in case it got buried.\n\nBest,\n${user.firstName}`,
    );
    const reply = await funnelWords(user, p!, 'reply', 'interested');
    expect(reply).toContain('https://cal.com/alex/15');
    expect(await funnelWords(user, p!, 'reply', 'question')).toBeUndefined();
  });
  it('the switch hands over scheduling replies and thank-yous here, and takes them back', async () => {
    await setAutoReplies(user.id, true);
    let s = await db.settings.get(user.id);
    expect(s!.autoReplies).toBe(true);
    expect(s!.autoKinds).toEqual(expect.arrayContaining(['schedule', 'thank_you']));
    await setAutoReplies(user.id, false);
    s = await db.settings.get(user.id);
    expect(s!.autoReplies).toBe(false);
    expect(s!.autoKinds ?? []).not.toContain('schedule');
  });
});

describe('the calls (plan 38 §F)', () => {
  it('the week runs Monday to Sunday, and the demo’s calls fall on their days', async () => {
    const start = weekStart(new Date());
    expect(start.getDay()).toBe(1);
    const w = await callsWeek(user.id, start);
    expect(w.days).toHaveLength(7);
    expect(w.total).toBe(w.days.reduce((n, d) => n + d.calls.length, 0));
    const f = await outreachFunnel(user.id);
    expect(f.replied).toBeLessThanOrEqual(f.wrote);
    expect(f.booked).toBeLessThanOrEqual(f.replied);
  });
  it('a month is whole weeks from Monday holding every day of it; the list splits coming from past', async () => {
    const now = new Date();
    const m = await callsMonth(user.id, monthStart(now));
    expect(m.days.length).toBe(m.weeks * 7);
    expect(m.days[0]!.date.getDay()).toBe(1);
    const own = m.days.filter((d) => d.date.getMonth() === now.getMonth());
    expect(own.length).toBe(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    // the week's calls are the month's calls on those days
    const w = await callsWeek(user.id, weekStart(now));
    for (const d of w.days) {
      const same = m.days.find((x) => x.date.getTime() === d.date.getTime());
      if (same) expect(same.calls.map((c) => c.id)).toEqual(d.calls.map((c) => c.id));
    }
    const l = await callsList(user.id, now);
    for (const c of l.upcoming) expect(Date.parse(c.endAt)).toBeGreaterThanOrEqual(now.getTime());
    for (const c of l.past) expect(Date.parse(c.endAt)).toBeLessThan(now.getTime());
    // upcoming soonest first, past latest first
    expect(l.upcoming.map((c) => c.startAt)).toEqual([...l.upcoming.map((c) => c.startAt)].sort());
    expect(l.past.map((c) => c.startAt)).toEqual([...l.past.map((c) => c.startAt)].sort().reverse());
  });
});
