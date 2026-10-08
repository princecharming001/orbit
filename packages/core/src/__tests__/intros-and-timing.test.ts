import { describe, expect, it } from 'vitest';
import { type DraftContext, generateDraft } from '../drafts/templates';
import { isBlocked, validateDraft } from '../drafts/validate';
import { inferEdges } from '../graph/edges';
import { detectIntroduction } from '../pipeline/introductions';
import { decideTransition } from '../pipeline/transitions';
import { defaultStyleCard } from '../style/card';
import {
  addBusinessDays,
  generateCandidates,
  isQuietDay,
  parseReturnDate,
  type RuleInput,
  selectForBrief,
} from '../suggestions/rules';
import type { CoffeeChat, EmailMessage, EmailThread, Person, PersonFact, UserSettings } from '../types';

const TZ = 'America/New_York';
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
    emails: [`${id.toLowerCase()}@example.com`],
    primaryEmail: `${id.toLowerCase()}@example.com`,
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

const draftCtx = (kind: DraftContext['kind'], extra: Partial<DraftContext> = {}): DraftContext => ({
  user: {
    firstName: 'Alex',
    fullName: 'Alex Rivera',
    school: 'Cornell University',
    gradYear: 2027,
    majors: ['Computer Science'],
    cycleLabel: 'Summer 2027 internship',
    targetFunctions: ['software engineering'],
    timezone: 'America/New_York',
  },
  styleCard: defaultStyleCard('warm', 'Alex'),
  person: {
    firstName: 'Hannah',
    fullName: 'Hannah Kim',
    title: 'Product Manager',
    org: 'Figma',
    relationshipType: 'unknown',
    strength: 0.3,
  },
  facts: [],
  kind,
  channel: 'gmail',
  now: new Date('2026-10-09T13:00:00Z'), // a Friday
  ...extra,
});

describe('a missed proposed time (PS-2 follow-up)', () => {
  it('apologises for the missed slot before offering new times', () => {
    const out = generateDraft(
      draftCtx('schedule', {
        proposedWindows: [{ startIso: '2026-10-12T14:00:00Z' }, { startIso: '2026-10-13T14:00:00Z' }],
        thread: { lastSignal: 'scheduling_proposal' },
        missedProposal: { raw: 'Thursday at 2pm', startIso: '2026-10-08T18:00:00Z', reason: 'passed' },
      }),
    );
    expect(out.body).toContain("I'm sorry I didn't get back to you in time for Thursday, Oct 8 at 2pm.");
    expect(out.body).toContain(
      'Would either of these work instead? Monday, Oct 12 at 10am or Tuesday, Oct 13 at 10am (EDT).',
    );
    expect(out.body).not.toMatch(/that would be great/);
    const issues = validateDraft(out, {
      kind: 'schedule',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Hannah',
      recipientFullName: 'Hannah Kim',
    });
    expect(isBlocked(issues)).toBe(false);
  });

  it('names a calendar conflict instead of apologising', () => {
    const out = generateDraft(
      draftCtx('schedule', {
        proposedWindows: [{ startIso: '2026-10-12T14:00:00Z' }],
        missedProposal: { raw: 'Monday at 9am', startIso: '2026-10-12T13:00:00Z', reason: 'busy' },
      }),
    );
    expect(out.body).toContain(
      'Thank you for suggesting Monday, Oct 12 at 9am. Unfortunately I have a conflict then.',
    );
    expect(out.body).toContain('Would Monday, Oct 12 at 10am (EDT) work instead?');
  });
});

describe('quiet days follow the setting (EG-11 follow-up)', () => {
  it('keeps bumps and outreach in a weekend brief when the student has no quiet days', () => {
    const sunday = at('2026-10-11T15:00:00Z');
    expect(isQuietDay(sunday, settings, TZ)).toBe(false);
    const cands = [
      { kind: 'follow_up_bump', personId: 'a', urgency: 0.8 },
      { kind: 'new_outreach', personId: 'b', urgency: 0.5 },
    ].map(
      (c) =>
        ({
          ...c,
          dedupeKey: `${c.kind}:${c.personId}`,
          reasonText: '',
          signals: {},
          payload: {},
          goalRelevance: 0.6,
          confidence: 1,
        }) as Parameters<typeof selectForBrief>[0][number],
    );
    const sel = selectForBrief(cands, new Map(), 7, { quiet: isQuietDay(sunday, settings, TZ) });
    expect(sel.map((s) => s.kind).sort()).toEqual(['follow_up_bump', 'new_outreach']);
    // a student who keeps weekends quiet gets only the time-bound items
    const quiet = selectForBrief(cands, new Map(), 7, {
      quiet: isQuietDay(sunday, { quietDays: [0, 6] }, TZ),
    });
    expect(quiet).toEqual([]);
  });
});

describe('nurture claims only real conversations (EG-19 follow-up)', () => {
  const now = at('2026-10-06T14:00:00Z');
  const hook = (pid: string): PersonFact =>
    ({
      id: 'h1',
      userId: 'u',
      personId: pid,
      type: 'hook',
      text: 'launching the new design system next month',
      occurredAt: '2026-09-20T12:00:00Z',
      createdAt: '2026-09-20T12:00:00Z',
      confidence: 1,
    }) as PersonFact;

  it('never says "999 days" when there is no interaction data', () => {
    const p = person('Nina', { relationshipType: 'mentor' });
    const none = generateCandidates(
      input(now, { people: [p], chats: [chat('c1', 'Nina', { stage: 'nurturing' })] }),
    );
    expect(none.some((x) => x.kind === 'nurture_checkin')).toBe(false);
    const withHook = generateCandidates(
      input(now, {
        people: [p],
        chats: [chat('c1', 'Nina', { stage: 'nurturing' })],
        factsByPerson: new Map([['Nina', [hook('Nina')]]]),
      }),
    );
    const n = withHook.find((x) => x.kind === 'nurture_checkin')!;
    expect(n.reasonText).toBe(
      'You have a reason to check in with Nina: "launching the new design system next month"',
    );
    expect(n.reasonText).not.toMatch(/999/);
  });

  it('does not call a LinkedIn connection a conversation, nor send a no-hook update after one', () => {
    const p = person('Omar', { relationshipType: 'mentor', lastInteractionAt: '2026-06-01T12:00:00Z' });
    const plain = generateCandidates(
      input(now, { people: [p], chats: [chat('c1', 'Omar', { stage: 'nurturing' })] }),
    );
    expect(plain.some((x) => x.kind === 'nurture_checkin')).toBe(false);
    const hooked = generateCandidates(
      input(now, {
        people: [p],
        chats: [chat('c1', 'Omar', { stage: 'nurturing' })],
        factsByPerson: new Map([['Omar', [hook('Omar')]]]),
      }),
    ).find((x) => x.kind === 'nurture_checkin')!;
    expect(hooked.reasonText).toMatch(/^127 days since you were last in touch; something to ask about/);
  });

  it('counts the completed chat itself as the last conversation', () => {
    const p = person('Pia', { relationshipType: 'mentor' });
    const n = generateCandidates(
      input(now, {
        people: [p],
        chats: [chat('c1', 'Pia', { stage: 'nurturing', completedAt: '2026-08-07T14:00:00Z' })],
      }),
    ).find((x) => x.kind === 'nurture_checkin')!;
    expect(n.reasonText).toBe(
      '60 days since your last conversation; a short update on your search keeps you in touch',
    );
  });
});

describe('out-of-office ranges and the winter freeze (EG-12 follow-up)', () => {
  const sent = at('2026-10-02T16:00:00Z'); // Friday
  const day = (d?: Date) => d?.toISOString().slice(0, 10);

  it('reads the end of a date range and a bare day of the month', () => {
    expect(
      day(parseReturnDate('I am out of the office from Oct 5 to Oct 12 with limited email.', sent, TZ)),
    ).toBe('2026-10-13');
    expect(day(parseReturnDate('Away between 10/5 and 10/9, back after that.', sent, TZ))).toBe('2026-10-10');
    expect(day(parseReturnDate('Back in the office on the 12th.', sent, TZ))).toBe('2026-10-12');
    // a day of the month already behind us is next month's
    expect(day(parseReturnDate('Back in the office on the 1st.', sent, TZ))).toBe('2026-11-01');
    expect(day(parseReturnDate('Back on the 4th.', at('2026-12-20T16:00:00Z'), TZ))).toBe('2027-01-04');
  });

  it('reads month-relative returns and never mistakes "month" for Monday (L11)', () => {
    expect(day(parseReturnDate('I am out of the office until the end of the month.', sent, TZ))).toBe(
      '2026-11-01',
    );
    expect(day(parseReturnDate('I am on parental leave through the end of the month.', sent, TZ))).toBe(
      '2026-11-01',
    );
    expect(day(parseReturnDate('I will be back at the start of next month.', sent, TZ))).toBe('2026-11-01');
    expect(day(parseReturnDate('On leave between now and the end of the month.', sent, TZ))).toBe(
      '2026-11-01',
    );
    expect(day(parseReturnDate('Out until the end of next month.', sent, TZ))).toBe('2026-12-01');
    expect(day(parseReturnDate('On leave through the end of October.', sent, TZ))).toBe('2026-11-01');
    expect(day(parseReturnDate('On leave through the end of December.', sent, TZ))).toBe('2027-01-01');
    expect(day(parseReturnDate('Back at the beginning of November.', sent, TZ))).toBe('2026-11-01');
    // words that merely start like a weekday or a month are not dates
    expect(parseReturnDate('Back to monitoring email soon.', sent, TZ)).toBeUndefined();
    expect(
      parseReturnDate('Back after a satisfying break, thanks for your patience.', sent, TZ),
    ).toBeUndefined();
    // the full and short weekday names still work
    expect(day(parseReturnDate('Back on Mon.', sent, TZ))).toBe('2026-10-05');
    expect(day(parseReturnDate('Back Tues.', sent, TZ))).toBe('2026-10-06');
  });

  it('reads a range written with a bare hyphen, and "until" as the day they are back', () => {
    expect(day(parseReturnDate('Out of office from Oct 5-Oct 12.', sent, TZ))).toBe('2026-10-13');
    expect(day(parseReturnDate('Away from 10/5-10/9 with no email.', sent, TZ))).toBe('2026-10-10');
    expect(day(parseReturnDate('Out from Oct 5 until Oct 12.', sent, TZ))).toBe('2026-10-12');
    expect(day(parseReturnDate('Out of office from Oct 5 - Oct 12.', sent, TZ))).toBe('2026-10-13');
    // the hyphen inside a word is not a range: "until" still names the day they are back
    expect(
      day(parseReturnDate("I'm away from the office with no e-mail access until Oct 12.", sent, TZ)),
    ).toBe('2026-10-12');
    expect(day(parseReturnDate('Away from my desk and e-mail until Oct 12.', sent, TZ))).toBe('2026-10-12');
  });

  it('lets the second bump come due before a freeze-spanning silence closes the thread', () => {
    const firstBump = at('2026-12-15T15:00:00Z');
    const secondDue = addBusinessDays(firstBump, 8, TZ);
    expect(day(secondDue)).toBe('2027-01-08');
    // on Jan 5 the thread has been silent 21 calendar days but only 5 business days: not closed
    const jan5 = at('2027-01-05T15:00:00Z');
    expect(
      decideTransition('outreach_sent', {
        type: 'timer_no_response',
        bumps: 1,
        maxBumps: 2,
        daysSilent: (jan5.getTime() - firstBump.getTime()) / D,
        businessDaysSilent: 5,
      }),
    ).toBeUndefined();
    expect(
      decideTransition('outreach_sent', {
        type: 'timer_no_response',
        bumps: 1,
        maxBumps: 2,
        daysSilent: 30,
        businessDaysSilent: 15,
      })?.to,
    ).toBe('no_response');
  });
});

describe('email introductions (EG-08)', () => {
  const alex = person('Alex');
  const sana = person('Sana');
  const msg = (extra: Partial<EmailMessage> = {}): EmailMessage =>
    ({
      id: 'm1',
      userId: 'u',
      threadId: 't1',
      externalMessageId: 'x1',
      direction: 'inbound',
      fromEmail: 'alex@example.com',
      fromPersonId: 'Alex',
      toEmails: ['me@school.edu'],
      ccEmails: ['sana@example.com'],
      subject: 'Intro: you two should meet',
      bodyText: "Jordan, meet Sana. Sana runs a team you'd find interesting.",
      sentAt: '2026-10-05T15:00:00Z',
      headers: {},
      isAutomated: false,
      ...extra,
    }) as EmailMessage;

  it('finds who was introduced, and only when the sender names them', () => {
    expect(detectIntroduction(msg(), [alex, sana], ['me@school.edu'])).toEqual({
      introducerId: 'Alex',
      introducedIds: ['Sana'],
      messageId: 'm1',
      at: '2026-10-05T15:00:00Z',
    });
    // a CC without an introduction is just a CC
    expect(
      detectIntroduction(
        msg({ subject: 'Notes from today', bodyText: 'Thanks both, notes attached.' }),
        [alex, sana],
        ['me@school.edu'],
      ),
    ).toBeUndefined();
    // introduction wording, but the CC'd person is never named
    expect(
      detectIntroduction(
        msg({ bodyText: 'Great to meet you at the fair.' }),
        [alex, sana],
        ['me@school.edu'],
      ),
    ).toBeUndefined();
    // the student's own intro of two others is not an intro to the student
    expect(
      detectIntroduction(msg({ direction: 'outbound' }), [alex, sana], ['me@school.edu']),
    ).toBeUndefined();
  });

  it('does not read ordinary "meet" wording as an introduction (L10)', () => {
    const none = (bodyText: string, subject = 'Next week') =>
      expect(detectIntroduction(msg({ subject, bodyText }), [alex, sana], ['me@school.edu'])).toBeUndefined();
    none('Hi Jordan, Sana and I would love to meet with you next week. Does Tuesday work?');
    none('Hi Jordan and Sana, great to meet you both at the career fair.');
    none('Can we meet Thursday? Sana will send an invite.');
    none('Thanks for introducing yourselves at the fair, Sana and Jordan.');
    none('Sana will send the invite for our intro call on Thursday.', 'Intro call');
    // "introduc*" that is not aimed at people, and "meet" that is not pointed at the person
    none('Sana and I will send you an introduction to the program soon.');
    none('We introduced a new program this year. Sana will send an invite.');
    none('Did you get to meet Sana at the fair?');
    // an answer in an intro thread: the subject is the thread's, and thanking for the intro is not making one
    none('Thanks Sana. Jordan, happy to chat. Would Thursday at 2pm work?', 'Re: Intro: Jordan <> Sana');
    none('Thanks Sana for the intro. Jordan, happy to chat.', 'Re: Intro: Jordan <> Sana');
    none('Thank you for making the introduction, Sana.', 'Re: Hello');
    // the real thing, in its usual shapes
    const some = (bodyText: string, subject = 'Hello') =>
      expect(
        detectIntroduction(msg({ subject, bodyText }), [alex, sana], ['me@school.edu'])?.introducedIds,
      ).toEqual(['Sana']);
    some("Jordan, meet Sana. Sana runs a team you'd find interesting.");
    some('Sana, meet Jordan, the student I mentioned.');
    some("I'd love for you to meet Sana, who leads design at Figma.");
    some('Introducing you to Sana, who leads design at Figma.');
    some('Happy to connect you with Sana; she knows the team well.');
    some('Sana leads design at Figma and you two should talk.');
    some('Sana leads design at Figma.', 'Intro: Jordan <> Sana');
    some('Meet Sana, who leads design at Figma.');
    some("I'd like to introduce Sana, who leads design at Figma.");
    some('Making the introduction here: Sana leads design at Figma.', 'Re: Design roles');
  });

  it('turns a recorded introduction into an introduced_by edge', () => {
    const thread = {
      id: 't1',
      userId: 'u',
      externalThreadId: 'x',
      messageCount: 1,
      participantEmails: [],
      participantPersonIds: ['Alex', 'Sana'],
      isNetworking: true,
      introduction: { introducerId: 'Alex', introducedIds: ['Sana'], messageId: 'm1', at: '2026-10-05' },
    } as EmailThread;
    const edges = inferEdges({
      userId: 'u',
      people: [alex, sana],
      affiliations: [],
      organizations: new Map(),
      threads: [thread],
      events: [],
    });
    const e = edges.find((x) => x.type === 'introduced_by')!;
    expect(e.evidence.text).toBe('Alex introduced you to Sana');
    expect(e.evidence.introducerId).toBe('Alex');
  });

  it('suggests answering a fresh intro, as an obligation, and drafts it as a follow-up to the intro', () => {
    const now = at('2026-10-07T14:00:00Z');
    const c = chat('ci', 'Sana', {
      source: 'reach',
      referrerPersonId: 'Alex',
      referrerName: 'Alex',
      introducedAt: '2026-10-05T15:00:00Z',
    });
    const cands = generateCandidates(input(now, { people: [alex, sana], chats: [c] }));
    const r = cands.find((x) => x.dedupeKey === 'introreply:ci')!;
    expect(r.kind).toBe('new_outreach');
    expect(r.reasonText).toBe('Alex introduced you to Sana 2 days ago; reply while the intro is fresh');
    const cold = { ...r, dedupeKey: 'new:x', personId: 'x', urgency: 0.95, signals: {} };
    const sel = selectForBrief([cold, r], new Map(), 1);
    expect(sel[0]?.dedupeKey).toBe('introreply:ci');
    // stale after two weeks, and gone once something was sent
    expect(
      generateCandidates(input(at('2026-10-25T14:00:00Z'), { people: [alex, sana], chats: [c] })).some(
        (x) => x.dedupeKey === 'introreply:ci',
      ),
    ).toBe(false);
    const draft = generateDraft(
      draftCtx('outreach', {
        person: {
          firstName: 'Sana',
          fullName: 'Sana Lee',
          org: 'Sana Corp',
          relationshipType: 'unknown',
          strength: 0.1,
        },
        chat: { referrerName: 'Alex', introducedAt: '2026-10-05T15:00:00Z', stage: 'identified' },
      }),
    );
    // a reply-all on the introduction: the introducer is thanked and moved to bcc, then the person is greeted
    // (drafts panel round 2: a new thread "Following up on Alex's introduction" is not how it is done)
    expect(draft.body).toMatch(/^Thanks for the introduction, Alex \(moving you to bcc\)\.\n\nHi Sana,\n\n(It's )?[Gg]reat to meet you\./);
    expect(draft.body).not.toMatch(/said to say hello/);
    expect(draft.introReply).toEqual({ bcc: 'Alex' });
    expect(draft.subject).toBeUndefined();
    expect(draft.opening).not.toMatch(/bcc/);
  });
});
