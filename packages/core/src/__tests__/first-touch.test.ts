import { describe, expect, it } from 'vitest';
import {
  AUTO_FIRST_TOUCH_KINDS,
  earliestPlannedSend,
  firstTouchGate,
  firstTouchRung,
  firstTouchRungLine,
  isFirstTouchKind,
  reviewWindow,
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
