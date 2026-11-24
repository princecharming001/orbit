import { describe, expect, it } from 'vitest';
import { generateCandidates, type RuleInput } from '../suggestions/rules';
import type { CoffeeChat, Person, UserSettings } from '../types';
import {
  type AutoActionLog,
  afterGap,
  approvedCommentError,
  autoDayLabel,
  autoPlanLines,
  autoWarmUpSchedule,
  inWorkingHours,
  isWorkingDay,
  nextWorkingDaySlot,
  planFromRun,
  postExcerpt,
  retrySlot,
  tidyWarmUpComment,
  WARMUP_AUTO_CAPS,
  type WarmUpRun,
  type WarmUpStopReason,
  warmUpCapVerdict,
  warmUpCommentProblems,
  warmUpPostCandidates,
  warmUpStopWords,
  whenWorking,
  workingDayAfter,
} from '../warmup/auto';
import { buildWarmUpPlan, replanWarmUp, wallClock, wallKey, warmUpProgress } from '../warmup/rules';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const at = (iso: string) => new Date(iso);
/** the local hour of an instant in a zone */
const hourIn = (iso: string, tz: string) => new Date(wallClock(Date.parse(iso), tz)).getUTCHours();
/** a deterministic stream of "random" numbers */
const seeded = (seed = 7) => {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
};

describe('WARMUP_AUTO_CAPS', () => {
  it('holds every limit in one place, at the agreed values', () => {
    expect(WARMUP_AUTO_CAPS.perDay).toEqual({ view_profile: 15, react_post: 10, comment_post: 4 });
    expect(WARMUP_AUTO_CAPS.minGapSeconds).toBe(90);
    expect(WARMUP_AUTO_CAPS.perPersonPerDay).toBe(1);
    expect(WARMUP_AUTO_CAPS.maxAttempts).toBe(2);
    expect(WARMUP_AUTO_CAPS.workStartHour).toBe(9);
    expect(WARMUP_AUTO_CAPS.workEndHour).toBe(17);
    // far under what LinkedIn tolerates per account per day (about 100 of each), whatever is changed later
    for (const n of Object.values(WARMUP_AUTO_CAPS.perDay)) expect(n).toBeLessThanOrEqual(25);
    expect(WARMUP_AUTO_CAPS.commentMaxChars).toBeLessThanOrEqual(1250);
    expect(WARMUP_AUTO_CAPS.previewsPerDay).toBe(25);
  });
});

describe('working days and hours', () => {
  it('knows weekends and US holidays are not working days', () => {
    expect(isWorkingDay('2026-12-11')).toBe(true); // a Friday
    expect(isWorkingDay('2026-12-12')).toBe(false); // Saturday
    expect(isWorkingDay('2026-12-13')).toBe(false); // Sunday
    expect(isWorkingDay('2026-12-25')).toBe(false); // Christmas Day
    expect(isWorkingDay('2026-11-26')).toBe(false); // Thanksgiving
  });

  it('counts working days across a weekend and a holiday', () => {
    expect(workingDayAfter('2026-12-11', 1)).toBe('2026-12-14'); // Friday → Monday
    expect(workingDayAfter('2026-12-12', 0)).toBe('2026-12-14'); // Saturday itself is not one
    expect(workingDayAfter('2026-12-24', 1)).toBe('2026-12-28'); // over Christmas and the weekend
    expect(workingDayAfter('2026-12-14', 3)).toBe('2026-12-17');
  });

  it('reads working hours in the student’s time zone', () => {
    // Monday 14 Dec 2026, 13:30 UTC is 8:30 in New York and 22:30 in Tokyo
    expect(inWorkingHours(at('2026-12-14T13:30:00Z'), NY)).toBe(false);
    expect(inWorkingHours(at('2026-12-14T14:00:00Z'), NY)).toBe(true);
    expect(inWorkingHours(at('2026-12-14T21:59:00Z'), NY)).toBe(true);
    expect(inWorkingHours(at('2026-12-14T22:00:00Z'), NY)).toBe(false);
    expect(inWorkingHours(at('2026-12-14T01:00:00Z'), TOKYO)).toBe(true);
    // Saturday noon in New York
    expect(inWorkingHours(at('2026-12-12T17:00:00Z'), NY)).toBe(false);
  });

  it('moves a night or weekend time to a random minute of the next working window', () => {
    const rnd = seeded();
    // Friday 23:00 New York → Monday
    const mon = whenWorking(at('2026-12-12T04:00:00Z'), NY, rnd);
    expect(wallKey(mon, NY)).toBe('2026-12-14');
    expect(inWorkingHours(mon, NY)).toBe(true);
    // Monday 7:00 New York → later the same day
    const same = whenWorking(at('2026-12-14T12:00:00Z'), NY, rnd);
    expect(wallKey(same, NY)).toBe('2026-12-14');
    expect(inWorkingHours(same, NY)).toBe(true);
    // inside the window: left alone
    const inside = at('2026-12-14T15:00:00Z');
    expect(whenWorking(inside, NY, rnd)).toBe(inside);
  });

  it('retries later the same day, or the next working day when the day is nearly over', () => {
    const rnd = seeded(3);
    const morning = at('2026-12-14T15:00:00Z'); // 10:00 New York
    const again = retrySlot(morning, NY, rnd);
    const minutes = (again.getTime() - morning.getTime()) / 60_000;
    expect(minutes).toBeGreaterThanOrEqual(WARMUP_AUTO_CAPS.retryAfterMinutes.min);
    expect(minutes).toBeLessThanOrEqual(WARMUP_AUTO_CAPS.retryAfterMinutes.max);
    expect(wallKey(again, NY)).toBe('2026-12-14');
    const late = at('2026-12-14T21:40:00Z'); // 16:40 New York
    const next = retrySlot(late, NY, rnd);
    expect(wallKey(next, NY)).toBe('2026-12-15');
    expect(inWorkingHours(next, NY)).toBe(true);
  });

  it('spaces actions at least the gap apart, with a random extra', () => {
    const now = at('2026-12-14T15:00:00Z');
    expect(afterGap(undefined, now)).toBe(now);
    for (let i = 0; i < 50; i++) {
      const t = afterGap(new Date(now.getTime() - 10_000), now, Math.random);
      const wait = (t.getTime() - (now.getTime() - 10_000)) / 1000;
      expect(wait).toBeGreaterThanOrEqual(WARMUP_AUTO_CAPS.minGapSeconds);
      expect(wait).toBeLessThan(WARMUP_AUTO_CAPS.minGapSeconds + WARMUP_AUTO_CAPS.gapJitterSeconds);
    }
    // long ago: now
    expect(afterGap(new Date(now.getTime() - 3_600_000), now).getTime()).toBe(now.getTime());
  });
});

describe('the automated schedule', () => {
  const start = at('2026-12-14T15:00:00Z'); // Monday 10:00 New York
  const plan = (over: Partial<Parameters<typeof autoWarmUpSchedule>[0]> = {}) =>
    autoWarmUpSchedule({
      now: start,
      warmUpDays: 4,
      tz: NY,
      hasPost: true,
      withComment: true,
      random: seeded(11),
      ...over,
    });

  it('views the profile today, likes on day 2 and comments on day 3 of a four-day warm-up', () => {
    const s = plan();
    expect(s.steps.map((x) => x.kind)).toEqual(['view_profile', 'react_post', 'comment_post']);
    expect(s.steps.map((x) => x.id)).toEqual(['w1', 'w2', 'w3']);
    expect(s.steps.map((x) => wallKey(new Date(x.dueAt), NY))).toEqual([
      '2026-12-14',
      '2026-12-16',
      '2026-12-17',
    ]);
    const soon = (Date.parse(s.steps[0]!.dueAt) - start.getTime()) / 60_000;
    expect(soon).toBeGreaterThanOrEqual(1);
    expect(soon).toBeLessThanOrEqual(10);
    expect(s.readyAt).toBe(s.steps[2]!.dueAt);
  });

  it('puts the same steps on the same days as the manual plan', () => {
    // two weeks with no holiday in them
    const september = at('2026-09-14T15:00:00Z');
    for (const n of [3, 4, 5, 6, 8, 10]) {
      const manual = buildWarmUpPlan('priya', september, n, NY);
      const auto = plan({ now: september, warmUpDays: n });
      expect(
        auto.steps.map((x) => wallKey(new Date(x.dueAt), NY)),
        `n=${n}`,
      ).toEqual(manual.actions.map((a) => wallKey(new Date(a.dueAt), NY)));
    }
  });

  it('steps over a holiday: the comment of a ten-day warm-up waits for the Monday after Christmas', () => {
    const s = plan({ warmUpDays: 10 });
    expect(s.steps.map((x) => wallKey(new Date(x.dueAt), NY))).toEqual([
      '2026-12-14',
      '2026-12-21',
      '2026-12-28',
    ]);
  });

  it('never puts two steps for one person on one day, even on the shortest warm-up', () => {
    const s = plan({ warmUpDays: 2 });
    const days = s.steps.map((x) => wallKey(new Date(x.dueAt), NY));
    expect(new Set(days).size).toBe(3);
    expect(days).toEqual(['2026-12-14', '2026-12-15', '2026-12-16']);
  });

  it('keeps every step inside working hours on a working day, in any zone and from any start', () => {
    const rnd = seeded(5);
    for (const tz of [NY, TOKYO, 'Europe/London', 'America/Los_Angeles', 'Australia/Sydney'])
      for (let h = 0; h < 24 * 9; h += 5) {
        const now = new Date(Date.parse('2026-12-10T00:00:00Z') + h * 3_600_000);
        for (const n of [2, 4, 10]) {
          const s = autoWarmUpSchedule({
            now,
            warmUpDays: n,
            tz,
            hasPost: true,
            withComment: true,
            random: rnd,
          });
          for (const step of s.steps) {
            const due = new Date(step.dueAt);
            expect(inWorkingHours(due, tz), `${tz} ${now.toISOString()} ${step.kind}`).toBe(true);
            expect(due.getTime()).toBeGreaterThan(now.getTime());
          }
          const days = s.steps.map((x) => wallKey(new Date(x.dueAt), tz));
          expect(new Set(days).size).toBe(days.length);
          expect([...days].sort()).toEqual(days);
        }
      }
  });

  it('starts the next working morning when started at night or on a weekend', () => {
    const night = plan({ now: at('2026-12-15T03:00:00Z') }); // Monday 22:00 New York
    expect(wallKey(new Date(night.steps[0]!.dueAt), NY)).toBe('2026-12-15');
    const saturday = plan({ now: at('2026-12-12T16:00:00Z') });
    expect(saturday.steps.map((x) => wallKey(new Date(x.dueAt), NY))).toEqual([
      '2026-12-14',
      '2026-12-16',
      '2026-12-17',
    ]);
    // before 9:00 on a working day: later the same day
    const early = plan({ now: at('2026-12-14T11:00:00Z') });
    expect(wallKey(new Date(early.steps[0]!.dueAt), NY)).toBe('2026-12-14');
    expect(hourIn(early.steps[0]!.dueAt, NY)).toBeGreaterThanOrEqual(9);
  });

  it('skips the weekend: started on Friday, the like is on Tuesday', () => {
    const s = plan({ now: at('2026-12-11T15:00:00Z') });
    expect(s.steps.map((x) => wallKey(new Date(x.dueAt), NY))).toEqual([
      '2026-12-11',
      '2026-12-15',
      '2026-12-16',
    ]);
  });

  it('is the profile view only when there is no recent post, and has no comment when it is left out', () => {
    expect(plan({ hasPost: false }).steps.map((x) => x.kind)).toEqual(['view_profile']);
    expect(plan({ hasPost: false, withComment: true }).steps).toHaveLength(1);
    const two = plan({ withComment: false });
    expect(two.steps.map((x) => x.kind)).toEqual(['view_profile', 'react_post']);
    expect(two.readyAt).toBe(two.steps[1]!.dueAt);
  });

  it('picks a different minute each time', () => {
    const minutes = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = autoWarmUpSchedule({ now: start, tz: NY, hasPost: true, withComment: true });
      minutes.add(
        new Date(s.steps[1]!.dueAt).getUTCMinutes() + 60 * new Date(s.steps[1]!.dueAt).getUTCHours(),
      );
    }
    expect(minutes.size).toBeGreaterThan(10);
  });

  it('gives a slot on the next working day when a cap is reached', () => {
    const t = nextWorkingDaySlot(at('2026-12-18T15:00:00Z'), NY, seeded()); // a Friday
    expect(wallKey(t, NY)).toBe('2026-12-21');
    expect(inWorkingHours(t, NY)).toBe(true);
  });
});

describe('the daily caps', () => {
  const now = at('2026-12-14T16:00:00Z');
  const log = (
    kind: AutoActionLog['kind'],
    minutesAgo: number,
    personId: string,
    stepId?: string,
  ): AutoActionLog => ({
    kind,
    at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    personId,
    stepId,
  });

  it('allows the first action of the day', () => {
    expect(warmUpCapVerdict({ kind: 'view_profile', personId: 'p1', now, today: [] })).toEqual({
      allowed: true,
    });
  });

  it('refuses an action inside the gap and says when the gap has passed', () => {
    const v = warmUpCapVerdict({
      kind: 'react_post',
      personId: 'p2',
      now,
      today: [{ kind: 'view_profile', at: new Date(now.getTime() - 30_000).toISOString(), personId: 'p1' }],
    });
    expect(v).toEqual({
      allowed: false,
      reason: 'gap',
      retryAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    // the last action of yesterday counts for the gap too
    expect(
      warmUpCapVerdict({
        kind: 'view_profile',
        personId: 'p2',
        now,
        today: [],
        lastAt: new Date(now.getTime() - 89_000).toISOString(),
      }).allowed,
    ).toBe(false);
  });

  it('holds each kind at its own daily count', () => {
    for (const kind of ['view_profile', 'react_post', 'comment_post'] as const) {
      const cap = WARMUP_AUTO_CAPS.perDay[kind];
      const today = Array.from({ length: cap }, (_, i) => log(kind, 10 + i * 3, `other-${i}`));
      expect(warmUpCapVerdict({ kind, personId: 'p-new', now, today })).toEqual({
        allowed: false,
        reason: 'day_cap',
      });
      expect(warmUpCapVerdict({ kind, personId: 'p-new', now, today: today.slice(1) })).toEqual({
        allowed: true,
      });
    }
    // a full day of views leaves room for a like
    const views = Array.from({ length: 15 }, (_, i) => log('view_profile', 10 + i * 3, `other-${i}`));
    expect(warmUpCapVerdict({ kind: 'react_post', personId: 'p-new', now, today: views }).allowed).toBe(true);
  });

  it('allows one action per person per day, and a second try of the same step', () => {
    const today = [log('view_profile', 120, 'p1', 'step-1')];
    expect(warmUpCapVerdict({ kind: 'react_post', personId: 'p1', stepId: 'step-2', now, today })).toEqual({
      allowed: false,
      reason: 'person_day',
    });
    expect(
      warmUpCapVerdict({ kind: 'view_profile', personId: 'p1', stepId: 'step-1', now, today }).allowed,
    ).toBe(true);
    expect(
      warmUpCapVerdict({ kind: 'react_post', personId: 'p2', stepId: 'step-9', now, today }).allowed,
    ).toBe(true);
  });
});

describe('the post and the comment', () => {
  const now = at('2026-12-14T16:00:00Z');
  const long = (s: string) => `${s} and here is the rest of a post that says enough to be worth a comment.`;

  it('offers the person’s own recent posts, newest first, and never a repost or an old or empty one', () => {
    const picked = warmUpPostCandidates(
      [
        { id: 'old', text: long('An old one'), at: '2026-09-01T10:00:00Z' },
        { id: 'repost', text: long('Someone else said'), at: '2026-12-13T10:00:00Z', isRepost: true },
        { id: 'short', text: 'Hiring.', at: '2026-12-12T10:00:00Z' },
        { id: 'b', text: long('Second newest'), at: '2026-12-01T10:00:00Z' },
        { id: 'a', text: long('Newest'), at: '2026-12-10T10:00:00Z' },
        { id: 'a', text: long('Newest again'), at: '2026-12-10T10:00:00Z' },
        { id: 'undated', text: long('No date on this one') },
      ],
      now,
    );
    expect(picked.map((p) => p.id)).toEqual(['a', 'b', 'undated']);
    expect(warmUpPostCandidates([], now)).toEqual([]);
    expect(
      warmUpPostCandidates(
        Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, text: long(`Post ${i}`) })),
        now,
      ),
    ).toHaveLength(WARMUP_AUTO_CAPS.postCandidates);
  });

  it('cuts an excerpt at a word', () => {
    expect(postExcerpt('Short post.')).toBe('Short post.');
    const e = postExcerpt(
      'New analysts should ship something real in their first week, not sit in onboarding decks for a month.',
      50,
    );
    expect(e.endsWith('…')).toBe(true);
    expect(e.length).toBeLessThanOrEqual(51);
    expect(e).not.toMatch(/\s…$/);
  });

  it('tidies a drafted comment: no dashes, no exclamation marks, no quotes around it', () => {
    expect(tidyWarmUpComment('"Shipping in week one — did that hold once the team grew?!"')).toBe(
      'Shipping in week one, did that hold once the team grew?.',
    );
    expect(tidyWarmUpComment('  Two\n\nlines   here ')).toBe('Two lines here');
    expect(tidyWarmUpComment('A point – and another!')).not.toMatch(/[—–!]/);
  });

  it('names what is wrong with a drafted comment', () => {
    expect(warmUpCommentProblems('Did the week-one rule hold once the team passed twenty people?')).toEqual(
      [],
    );
    expect(warmUpCommentProblems('')).toEqual(['empty']);
    expect(warmUpCommentProblems('Great post, love this')).toContain('flattery');
    expect(warmUpCommentProblems('So inspiring to read')).toContain('flattery');
    expect(warmUpCommentProblems('More here https://example.com')).toContain('link');
    expect(warmUpCommentProblems('Agree #hiring')).toContain('hashtag');
    expect(warmUpCommentProblems('Hi {{0}} what about this')).toContain('mention');
    expect(warmUpCommentProblems('x'.repeat(601))).toContain('too_long');
  });

  it('accepts what the student approved unless it is empty, too long or carries a tag marker', () => {
    expect(approvedCommentError('Fair point. Does it hold for interns?')).toBeUndefined();
    // the student may write what they like: praise and an exclamation mark are their choice
    expect(approvedCommentError('Loved this!')).toBeUndefined();
    expect(approvedCommentError('   ')).toBe('Write the comment, or leave it out.');
    expect(approvedCommentError('x'.repeat(601))).toMatch(/under 600 characters/);
    expect(approvedCommentError('Hi {{0}}')).toMatch(/double braces/);
  });
});

describe('the run as the browser shows it', () => {
  const run = (over: Partial<WarmUpRun> = {}): WarmUpRun => ({
    id: 'r1',
    userId: 'u',
    personId: 'p1',
    status: 'running',
    post: {
      url: 'https://www.linkedin.com/posts/priya_activity-1',
      excerpt: 'New analysts should ship in week one',
      topic: 'new analysts shipping in week one',
    },
    comment: 'Did that hold once the team grew?',
    steps: [
      {
        id: 's1',
        seq: 1,
        kind: 'view_profile',
        dueAt: '2026-12-14T15:05:00Z',
        status: 'done',
        attempts: 1,
        ranAt: '2026-12-14T15:06:00Z',
      },
      { id: 's2', seq: 2, kind: 'react_post', dueAt: '2026-12-16T16:00:00Z', status: 'pending', attempts: 0 },
      {
        id: 's3',
        seq: 3,
        kind: 'comment_post',
        dueAt: '2026-12-17T18:00:00Z',
        status: 'pending',
        attempts: 0,
      },
    ],
    startedAt: '2026-12-14T15:00:00Z',
    readyAt: '2026-12-17T18:00:00Z',
    ...over,
  });

  it('mirrors a running run: Orbit’s labels, the step that ran marked done, nothing ready yet', () => {
    const plan = planFromRun(run(), 'priya');
    expect(plan.auto).toMatchObject({
      runId: 'r1',
      status: 'running',
      comment: 'Did that hold once the team grew?',
    });
    expect(plan.actions.map((a) => a.id)).toEqual(['w1', 'w2', 'w3']);
    expect(plan.actions[0]).toMatchObject({
      doneAt: '2026-12-14T15:06:00Z',
      label: 'Orbit views their profile',
    });
    expect(plan.actions[1]!.url).toBe('https://www.linkedin.com/posts/priya_activity-1');
    expect(plan.actions[0]!.url).toBe('https://www.linkedin.com/in/priya/');
    // long after the planned date and still running (a step waited for a cap): not ready, not overdue
    const prog = warmUpProgress(plan, at('2026-12-30T00:00:00Z'), NY);
    expect(prog).toMatchObject({ ready: false, overdue: false, done: 1, total: 3 });
    expect(replanWarmUp(plan, at('2026-12-30T00:00:00Z'), NY)).toBeUndefined();
  });

  it('is ready the moment the last step has run, and the post’s topic is the note for the first message', () => {
    const done = run({
      status: 'done',
      finishedAt: '2026-12-17T18:02:00Z',
      steps: run().steps.map((s) => ({ ...s, status: 'done' as const, ranAt: s.dueAt, attempts: 1 })),
    });
    const plan = planFromRun(done, 'priya');
    const prog = warmUpProgress(plan, at('2026-12-17T18:03:00Z'), NY);
    expect(prog).toMatchObject({ ready: true, skippedAll: false, done: 3 });
    expect(plan.actions[1]!.note).toBe('new analysts shipping in week one');
    expect(plan.actions[2]!.note).toBe('new analysts shipping in week one');
    expect(plan.actions[0]!.note).toBeUndefined();
  });

  it('shows why a step was skipped', () => {
    const r = run({
      status: 'done',
      finishedAt: '2026-12-17T18:02:00Z',
      steps: [
        { ...run().steps[0]! },
        {
          ...run().steps[1]!,
          status: 'skipped',
          note: 'post_gone',
          ranAt: '2026-12-16T16:01:00Z',
          attempts: 1,
        },
        { ...run().steps[2]!, status: 'skipped', note: 'post_gone' },
      ],
    });
    const plan = planFromRun(r, 'priya');
    expect(plan.actions[1]).toMatchObject({
      skippedAt: '2026-12-16T16:01:00Z',
      autoNote: 'The post is gone, so Orbit skipped this step.',
    });
    expect(plan.actions[2]!.skippedAt).toBe('2026-12-17T18:02:00Z');
    expect(warmUpProgress(plan, at('2026-12-17T19:00:00Z'), NY)).toMatchObject({
      ready: true,
      done: 1,
      skipped: 2,
    });
  });

  /** a run stopped after its first step, as the server leaves it: the steps never reached are closed as "stopped" */
  const stoppedRun = (reason: string) =>
    run({
      status: 'stopped',
      stopReason: reason,
      finishedAt: '2026-12-14T16:00:00Z',
      steps: run().steps.map((s) =>
        s.status === 'pending' ? { ...s, status: 'skipped' as const, note: 'stopped' } : s,
      ),
    });

  it('hands the steps Orbit never reached back to the student when Orbit stops a run', () => {
    const plan = planFromRun(stoppedRun('linkedin_sign_in'), 'priya');
    expect(plan.auto).toMatchObject({ status: 'stopped', stopReason: 'linkedin_sign_in' });
    expect(plan.actions[0]!.label).toBe('Orbit views their profile');
    expect(plan.actions[0]!.doneAt).toBeTruthy();
    // open again, under the words of a step the student does
    expect(plan.actions[1]).toMatchObject({
      label: 'React to one recent post that you genuinely find useful',
    });
    expect(plan.actions[1]!.skippedAt).toBeUndefined();
    expect(plan.actions[1]!.autoNote).toBeUndefined();
    expect(plan.actions[2]!.skippedAt).toBeUndefined();
    // the planned date stands, so the first message is not called ready the moment the run stops
    expect(plan.readyAt).toBe('2026-12-17T18:00:00Z');
    // the manual rules apply again
    const prog = warmUpProgress(plan, at('2026-12-15T15:00:00Z'), NY);
    expect(prog.nextAction?.id).toBe('w2');
    expect(prog.ready).toBe(false);
    // a step that was skipped for its own reason before the stop stays skipped
    const gone = stoppedRun('setting_off');
    gone.steps[1] = { ...gone.steps[1]!, note: 'post_gone' };
    expect(planFromRun(gone, 'priya').actions[1]!.skippedAt).toBeTruthy();
  });

  it('leaves nothing to do when the student stopped it', () => {
    const plan = planFromRun(stoppedRun('cancelled'), 'priya');
    expect(plan.actions.map((a) => [!!a.doneAt, !!a.skippedAt])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    expect(plan.actions[1]!.autoNote).toBe('Not run: the warm-up stopped first.');
  });

  const settings = { warmUpEnabled: true, warmUpDays: 4 } as UserSettings;
  const priya = {
    id: 'p1',
    userId: 'u',
    displayName: 'Priya Rao',
    firstName: 'Priya',
    isHuman: true,
    strength: 0.1,
  } as Person;
  const input = (now: Date, chat: CoffeeChat): RuleInput =>
    ({
      userId: 'u',
      now,
      settings,
      timezone: NY,
      people: new Map([[priya.id, priya]]),
      chats: [chat],
      lastInboundByChat: new Map(),
      events: [],
      actionItems: [],
      factsByPerson: new Map(),
      targetCompanies: [],
      recommendations: [],
      dismissCounts: new Map(),
    }) as unknown as RuleInput;
  const chatWith = (r: WarmUpRun): CoffeeChat =>
    ({
      id: 'c1',
      userId: 'u',
      personId: 'p1',
      stage: 'warming',
      stageEnteredAt: r.startedAt,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: r.startedAt,
      updatedAt: r.startedAt,
      warmUp: planFromRun(r, 'priya'),
    }) as CoffeeChat;

  it('asks nothing of the student while Orbit runs it: no step card on any day', () => {
    for (const day of ['2026-12-14T16:00:00Z', '2026-12-16T20:00:00Z', '2026-12-22T16:00:00Z']) {
      const cands = generateCandidates(input(at(day), chatWith(run())));
      expect(cands.filter((c) => c.kind === 'warm_up_engage')).toEqual([]);
      expect(cands.filter((c) => c.kind === 'new_outreach')).toEqual([]);
    }
  });

  it('offers the first message once, in Orbit’s words, when the run is done', () => {
    const done = run({
      status: 'done',
      finishedAt: '2026-12-17T18:02:00Z',
      steps: run().steps.map((s) => ({ ...s, status: 'done' as const, ranAt: s.dueAt, attempts: 1 })),
    });
    const cands = generateCandidates(input(at('2026-12-17T18:05:00Z'), chatWith(done)));
    const first = cands.filter((c) => c.kind === 'new_outreach');
    expect(first).toHaveLength(1);
    expect(first[0]!.reasonText).toBe('Orbit finished the warm-up; ready to message Priya');
    expect(first[0]!.signals).toMatchObject({ warmUpDone: 3, warmUpByOrbit: true });
  });

  it('says so plainly when nothing could run, and never that the student skipped it', () => {
    const none = run({
      status: 'done',
      finishedAt: '2026-12-17T18:02:00Z',
      steps: run().steps.map((s) => ({ ...s, status: 'skipped' as const, note: 'failed', attempts: 2 })),
    });
    const cands = generateCandidates(input(at('2026-12-17T18:05:00Z'), chatWith(none)));
    expect(cands.find((c) => c.kind === 'new_outreach')?.reasonText).toBe(
      'Orbit could not run the warm-up. Message Priya without it?',
    );
  });

  it('gives the student the step cards back when a run stopped', () => {
    const cands = generateCandidates(input(at('2026-12-16T16:00:00Z'), chatWith(stoppedRun('setting_off'))));
    expect(cands.find((c) => c.kind === 'warm_up_engage')?.signals.actionId).toBe('w2');
  });
});

describe('the plan in plain words', () => {
  const now = at('2026-12-14T15:00:00Z'); // a Monday, New York
  it('names the days as a person would', () => {
    expect(autoDayLabel('2026-12-14T20:00:00Z', now, NY)).toBe('Today');
    expect(autoDayLabel('2026-12-15T15:00:00Z', now, NY)).toBe('Tomorrow');
    expect(autoDayLabel('2026-12-16T15:00:00Z', now, NY)).toBe('Wednesday');
    expect(autoDayLabel('2026-12-28T15:00:00Z', now, NY)).toBe('Mon, Dec 28');
    // 02:00 UTC on the 15th is still the 14th in New York
    expect(autoDayLabel('2026-12-15T02:00:00Z', now, NY)).toBe('Today');
  });

  it('says the whole plan in three short lines', () => {
    const lines = autoPlanLines({
      firstName: 'Priya',
      steps: [
        { kind: 'view_profile', dueAt: '2026-12-14T15:05:00Z' },
        { kind: 'react_post', dueAt: '2026-12-16T16:00:00Z' },
        { kind: 'comment_post', dueAt: '2026-12-17T18:00:00Z' },
      ],
      postExcerpt: 'New analysts should ship in week one',
      now,
      tz: NY,
    });
    expect(lines.map((l) => `${l.day}: ${l.text}`)).toEqual([
      "Today: view Priya's profile.",
      'Wednesday: like their post: "New analysts should ship in week one"',
      'Thursday: comment on that post.',
    ]);
    for (const l of lines) expect(`${l.day}${l.text}`).not.toMatch(/[—!]/);
    expect(
      autoPlanLines({
        firstName: 'James',
        steps: [{ kind: 'view_profile', dueAt: now.toISOString() }],
        now,
        tz: NY,
      })[0]!.text,
    ).toBe("view James' profile.");
  });
});

describe('why a run stopped, in words', () => {
  const ALL: Record<WarmUpStopReason, true> = {
    cancelled: true,
    replied: true,
    messaged: true,
    connected: true,
    connect_sent: true,
    do_not_contact: true,
    hidden: true,
    merged: true,
    person_gone: true,
    linkedin_disconnected: true,
    linkedin_parked: true,
    linkedin_sign_in: true,
    linkedin_changed: true,
    setting_off: true,
  };
  it('has its own plain sentence for every reason, never the fallback', () => {
    const fallback = warmUpStopWords('something else', 'Priya');
    for (const r of Object.keys(ALL)) {
      const w = warmUpStopWords(r, 'Priya');
      expect(w, r).not.toBe(fallback);
      expect(w, r).not.toMatch(/[–—!]/);
      expect(w.endsWith('.'), r).toBe(true);
    }
    expect(warmUpStopWords('connect_sent', 'Priya')).toBe(
      'You sent Priya a connection request, so Orbit stopped the warm-up.',
    );
  });
});
