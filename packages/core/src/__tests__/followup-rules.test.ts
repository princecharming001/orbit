import { describe, expect, it } from 'vitest';
import { type DraftContext, generateDraft } from '../drafts/templates';
import { isBlocked, validateDraft } from '../drafts/validate';
import { decideTransition } from '../pipeline/transitions';
import { defaultStyleCard } from '../style/card';
import {
  addBusinessDays,
  bumpDue,
  businessDaysBetween,
  type Candidate,
  clip,
  generateCandidates,
  introTarget,
  isQuietDay,
  isRuleSuggestion,
  lastContactPhrase,
  monthPhrase,
  parseReturnDate,
  type RuleInput,
  selectForBrief,
  usHolidays,
} from '../suggestions/rules';
import type { CoffeeChat, Person, PersonFact, Recommendation, TargetCompany, UserSettings } from '../types';
import { buildWarmUpPlan, warmUpProgress } from '../warmup/rules';

const TZ = 'America/New_York';
const H = 3_600_000;
const D = 86_400_000;
const at = (iso: string) => new Date(iso);

const settings: UserSettings = {
  userId: 'u',
  briefTimeLocal: '07:00',
  briefChannels: ['in_app'],
  quietDays: [],
  weeklyOutreachTarget: 4,
  dailySendCapGmail: 15,
  dailySendCapLinkedin: 10,
  perPersonCooldownHours: 72,
  maxBumps: 2,
  tonePreset: 'warm',
  warmUpEnabled: true,
  warmUpDays: 4,
};

function person(id: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    userId: 'u',
    displayName: `${id} Lee`,
    firstName: id,
    lastName: 'Lee',
    isHuman: true,
    relationshipType: 'unknown',
    strength: 0.3,
    currentOrganizationRaw: `${id} Corp`,
    ...extra,
  } as Person;
}

function chat(id: string, personId: string, extra: Partial<CoffeeChat> = {}): CoffeeChat {
  return {
    id,
    userId: 'u',
    personId,
    stage: 'identified',
    stageEnteredAt: '2026-01-01T00:00:00Z',
    source: 'detected',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  } as CoffeeChat;
}

function fact(
  id: string,
  personId: string,
  type: PersonFact['type'],
  text: string,
  occurredAt: string,
): PersonFact {
  return {
    id,
    userId: 'u',
    personId,
    type,
    text,
    occurredAt,
    createdAt: occurredAt,
    confidence: 1,
  } as PersonFact;
}

function input(now: Date, over: Omit<Partial<RuleInput>, 'people'> & { people: Person[] }): RuleInput {
  const { people, ...rest } = over;
  return {
    userId: 'u',
    now,
    settings,
    chats: [],
    lastInboundByChat: new Map(),
    events: [],
    actionItems: [],
    factsByPerson: new Map(),
    targetCompanies: [],
    recommendations: [],
    dismissCounts: new Map(),
    outreachSentThisWeek: 0,
    freeSlotsIso: [],
    recentlyContacted: new Set(),
    timezone: TZ,
    ...rest,
    people: new Map(people.map((p) => [p.id, p])),
  };
}

const cand = (kind: Candidate['kind'], personId: string, urgency: number, extra: Partial<Candidate> = {}) =>
  ({
    kind,
    personId,
    dedupeKey: `${kind}:${personId}`,
    reasonText: kind,
    signals: {},
    payload: {},
    urgency,
    goalRelevance: 0.6,
    confidence: 1,
    ...extra,
  }) as Candidate;

describe('business days (EG-11)', () => {
  it('knows the federal holidays, observed dates included', () => {
    const h = usHolidays(2026);
    expect(h.has('2026-11-26')).toBe(true); // Thanksgiving
    expect(h.has('2026-11-27')).toBe(true); // the day after
    expect(h.has('2026-07-03')).toBe(true); // July 4 is a Saturday in 2026
    expect(h.has('2026-01-19')).toBe(true); // MLK Day
    expect(h.has('2026-10-12')).toBe(true); // second Monday of October
    expect(h.has('2026-10-13')).toBe(false);
  });

  it('skips Thanksgiving, the winter freeze and weekends, and counts whole days after the send', () => {
    // sent Friday Nov 20: Mon 23, Tue 24, Wed 25, Mon 30 are business days; Thu 26 and Fri 27 are not
    expect(businessDaysBetween(at('2026-11-20T15:00:00Z'), at('2026-11-30T15:00:00Z'), TZ)).toBe(4);
    // sent Friday Dec 18: nothing counts until the freeze ends
    expect(businessDaysBetween(at('2026-12-18T15:00:00Z'), at('2026-12-26T15:00:00Z'), TZ)).toBe(0);
    expect(businessDaysBetween(at('2026-12-18T15:00:00Z'), at('2027-01-05T15:00:00Z'), TZ)).toBe(2);
    // Monday to Tuesday is one business day, not two
    expect(businessDaysBetween(at('2026-09-28T13:00:00Z'), at('2026-09-29T20:00:00Z'), TZ)).toBe(1);
    expect(addBusinessDays(at('2026-11-25T15:00:00Z'), 1, TZ).toISOString()).toBe('2026-11-30T15:00:00.000Z');
  });

  it('does not bump over Thanksgiving week or on Dec 26', () => {
    const p = person('dana');
    const c = chat('c1', 'dana', { stage: 'outreach_sent', lastOutboundAt: '2026-11-20T15:00:00Z' });
    expect(bumpDue(c, p, { now: at('2026-11-30T15:00:00Z'), settings, timezone: TZ })).toBeUndefined();
    expect(bumpDue(c, p, { now: at('2026-12-01T15:00:00Z'), settings, timezone: TZ })?.bdays).toBe(5);
    const dec = { ...c, lastOutboundAt: '2026-12-18T15:00:00Z' };
    expect(bumpDue(dec, p, { now: at('2026-12-26T15:00:00Z'), settings, timezone: TZ })).toBeUndefined();
  });

  it('waits longer before the second, last bump and says so', () => {
    // finance allows two bumps
    const p = person('dana', {
      currentTitle: 'Investment Banking Analyst',
      currentOrganizationRaw: 'Goldman Sachs',
    });
    // first bump went out Monday Oct 5; 6 business days later is not enough for the second
    const c = chat('c1', 'dana', {
      stage: 'outreach_sent',
      lastOutboundAt: '2026-10-05T14:00:00Z',
      bumpCount: 1,
    });
    const early = generateCandidates(input(at('2026-10-14T14:00:00Z'), { people: [p], chats: [c] }));
    expect(early.some((x) => x.kind === 'follow_up_bump')).toBe(false);
    const late = generateCandidates(input(at('2026-10-16T14:00:00Z'), { people: [p], chats: [c] }));
    const bump = late.find((x) => x.kind === 'follow_up_bump')!;
    expect(bump.dedupeKey).toBe('bump:c1:2');
    expect(bump.payload.bumpNumber).toBe(2);
    expect(bump.reasonText).toMatch(/last word/);
  });

  it('keeps bumps, check-ins and cold outreach out of the brief on quiet days', () => {
    expect(isQuietDay(at('2026-10-10T15:00:00Z'), settings, TZ)).toBe(true); // Saturday
    expect(isQuietDay(at('2026-11-26T15:00:00Z'), settings, TZ)).toBe(true); // Thanksgiving
    expect(isQuietDay(at('2026-10-07T15:00:00Z'), settings, TZ)).toBe(false);
    expect(isQuietDay(at('2026-10-07T15:00:00Z'), { quietDays: [3] }, TZ)).toBe(true); // the student's own
    const sel = selectForBrief(
      [
        cand('follow_up_bump', 'a', 0.9),
        cand('new_outreach', 'b', 0.5),
        cand('nurture_checkin', 'c', 0.4),
        cand('thank_you', 'd', 0.95),
        cand('action_item_reminder', 'e', 0.7),
        cand('schedule_propose', 'f', 0.9),
      ],
      new Map(),
      7,
      { quiet: true },
    );
    expect(sel.map((s) => s.kind).sort()).toEqual(['action_item_reminder', 'schedule_propose', 'thank_you']);
  });
});

describe('out of office (EG-12)', () => {
  it('reads the return date from common phrasings', () => {
    const sent = at('2026-10-06T16:00:00Z'); // Tuesday
    const day = (d?: Date) => d?.toISOString().slice(0, 10);
    expect(
      day(parseReturnDate('I am out of the office until Monday, October 19 with limited access.', sent, TZ)),
    ).toBe('2026-10-19');
    expect(day(parseReturnDate("I'll be back on 10/14 and will reply then.", sent, TZ))).toBe('2026-10-14');
    expect(day(parseReturnDate('Out of office through Oct 9.', sent, TZ))).toBe('2026-10-10');
    expect(day(parseReturnDate('Away until Friday.', sent, TZ))).toBe('2026-10-09');
    expect(day(parseReturnDate('Returning January 4th.', sent, TZ))).toBe('2027-01-04');
    expect(parseReturnDate('I am currently out of the office.', sent, TZ)).toBeUndefined();
  });

  it('holds the bump until they are back, then words it for the return', () => {
    const p = person('felix');
    const c = chat('c1', 'felix', {
      stage: 'outreach_sent',
      lastOutboundAt: '2026-09-22T13:00:00Z',
      bumpNotBefore: addBusinessDays(at('2026-10-19T13:00:00Z'), 2, TZ).toISOString(),
    });
    const held = generateCandidates(input(at('2026-10-06T14:00:00Z'), { people: [p], chats: [c] }));
    expect(held.some((x) => x.kind === 'follow_up_bump')).toBe(false);
    const back = generateCandidates(input(at('2026-10-21T14:00:00Z'), { people: [p], chats: [c] }));
    const bump = back.find((x) => x.kind === 'follow_up_bump')!;
    expect(bump.reasonText).toMatch(/out of office/);
  });

  it('closes a silent thread on business days after the last bump', () => {
    const t = (b: number) =>
      decideTransition('outreach_sent', {
        type: 'timer_no_response',
        bumps: 2,
        maxBumps: 2,
        daysSilent: 13,
        businessDaysSilent: b,
      });
    expect(t(9)).toBeUndefined();
    expect(t(10)?.to).toBe('no_response');
  });

  it('moves a completed chat with no thank-you on record to nurturing after two weeks', () => {
    expect(decideTransition('completed', { type: 'timer_completed_14d' })?.to).toBe('nurturing');
    expect(decideTransition('scheduled', { type: 'timer_completed_14d' })).toBeUndefined();
  });
});

describe('company concentration and promises (EG-05, EG-14)', () => {
  const rec = (id: string, personId: string): Recommendation =>
    ({
      id,
      userId: 'u',
      personId,
      score: 0.9,
      fitScore: 0.9,
      reasons: [{ text: 'Alum at a target company' }],
      status: 'new',
    }) as unknown as Recommendation;

  it('does not start a third thread at a company with two live ones', () => {
    const stripe = (id: string) =>
      person(id, { currentOrganizationRaw: 'Stripe', currentOrganizationId: 'org_stripe' });
    const people = [stripe('a'), stripe('b'), stripe('c'), person('d')];
    const chats = [
      chat('ca', 'a', { stage: 'outreach_sent', lastOutboundAt: '2026-10-05T13:00:00Z' }),
      chat('cb', 'b', { stage: 'replied' }),
    ];
    const cands = generateCandidates(
      input(at('2026-10-07T14:00:00Z'), { people, chats, recommendations: [rec('r1', 'c'), rec('r2', 'd')] }),
    );
    const outreach = cands.filter((x) => x.kind === 'new_outreach').map((x) => x.personId);
    expect(outreach).toEqual(['d']);
  });

  it('never crowds out a promise due today, whatever the scores', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand('follow_up_bump', `p${i}`, 0.9));
    const promise = cand('action_item_reminder', 'z', 0.7, { goalRelevance: 1 });
    const sel = selectForBrief([...many, promise], new Map(), 7);
    expect(sel.some((s) => s.kind === 'action_item_reminder')).toBe(true);
  });
});

describe('offered intros (EG-08)', () => {
  const now = at('2026-10-06T14:00:00Z');
  const sofia = person('Sofia', { relationshipType: 'mentor', currentOrganizationRaw: 'Figma' });
  const nurturing = chat('cs', 'Sofia', { stage: 'nurturing', lastOutboundAt: '2026-08-17T13:00:00Z' });
  const offer = (ago: number) =>
    fact(
      'f1',
      'Sofia',
      'offer',
      'Happy to intro me to their PM lead.',
      new Date(now.getTime() - ago * D).toISOString(),
    );

  it('reads who the intro is to', () => {
    expect(introTarget('Happy to intro me to their PM lead.')).toEqual({
      phrase: 'their PM lead',
      name: 'your PM lead',
    });
    expect(introTarget('Sam offered to connect me with Priya on the growth team').name).toBe(
      'Priya on the growth team',
    );
    expect(introTarget('Happy to help however I can').name).toBe('the person you mentioned');
  });

  it('follows up on an intro offered a week or more ago that has not happened', () => {
    const cands = generateCandidates(
      input(now, { people: [sofia], chats: [nurturing], factsByPerson: new Map([['Sofia', [offer(20)]]]) }),
    );
    const fu = cands.find((x) => x.kind === 'intro_request')!;
    expect(fu.dedupeKey).toBe('introfu:f1');
    expect(fu.reasonText).toBe(
      'Sofia offered to introduce you to their PM lead 20 days ago; follow up with a blurb they can forward',
    );
    expect((fu.payload.target as { name: string; offered: boolean }).offered).toBe(true);
    expect(isRuleSuggestion({ kind: 'intro_request', dedupeKey: fu.dedupeKey })).toBe(true);
    expect(isRuleSuggestion({ kind: 'intro_request', dedupeKey: 'intro:p1:t1' })).toBe(false);
    // the intro offer is not a "how did that go?" hook for the check-in
    const n = cands.find((x) => x.kind === 'nurture_checkin');
    expect(n?.signals.hookId).toBeUndefined();
  });

  it('waits a week, and stops once the intro happened', () => {
    const fresh = generateCandidates(
      input(now, { people: [sofia], chats: [nurturing], factsByPerson: new Map([['Sofia', [offer(3)]]]) }),
    );
    expect(fresh.some((x) => x.kind === 'intro_request')).toBe(false);
    const introduced = chat('cp', 'pm', {
      stage: 'identified',
      referrerPersonId: 'Sofia',
      createdAt: new Date(now.getTime() - 5 * D).toISOString(),
    });
    const done = generateCandidates(
      input(now, {
        people: [sofia, person('pm')],
        chats: [nurturing, introduced],
        factsByPerson: new Map([['Sofia', [offer(20)]]]),
      }),
    );
    expect(done.some((x) => x.kind === 'intro_request')).toBe(false);
  });
});

describe('referral timing and status news (EG-09)', () => {
  const now = at('2026-10-06T14:00:00Z');
  const dana = person('Dana', { currentOrganizationRaw: 'Stripe', strength: 0.6 });
  const settled = chat('cd', 'Dana', { stage: 'followed_up', followedUpAt: '2026-09-25T14:00:00Z' });
  const tc = (extra: Partial<TargetCompany>): TargetCompany =>
    ({
      id: 'tc1',
      userId: 'u',
      nameRaw: 'Stripe',
      priority: 1,
      status: 'researching',
      ...extra,
    }) as TargetCompany;

  it('asks for the referral before the application when the deadline is within a month', () => {
    const soon = generateCandidates(
      input(now, {
        people: [dana],
        chats: [settled],
        targetCompanies: [tc({ deadline: new Date(now.getTime() + 25 * D).toISOString() })],
      }),
    );
    const ask = soon.find((x) => x.kind === 'ask_referral')!;
    expect(ask.reasonText).toBe('Stripe closes in 25 days; ask Dana for a referral before you apply');
    const noDeadline = generateCandidates(
      input(now, { people: [dana], chats: [settled], targetCompanies: [tc({})] }),
    );
    expect(noDeadline.some((x) => x.kind === 'ask_referral')).toBe(false);
    const offered = generateCandidates(
      input(now, {
        people: [{ ...dana, strength: 0.2 }],
        chats: [settled],
        targetCompanies: [tc({})],
        factsByPerson: new Map([
          [
            'Dana',
            [fact('f2', 'Dana', 'offer', 'Happy to refer you when you apply.', '2026-09-24T14:00:00Z')],
          ],
        ]),
      }),
    );
    expect(offered.find((x) => x.kind === 'ask_referral')?.reasonText).toBe(
      'Dana offered to refer you; ask before you apply to Stripe',
    );
  });

  it('turns a status change into one update per person who helped there, and mentors for an offer', () => {
    const mentor = person('Sofia', { relationshipType: 'mentor', currentOrganizationRaw: 'Figma' });
    const mentorChat = chat('cs', 'Sofia', { stage: 'nurturing' });
    const changed = new Date(now.getTime() - 2 * D).toISOString();
    const run = (
      status: TargetCompany['status'],
      statusChangedAt = changed,
      lastTalk = '2026-09-20T14:00:00Z',
    ) =>
      generateCandidates(
        input(now, {
          people: [dana, mentor],
          chats: [settled, mentorChat],
          targetCompanies: [tc({ status, statusChangedAt })],
          lastConversationByPerson: new Map([
            ['Dana', lastTalk],
            ['Sofia', '2026-09-01T14:00:00Z'],
          ]),
          recentlyContacted: new Set(['Dana', 'Sofia']),
        }),
      ).filter((x) => x.dedupeKey.startsWith('status:'));
    const applied = run('interviewing');
    expect(applied.map((x) => x.personId)).toEqual(['Dana']);
    expect(applied[0]!.payload.update).toBe("I'm now interviewing with Stripe");
    expect(applied[0]!.reasonText).toBe("You're interviewing at Stripe; tell Dana, who helped you get there");
    const offer = run('offer');
    expect(offer.map((x) => x.personId).sort()).toEqual(['Dana', 'Sofia']);
    expect(run('applied', new Date(now.getTime() - 30 * D).toISOString())).toEqual([]);
    expect(run('applied', changed, new Date(now.getTime() - 1 * D).toISOString())).toEqual([]);
  });

  it('drafts the update and the offered-intro follow-up cleanly', () => {
    const ctx = (over: Partial<DraftContext>): DraftContext => ({
      user: {
        firstName: 'Alex',
        fullName: 'Alex Rivera',
        school: 'Cornell University',
        majors: ['Computer Science'],
        cycleLabel: 'Summer 2027 internship',
        targetFunctions: ['swe'],
        timezone: TZ,
      },
      styleCard: defaultStyleCard('warm', 'Alex'),
      person: {
        firstName: 'Sofia',
        fullName: 'Sofia Bennett',
        title: 'Product Designer',
        org: 'Figma',
        relationshipType: 'mentor',
        strength: 0.6,
      },
      facts: [],
      kind: 'nurture',
      channel: 'gmail',
      now,
      seed: 'sofia',
      chat: { completedAt: '2026-08-16T16:30:00Z', stage: 'nurturing' },
      ...over,
    });
    const update = generateDraft(
      ctx({
        update: 'I received an offer from Stripe, and I wanted to thank you for your help along the way',
      }),
    );
    expect(update.needsInput).toEqual([]);
    expect(update.body).toMatch(/offer from Stripe/);
    const intro = ctx({
      kind: 'intro_request',
      target: { name: 'your PM lead', firstName: 'your PM lead', org: 'Figma', offered: true },
    });
    const d = generateDraft(intro);
    expect(d.body).toMatch(/you kindly offered to introduce me to your PM lead/);
    expect(d.body).not.toMatch(/[–—!]/);
    const issues = validateDraft(d, {
      kind: 'intro_request',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Sofia',
      recipientFullName: 'Sofia Bennett',
    });
    expect(isBlocked(issues)).toBe(false);
  });
});

describe('nurture without a stored hook (EG-19)', () => {
  it('suggests a plain update to a quiet mentor and leaves the update to the student', () => {
    const now = at('2026-10-06T14:00:00Z');
    const mentor = person('Sofia', { relationshipType: 'mentor' });
    const cands = generateCandidates(
      input(now, {
        people: [mentor],
        chats: [chat('cs', 'Sofia', { stage: 'nurturing' })],
        lastConversationByPerson: new Map([['Sofia', new Date(now.getTime() - 97 * D).toISOString()]]),
      }),
    );
    const n = cands.find((x) => x.kind === 'nurture_checkin')!;
    expect(n.reasonText).toBe(
      '97 days since your last conversation; a short update on your search keeps it warm',
    );
    expect(n.payload.needsUpdate).toBe(true);
  });
});

describe('warm-up readiness (SND-15)', () => {
  const start = at('2026-10-05T14:00:00Z');
  it('does not call a skipped warm-up done', () => {
    const plan = buildWarmUpPlan('dana', start, 4);
    for (const a of plan.actions) a.skippedAt = new Date(start.getTime() + 5 * 60_000).toISOString();
    const prog = warmUpProgress(plan, new Date(start.getTime() + 10 * 60_000));
    expect(prog.ready).toBe(true);
    expect(prog.skippedAll).toBe(true);
    const dana = person('Dana');
    const c = chat('cw', 'Dana', { stage: 'warming', warmUp: plan });
    const cands = generateCandidates(
      input(new Date(start.getTime() + 10 * 60_000), { people: [dana], chats: [c] }),
    );
    expect(cands.find((x) => x.kind === 'new_outreach')?.reasonText).toBe(
      'You skipped the warm-up. Message Dana without it?',
    );
  });

  it('spreads the activity over days even when every action is done in ten minutes', () => {
    const plan = buildWarmUpPlan('dana', start, 4);
    for (const a of plan.actions) a.doneAt = new Date(start.getTime() + 10 * 60_000).toISOString();
    expect(warmUpProgress(plan, new Date(start.getTime() + 20 * 60_000)).ready).toBe(false);
    expect(warmUpProgress(plan, new Date(start.getTime() + 30 * H)).ready).toBe(false);
    const prog = warmUpProgress(plan, new Date(start.getTime() + 2 * D));
    expect(prog.ready).toBe(true);
    expect(prog.done).toBe(3);
  });
});

describe('history wording (DR-13)', () => {
  const now = at('2026-10-06T14:00:00Z');
  it('only calls interactions recent within 90 days and dates old ones in words', () => {
    expect(lastContactPhrase([], now, TZ)).toBe('No interactions yet.');
    expect(
      lastContactPhrase(
        [
          { kind: 'email_in', occurredAt: '2026-10-04T14:00:00Z' },
          { kind: 'meeting', occurredAt: '2026-09-01T14:00:00Z' },
        ],
        now,
        TZ,
      ),
    ).toBe('You have 2 interactions in the last 90 days, most recently 2 days ago.');
    expect(
      lastContactPhrase([{ kind: 'linkedin_connected', occurredAt: '2025-11-10T14:00:00Z' }], now, TZ),
    ).toBe('You last connected on LinkedIn last November.');
    expect(lastContactPhrase([{ kind: 'meeting', occurredAt: '2025-09-10T14:00:00Z' }], now, TZ)).toBe(
      'You last met in September 2025.',
    );
    expect(lastContactPhrase([{ kind: 'email_cc', occurredAt: '2024-03-10T14:00:00Z' }], now, TZ)).toBe(
      'You were last on the same email thread in March 2024.',
    );
    expect(monthPhrase('2026-03-10T14:00:00Z', now, TZ)).toBe('in March');
    expect(monthPhrase('2026-09-10T14:00:00Z', now, TZ)).toBe('last month');
  });

  it('clips quoted text on a word boundary', () => {
    expect(clip('Sofia said the team is launching a new product in November and is hiring', 60)).toBe(
      'Sofia said the team is launching a new product in...',
    );
    expect(clip('launching in November.', 60)).toBe('launching in November');
  });
});
