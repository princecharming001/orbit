import { describe, expect, it } from 'vitest';
import {
  autoReplyClassAllowed,
  CLOSING_CLASSES,
  DRAFTED_CLASSES,
  holdsQuestion,
  REPLY_NEXT_ACTION,
} from '../email/nextAction';
import { REPLY_CLASSES, type ReplyClass } from '../email/replyClass';
import {
  AUTO_SEND_CLASSES,
  type AutonomyContext,
  autonomyAllows,
  type OutgoingAction,
} from '../safety/rules';

// Wednesday 14 October 2026, 15:00 UTC (11:00 in New York)
const NOW = new Date('2026-10-14T15:00:00Z');
const TZ = 'America/New_York';

const confirm: OutgoingAction = {
  kind: 'reply',
  channel: 'gmail',
  personId: 'p',
  subject: null,
  body: 'Hi Maya,\n\nThursday at 2pm works. Talk then.\n\nBest,\nAlex',
  fromEmail: 'alex@cornell.edu',
  signedAs: 'Alex',
};

const ctx = (over: Partial<AutonomyContext> = {}): AutonomyContext => ({
  now: NOW,
  userEmails: ['alex@cornell.edu'],
  userName: 'Alex Kim',
  recipient: {},
  history: [
    { direction: 'out', at: '2026-10-12T15:00:00Z' },
    { direction: 'in', at: '2026-10-13T15:00:00Z' },
  ],
  timeZone: TZ,
  offeredSlots: ['2026-10-15T18:00:00Z'],
  userAutonomy: 2,
  replyClass: 'scheduling',
  inThread: true,
  recipientScore: 55,
  validatorOk: true,
  autoSentToday: 0,
  ...over,
});

describe('the class table (plan 29 §B2.3)', () => {
  it('maps every reply class to a next action with a sentence', () => {
    for (const cls of REPLY_CLASSES) {
      const row = REPLY_NEXT_ACTION[cls];
      expect(row, cls).toBeDefined();
      expect(row.summary.length, cls).toBeGreaterThan(20);
      expect(row.summary, cls).not.toMatch(/[–—!]/);
    }
    expect(Object.keys(REPLY_NEXT_ACTION).sort()).toEqual([...REPLY_CLASSES].sort());
  });

  it('encodes the plan: what drafts, what closes, what goes on its own', () => {
    expect([...DRAFTED_CLASSES].sort()).toEqual(
      ['interested', 'scheduling', 'objection', 'not_now', 'referral', 'thanks'].sort(),
    );
    expect([...CLOSING_CLASSES].sort()).toEqual(['decline', 'unsubscribe']);
    for (const cls of ['decline', 'unsubscribe'] as ReplyClass[]) {
      expect(REPLY_NEXT_ACTION[cls]).toMatchObject({
        drafts: false,
        doNotContact: true,
        tells: true,
        outcome: 'declined',
      });
    }
    expect(REPLY_NEXT_ACTION.question).toMatchObject({ action: 'needs_you', drafts: false, tells: true });
    expect(REPLY_NEXT_ACTION.out_of_office).toMatchObject({
      action: 'hold',
      holdsBumps: true,
      auto: 'always',
    });
    expect(REPLY_NEXT_ACTION.other).toMatchObject({ action: 'on_request', drafts: false });
    for (const cls of ['objection', 'not_now', 'referral'] as ReplyClass[])
      expect(REPLY_NEXT_ACTION[cls]).toMatchObject({ action: 'draft', auto: 'never' });
    // the set in the rules is unchanged; the table adds interested under the no-question condition
    expect([...AUTO_SEND_CLASSES].sort()).toEqual(['out_of_office', 'scheduling', 'thanks']);
    expect(REPLY_NEXT_ACTION.interested.auto).toBe('no_question');
    expect(REPLY_NEXT_ACTION.thanks.auto).toBe('no_question');
  });

  it('autoReplyClassAllowed: the no-question classes turn on the text', () => {
    expect(autoReplyClassAllowed('scheduling', true)).toBe(true);
    expect(autoReplyClassAllowed('out_of_office', true)).toBe(true);
    expect(autoReplyClassAllowed('interested', false)).toBe(true);
    expect(autoReplyClassAllowed('interested', true)).toBe(false);
    expect(autoReplyClassAllowed('thanks', false)).toBe(true);
    expect(autoReplyClassAllowed('thanks', true)).toBe(false);
    for (const cls of [
      'question',
      'objection',
      'not_now',
      'referral',
      'decline',
      'unsubscribe',
      'other',
    ] as ReplyClass[])
      expect(autoReplyClassAllowed(cls, false), cls).toBe(false);
  });

  it('autonomyAllows passes exactly the allowed cases and names the class otherwise', () => {
    const reasons = (c: AutonomyContext) => autonomyAllows(confirm, c).reasons;
    const allowed: [ReplyClass, boolean][] = [
      ['scheduling', false],
      ['scheduling', true],
      ['out_of_office', false],
      ['out_of_office', true],
      ['interested', false],
      ['thanks', false],
    ];
    for (const [cls, q] of allowed)
      expect(reasons(ctx({ replyClass: cls, replyHoldsQuestion: q })), `${cls} ${q}`).toEqual([]);
    expect(reasons(ctx({ replyClass: 'interested', replyHoldsQuestion: true }))).toEqual([
      'reply class interested with a question',
    ]);
    expect(reasons(ctx({ replyClass: 'thanks', replyHoldsQuestion: true }))).toEqual([
      'reply class thanks with a question',
    ]);
    for (const cls of [
      'question',
      'objection',
      'not_now',
      'referral',
      'decline',
      'unsubscribe',
      'other',
    ] as ReplyClass[])
      expect(reasons(ctx({ replyClass: cls })), cls).toEqual([`reply class ${cls}`]);
  });
});

describe('holdsQuestion', () => {
  it('finds a question mark or an asking phrase outside the quoted history', () => {
    expect(holdsQuestion('Happy to. Quick one first: have you applied through the portal yet?')).toBe(true);
    expect(holdsQuestion('Sounds good. Let me know if Thursday works for you.')).toBe(true);
    expect(holdsQuestion("I'd like to know what team you are aiming for.")).toBe(true);
    expect(holdsQuestion('Thanks for the note, appreciate you reaching out. Good luck with the rest.')).toBe(
      false,
    );
    expect(holdsQuestion('Thu Oct 8 at 11 works for me. Send a calendar invite and I will be there.')).toBe(
      false,
    );
    expect(holdsQuestion('')).toBe(false);
  });

  it('ignores a question in the quoted reply and in a quoted phrase', () => {
    const quoted = [
      'Thursday works for me.',
      '',
      'On Mon, Oct 12, 2026 at 11:00 AM Alex Kim <alex@cornell.edu> wrote:',
      '> Would you have time for a short call next week?',
    ].join('\n');
    expect(holdsQuestion(quoted)).toBe(false);
    expect(holdsQuestion('My manager said "why not?" so yes, happy to talk.')).toBe(false);
  });
});
