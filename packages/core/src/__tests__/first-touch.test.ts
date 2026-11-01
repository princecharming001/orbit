import { describe, expect, it } from 'vitest';
import {
  AUTO_FIRST_TOUCH_KINDS,
  earliestPlannedSend,
  type FirstTouchCandidate,
  type FirstTouchGoal,
  type FirstTouchSkipRule,
  firmKey,
  firstTouchBlock,
  firstTouchGate,
  firstTouchRoute,
  firstTouchRung,
  firstTouchRungLine,
  isFirstTouchKind,
  planFirstTouchDay,
  reviewWindow,
  skipReason,
} from '../safety/firstTouch';
import { AUTO_FIRST_TOUCH_RUNG, REVIEW_WINDOW_HOURS, SEND_CAPS } from '../safety/rules';

const approvals = (n: number, over: Partial<{ kind: string; edited: boolean; auto: boolean }> = {}) =>
  Array.from({ length: n }, () => ({ kind: 'first_touch', edited: false, ...over }));

describe('the first-message rung (plan 29 §B2.2)', () => {
  it('is twenty, with an eight hour evening review and the first-message caps of three a day and twelve a week', () => {
    expect(AUTO_FIRST_TOUCH_RUNG).toBe(20);
    expect(REVIEW_WINDOW_HOURS).toBe(8);
    expect(SEND_CAPS.autoFirstTouchesPerDay).toBe(3);
    expect(SEND_CAPS.autoFirstTouchesPerWeek).toBe(12);
  });

  it('counts the three first-message kinds and nothing else', () => {
    expect([...AUTO_FIRST_TOUCH_KINDS].sort()).toEqual(['first_touch', 'outreach', 'warm_first_touch']);
    for (const k of AUTO_FIRST_TOUCH_KINDS) expect(isFirstTouchKind(k)).toBe(true);
    for (const k of ['bump', 'thank_you', 'reply', 'intro_request', undefined, null])
      expect(isFirstTouchKind(k)).toBe(false);
    const r = firstTouchRung([
      ...approvals(3, { kind: 'outreach' }),
      ...approvals(3, { kind: 'warm_first_touch' }),
      ...approvals(30, { kind: 'bump' }),
    ]);
    expect(r).toEqual({ unchanged: 6, needed: 20, earned: false });
  });

  it('counts approvals without an edit, never an edited one and never one Orbit sent on its own', () => {
    expect(firstTouchRung([...approvals(19), ...approvals(5, { edited: true })]).earned).toBe(false);
    expect(firstTouchRung([...approvals(19), ...approvals(5, { auto: true })]).earned).toBe(false);
    const earned = firstTouchRung([...approvals(19), ...approvals(1, { kind: 'outreach' })]);
    expect(earned).toEqual({ unchanged: 20, needed: 20, earned: true });
    // an edit in between does not start it over
    expect(
      firstTouchRung([...approvals(10), ...approvals(1, { edited: true }), ...approvals(10)]).earned,
    ).toBe(true);
    // past twenty the count shows as twenty
    expect(firstTouchRung(approvals(31)).unchanged).toBe(20);
  });

  it('says where it stands in plain words, with no dash or exclamation mark', () => {
    const before = firstTouchRungLine(firstTouchRung(approvals(14)));
    expect(before).toBe(
      '14 of 20 first messages approved unchanged. Until 6 more go out as Orbit wrote them, each first message in the evening batch waits for your tap.',
    );
    expect(firstTouchRungLine(firstTouchRung(approvals(19)))).toContain(
      'Until one more goes out as Orbit wrote it',
    );
    const after = firstTouchRungLine(firstTouchRung(approvals(20)));
    expect(after).toContain("Tomorrow's batch now goes in the morning unless you hold one");
    for (const t of [before, after]) expect(t).not.toMatch(/[–—!]/);
  });

  it('a queued first message sends once the rung is earned or the student tapped it, and otherwise waits', () => {
    expect(firstTouchGate({ rungEarned: false, tapped: false })).toBe('needs_tap');
    expect(firstTouchGate({ rungEarned: false, tapped: true })).toBe('sends');
    expect(firstTouchGate({ rungEarned: true, tapped: false })).toBe('sends');
  });
});

describe('the evening review window (plan 29 §B2.2)', () => {
  it('holds until the send time and opens eight hours before it', () => {
    const w = reviewWindow('2026-10-07T12:40:00.000Z');
    expect(w).toEqual({
      sendAt: '2026-10-07T12:40:00.000Z',
      reviewUntil: '2026-10-07T12:40:00.000Z',
      reviewOpensAt: '2026-10-07T04:40:00.000Z',
    });
    expect(reviewWindow(new Date('2026-10-07T12:40:00.000Z'))).toEqual(w);
  });

  it('a plan made now sends no sooner than a full review window from now', () => {
    const now = new Date('2026-10-06T14:00:00.000Z');
    expect(earliestPlannedSend(now).toISOString()).toBe('2026-10-06T22:00:00.000Z');
  });
});

describe('who autopilot may write to first (plan 29 §B6)', () => {
  const goal = { kind: 'recruiting' as const, targets: ['Ramp', 'Figma Inc.', 'Linear'] };
  const base = {
    personId: 'p1',
    name: 'Priya Shah',
    company: 'Figma',
    title: 'Product Manager',
    score: 55,
    hasHook: true,
    hasEmail: true,
  };
  const block = (over: Partial<FirstTouchCandidate>, g: FirstTouchGoal = goal) =>
    firstTouchBlock({ ...base, ...over }, g);

  it('lets an alum, someone known at 40 or more, or a friend contact through, at a target company', () => {
    expect(block({})).toBeUndefined();
    expect(block({ score: 10, isAlumni: true })).toBeUndefined();
    expect(block({ company: 'figma' })).toBeUndefined();
    const friend = { userId: 'u2', name: 'Ana Okafor', sharePersonId: 's1' };
    expect(block({ score: 0, hasEmail: false, hasHook: false, viaFriend: friend })).toBeUndefined();
    expect(firstTouchRoute({ ...base, score: 0, viaFriend: friend })).toBe('friend');
    // someone the student knows well goes direct even when a friend knows them too
    expect(firstTouchRoute({ ...base, viaFriend: friend })).toBe('direct');
  });

  it('names the rule for each excluded case', () => {
    const cases: [Partial<FirstTouchCandidate>, string][] = [
      [{ doNotContact: true }, 'do_not_contact'],
      [{ hidden: true }, 'hidden'],
      [{ private: true }, 'private'],
      [{ isMinor: true }, 'minor'],
      [{ headline: 'High school senior at Lincoln High' }, 'minor'],
      [{ written: true }, 'already_written'],
      [{ openChat: true }, 'open_chat'],
      [{ pending: true }, 'pending'],
      [{ title: 'University Recruiter' }, 'recruiter'],
      [{ title: 'Talent Acquisition Partner' }, 'recruiter'],
      [{ title: 'Associate Professor of Economics' }, 'faculty'],
      [{ company: 'Stripe' }, 'not_target_company'],
      [{ company: null }, 'not_target_company'],
      [{ score: 39 }, 'not_close'],
      [{ hasEmail: false }, 'no_email'],
      [{ hasHook: false }, 'no_hook'],
    ];
    for (const [over, rule] of cases) expect(block(over), rule).toBe(rule);
    // faculty is fine for a research goal
    expect(
      block({ title: 'Associate Professor' }, { kind: 'collaboration', targets: ['Figma'] }),
    ).toBeUndefined();
    // a campus ambassador is not a recruiter
    expect(block({ title: 'Campus Ambassador' })).toBeUndefined();
  });

  it('says each rule in a sentence with no dash or exclamation mark', () => {
    const rules: FirstTouchSkipRule[] = [
      'do_not_contact',
      'hidden',
      'private',
      'minor',
      'already_written',
      'open_chat',
      'pending',
      'recruiter',
      'faculty',
      'not_target_company',
      'not_close',
      'no_email',
      'no_hook',
      'target_met',
      'paced',
      'weekly_cap',
      'daily_cap',
      'same_firm_today',
    ];
    for (const r of rules) {
      const t = skipReason(r, { name: 'Priya Shah', company: 'Figma' }, { other: 'Kenji Mori' });
      expect(t).toMatch(/\.$/);
      expect(t).not.toMatch(/[–—!]/);
    }
    expect(skipReason('recruiter', { name: 'Priya Shah', company: 'Figma' })).toBe(
      'Priya is a recruiter at Figma. Autopilot never writes a first message to a recruiter; that one is yours to send.',
    );
    expect(
      skipReason('same_firm_today', { name: 'Priya Shah', company: 'Figma' }, { other: 'Kenji Mori' }),
    ).toBe(
      'Kenji Mori at Figma gets a first message that morning, and autopilot never writes to two people at one firm on the same day, so Priya moves to the next day.',
    );
  });
});

describe('one send morning (plan 29 §B6)', () => {
  const goal = { kind: 'recruiting' as const, targets: ['Ramp', 'Figma', 'Linear', 'Notion', 'Stripe'] };
  const c = (
    name: string,
    company: string,
    over: Partial<FirstTouchCandidate> = {},
  ): FirstTouchCandidate => ({
    personId: name.toLowerCase().replace(/\s+/g, '_'),
    name,
    company,
    score: 60,
    hasHook: true,
    hasEmail: true,
    ...over,
  });
  const day = (
    candidates: FirstTouchCandidate[],
    over: Partial<Parameters<typeof planFirstTouchDay>[0]> = {},
  ) =>
    planFirstTouchDay({
      candidates,
      goal,
      remaining: 12,
      daysLeft: 2,
      onDay: 0,
      thisWeek: 0,
      firmsOnDay: [],
      ...over,
    });

  it('never writes to two people at one firm on the same day, however the firm is spelled', () => {
    const r = day([
      c('Kenji Mori', 'Figma', { score: 80 }),
      c('Priya Shah', 'Figma, Inc.'),
      c('Ana Lin', 'Ramp'),
    ]);
    expect(r.picks.map((p) => p.candidate.name)).toEqual(['Kenji Mori', 'Ana Lin']);
    expect(r.skipped).toEqual([
      expect.objectContaining({ name: 'Priya Shah', rule: 'same_firm_today', company: 'Figma, Inc.' }),
    ]);
    // a firm already written to that morning by an earlier plan counts too
    const later = day([c('Priya Shah', 'Figma')], {
      firmsOnDay: [{ firm: firmKey('Figma'), name: 'Kenji Mori' }],
    });
    expect(later.picks).toEqual([]);
    expect(later.skipped[0]!.reason).toContain('Kenji Mori at Figma gets a first message that morning');
  });

  it('puts alumni first, then the people the student knows best, and stops at three a morning', () => {
    const r = day([
      c('Low Score', 'Ramp', { score: 41 }),
      c('Alum Person', 'Figma', { score: 5, isAlumni: true }),
      c('High Score', 'Linear', { score: 95 }),
      c('Mid Score', 'Notion', { score: 70 }),
      c('Late Comer', 'Stripe', { score: 50 }),
    ]);
    expect(r.quota).toBe(3);
    expect(r.picks.map((p) => p.candidate.name)).toEqual(['Alum Person', 'High Score', 'Mid Score']);
    expect(r.skipped.map((x) => [x.name, x.rule])).toEqual([
      ['Late Comer', 'daily_cap'],
      ['Low Score', 'daily_cap'],
    ]);
  });

  it('holds to twelve a week, the morning already planned, and the week target spread over the days left', () => {
    const many = ['Ramp', 'Figma', 'Linear', 'Notion', 'Stripe'].map((f, i) => c(`P${i} Person`, f));
    expect(day(many, { thisWeek: 11 }).picks).toHaveLength(1);
    expect(day(many, { thisWeek: 11 }).skipped.map((x) => x.rule)).toContain('weekly_cap');
    expect(day(many, { thisWeek: 12 }).picks).toHaveLength(0);
    expect(day(many, { onDay: 2 }).picks).toHaveLength(1);
    expect(day(many, { onDay: 3 }).quota).toBe(0);
    // four left over two days: two this morning, the rest wait their turn
    const paced = day(many, { remaining: 4, daysLeft: 2 });
    expect(paced.picks).toHaveLength(2);
    expect(paced.skipped.map((x) => x.rule)).toEqual(['paced', 'paced', 'paced']);
    const done = day(many, { remaining: 0 });
    expect(done.picks).toEqual([]);
    expect(done.skipped.every((x) => x.rule === 'target_met')).toBe(true);
  });

  it('a friend route is a pick of its own kind: the ask goes to the friend', () => {
    const friend = { userId: 'u2', name: 'Ana Okafor', sharePersonId: 's1' };
    const r = day([c('Dan Lee', 'Stripe', { score: 0, hasEmail: false, hasHook: false, viaFriend: friend })]);
    expect(r.picks).toEqual([expect.objectContaining({ route: 'friend' })]);
  });
});
