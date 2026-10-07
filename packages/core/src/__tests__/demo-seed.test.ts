import { describe, expect, it } from 'vitest';
import {
  buildDemoDataset,
  businessDay,
  DEMO_ORGS,
  type DemoDataset,
  demoRolesFor,
  inWinterBreak,
  isWeekend,
} from '../demo/seed';
import { extractProposedTimes, heuristicSignal, heuristicTriage } from '../email/triage';
import { isAutomatedSender } from '../text/email';

// A Tuesday morning, a Friday evening, a Saturday, a Monday before work, around the winter break, and in spring.
const NOWS = [
  '2026-10-06T10:00:00',
  '2026-10-09T17:30:00',
  '2026-10-10T12:00:00',
  '2026-10-12T08:00:00',
  '2026-12-16T11:00:00',
  '2027-01-06T09:30:00',
  '2027-03-03T15:00:00',
].map((s) => new Date(s));

const yearOf = (ymd?: string) => Number((ymd ?? '').slice(0, 4));

function check(now: Date, ds: DemoDataset) {
  const people = new Map(ds.people.map((p) => [p.id, p]));
  // people: unique names, firm-style addresses without numbers
  const names = ds.people.map((p) => p.displayName);
  expect(new Set(names).size).toBe(names.length);
  for (const p of ds.people) {
    if (!p.primaryEmail) continue;
    const [local, domain] = p.primaryEmail.split('@');
    expect(local, p.primaryEmail).not.toMatch(/\d/);
    const org = DEMO_ORGS.find((o) => `org_${o.slug}` === p.currentOrganizationId)!;
    expect(domain).toBe(org.domain);
  }
  // careers: titles from the firm's own ladder, gated by seniority; no job before graduation
  for (const p of ds.people) {
    const affs = ds.affiliations.filter((a) => a.personId === p.id);
    const edu = affs.find((a) => a.kind === 'education')!;
    const grad = yearOf(edu.endDate);
    const years = now.getFullYear() - grad;
    const slug = p.currentOrganizationId!.replace(/^org_/, '');
    const role = demoRolesFor(slug).find((r) => r.title === p.currentTitle);
    expect(role, `${p.currentTitle} at ${p.currentOrganizationRaw}`).toBeDefined();
    expect(years, `${p.displayName}: ${p.currentTitle} ${years}y out`).toBeGreaterThanOrEqual(role!.min);
    if (role!.max !== undefined)
      expect(years, `${p.displayName}: ${p.currentTitle}`).toBeLessThanOrEqual(role!.max);
    for (const job of affs.filter((a) => a.kind === 'employment')) {
      expect(
        job.startDate! >= edu.endDate!,
        `${p.displayName} started ${job.startDate} before ${edu.endDate}`,
      ).toBe(true);
      const jobSlug = job.organizationId!.replace(/^org_/, '');
      const r = demoRolesFor(jobSlug).find((x) => x.title === job.title);
      expect(r, `${job.title} at ${job.nameRaw}`).toBeDefined();
      // every title, past or present, was earned: nobody starts as Staff Engineer the month after graduating
      const held = `${p.displayName}: ${job.title} at ${job.nameRaw} from ${job.startDate}, graduated ${grad}`;
      expect(yearOf(job.startDate) - grad, held).toBeGreaterThanOrEqual(r!.min);
      if (r!.max !== undefined)
        expect((job.endDate ? yearOf(job.endDate) : now.getFullYear()) - grad, held).toBeLessThanOrEqual(
          r!.max,
        );
    }
    const jobs = affs
      .filter((a) => a.kind === 'employment')
      .sort((a, b) => a.startDate!.localeCompare(b.startDate!));
    const cur = jobs[jobs.length - 1]!;
    expect(cur.isCurrent, p.displayName).toBe(true);
    for (let i = 1; i < jobs.length; i++)
      expect(jobs[i - 1]!.endDate! < jobs[i]!.startDate!, p.displayName).toBe(true);
    expect(new Date(cur.startDate!) < now).toBe(true);
  }
  // mail: weekdays only, nothing in the future, turns in order, no placeholders or banned copy
  const byThread = new Map<string, typeof ds.messages>();
  for (const m of ds.messages) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  for (const m of ds.messages) {
    const at = new Date(m.sentAt);
    expect(isWeekend(at), `${m.subject} sent on a weekend`).toBe(false);
    expect(at <= now).toBe(true);
    expect(m.bodyText).not.toMatch(
      /\.\.\.|…|—|–|!|reach out|pick your brain|hope this (email |message )?finds|passionate/i,
    );
    expect(m.bodyText.trim().length).toBeGreaterThan(40);
  }
  for (const [, msgs] of byThread)
    for (let i = 1; i < msgs.length; i++) expect(msgs[i]!.sentAt > msgs[i - 1]!.sentAt).toBe(true);
  // each first message we wrote names the person's firm, so it could only have gone to them
  for (const th of ds.threads) {
    const first = byThread.get(th.id)![0]!;
    if (th.participantPersonIds.length !== 1 || first.direction !== 'outbound') continue;
    const p = people.get(th.participantPersonIds[0]!)!;
    expect(first.bodyText, p.displayName).toContain(p.currentOrganizationRaw!.split(' ')[0]!);
    expect(first.bodyText).toContain(`Hi ${p.firstName},`);
  }
  // no two people get the same outreach or the same thank-you (names aside)
  const written = ds.threads
    .filter((t) => t.participantPersonIds.length === 1)
    .flatMap((t) =>
      byThread
        .get(t.id)!
        .filter((m, i) => m.direction === 'outbound' && (i === 0 || m.signal === 'thank_you')),
    )
    .map((m) => {
      const p = people.get(ds.threads.find((t) => t.id === m.threadId)!.participantPersonIds[0]!)!;
      return m.bodyText.split(p.firstName).join('{first}').split(p.currentOrganizationRaw!).join('{org}');
    });
  expect(new Set(written).size).toBe(written.length);
  // and no two conversations share a subject or a sentence: people answer in their own words, and the student does
  // not paste the same lines from thread to thread
  const subjects = ds.threads.map((t) => t.subject);
  expect(subjects.filter((x, i) => subjects.indexOf(x) !== i)).toEqual([]);
  const seenIn = new Map<string, string>();
  for (const m of ds.messages)
    for (const sentence of m.bodyText.split(/(?<=[.?:])\s+|\n+/)) {
      const x = sentence.trim();
      if (x.split(/\s+/).length < 3) continue;
      const other = seenIn.get(x);
      expect(other === undefined || other === m.threadId, `"${x}" in two threads`).toBe(true);
      seenIn.set(x, m.threadId);
    }
  // the pipeline's own heuristics read each message the way the seed says it should
  for (const m of ds.messages) {
    if (!m.signal || m.isAutomated) continue;
    const h = heuristicSignal(m.bodyText, m.direction, new Date(m.sentAt));
    expect(h.signal, `${m.subject}: ${m.bodyText.slice(0, 80)}`).toBe(m.signal);
    // a proposed time is in the student's own clock: no zone the pipeline would have to convert (Omar once wrote
    // "2pm ET" and the demo confirmed 2pm wherever the browser was)
    if (m.extraction?.proposedTimes.length) expect(m.bodyText).not.toMatch(/\b([ECMP][SD]?T|UTC|GMT)\b/);
    for (const t of m.extraction?.proposedTimes ?? []) {
      const parsed = extractProposedTimes(m.bodyText, new Date(m.sentAt));
      expect(parsed[0]?.startIso, m.bodyText).toBe(t.startIso);
    }
  }
  for (const m of ds.messages.filter((x) => x.isAutomated))
    expect(isAutomatedSender(m.fromEmail, m.headers)).toBe(true);
  // calendar: weekdays, inside working hours, and only one meeting ahead
  for (const e of ds.events) {
    const s = new Date(e.startAt);
    expect(isWeekend(s)).toBe(false);
    // earlier conversations stay out of the winter break (this week's follow whenever the demo is loaded)
    if (now.getTime() - s.getTime() > 10 * 86_400_000)
      expect(inWinterBreak(s), `coffee chat over the winter break: ${s.toDateString()}`).toBe(false);
    expect(s.getHours()).toBeGreaterThanOrEqual(9);
    expect(s.getHours()).toBeLessThan(18);
  }
  for (const c of ds.calendarChanges) expect(isWeekend(new Date(c.startAt))).toBe(false);
  expect(ds.events.filter((e) => new Date(e.startAt) > now)).toHaveLength(1);
  // warm-up steps are due on business days
  const warm = ds.chats.find((c) => c.stage === 'warming')!;
  for (const a of warm.warmUp!.actions) expect(isWeekend(new Date(a.dueAt))).toBe(false);
  expect(new Date(warm.warmUp!.readyAt) > now).toBe(true);
  // the chat that wants a thank-you happened in the last three days; the proposed slot is still ahead
  // (unless a holiday leaves no business day in those three days, when it is the last business day's chat)
  const done = ds.chats.find((c) => c.stage === 'completed')!;
  const lastBusinessDay = businessDay(now, -1, 0);
  expect(new Date(done.completedAt!) > lastBusinessDay).toBe(true);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (midnight.getTime() - lastBusinessDay.getTime() <= 3 * 86_400_000 + 3_600_000)
    expect(now.getTime() - new Date(done.completedAt!).getTime()).toBeLessThan(3 * 86_400_000);
  const scheduling = ds.chats.find((c) => c.stage === 'scheduling')!;
  const proposal = ds.messages.filter((m) => m.threadId === scheduling.threadId).pop()!;
  expect(new Date(proposal.extraction!.proposedTimes[0]!.startIso) > now).toBe(true);
}

describe('demo seed', () => {
  for (const now of NOWS)
    it(`is a plausible season when loaded on ${now.toDateString()} ${now.getHours()}:00`, () => {
      check(now, buildDemoDataset({ now }));
    });

  it('stays plausible whatever day of the year it is loaded', { timeout: 120_000 }, () => {
    const start = new Date('2026-10-01T00:00:00');
    for (let i = 0; i < 366; i++) {
      const now = new Date(start);
      now.setDate(start.getDate() + i);
      now.setHours(7 + (i % 14), (i * 17) % 60);
      try {
        check(now, buildDemoDataset({ now }));
      } catch (e) {
        throw new Error(`loaded on ${now.toString()}: ${(e as Error).message}`);
      }
    }
  });

  it('is deterministic', () => {
    const a = buildDemoDataset({ now: NOWS[0] });
    const b = buildDemoDataset({ now: NOWS[0] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('covers a whole season of threads', () => {
    const ds = buildDemoDataset({ now: NOWS[0] });
    expect(ds.threads.length).toBeGreaterThanOrEqual(14);
    const signals = new Set(ds.messages.map((m) => m.signal));
    for (const s of [
      'reply_positive',
      'scheduling_proposal',
      'scheduling_confirmation',
      'thank_you',
      'reply_decline',
      'out_of_office',
      'intro_offer',
    ])
      expect(signals, s).toContain(s);
    // a reschedule: an invite that moved
    const moved = new Set(
      ds.calendarChanges.map((c) => c.externalEventId).filter((id, i, all) => all.indexOf(id) !== i),
    );
    expect(moved.size).toBeGreaterThan(0);
    // a recruiter's process email that the triage keeps out of networking
    const recruiter = ds.people.find(
      (p) =>
        p.relationshipType === 'recruiter' && ds.threads.some((t) => t.participantPersonIds.includes(p.id)),
    )!;
    const th = ds.threads.find((t) => t.participantPersonIds.includes(recruiter.id))!;
    const msgs = ds.messages.filter((m) => m.threadId === th.id);
    const tri = heuristicTriage({
      subject: th.subject,
      messages: msgs.map((m) => ({
        fromEmail: m.fromEmail,
        direction: m.direction,
        body: m.bodyText,
        isAutomated: m.isAutomated,
      })),
      userEmails: [ds.user.email],
    });
    expect(tri.isNetworking).toBe(false);
    // a nurtured mentor, a referral offer on a target firm that is closing soon, and a confirmed decline
    const stages = new Set(ds.chats.map((c) => c.stage));
    for (const s of [
      'outreach_sent',
      'replied',
      'scheduling',
      'scheduled',
      'completed',
      'nurturing',
      'declined',
      'warming',
    ])
      expect(stages, s).toContain(s);
    expect(ds.people.some((p) => p.relationshipType === 'mentor')).toBe(true);
    expect(ds.notes.some((n) => /offered to refer/i.test(n.rawText))).toBe(true);
  });
});
