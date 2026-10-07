import { describe, expect, it } from 'vitest';
import { pointPhrase, roleNoun } from '../drafts/phrasing';
import { financeFirmKind, sectorOf, seniorityOf, yearLabel } from '../drafts/sector';
import {
  BANNED_PHRASES,
  bookingLinkIn,
  clause,
  contextText,
  type DraftContext,
  deriveConnection,
  draftWarmUpComment,
  fitNote,
  generateDraft,
  LINKEDIN_NOTE_MAX,
  MAX_WORDS,
  overlapsBusy,
  promiseLine,
  proposeWindows,
  schoolShort,
  sinceLabel,
  targetLabel,
  whenLabel,
  wordsIn,
} from '../drafts/templates';
import { isBlocked, unsupportedDetails, validateDraft } from '../drafts/validate';
import { declineReengage } from '../pipeline/transitions';
import { defaultStyleCard } from '../style/card';
import type { PersonFact } from '../types';

const NOW = new Date('2026-10-06T14:00:00Z');
const fact = (id: string, type: PersonFact['type'], text: string): PersonFact => ({
  id,
  userId: 'u',
  personId: 'p',
  type,
  text,
  sourceTable: 'notes',
  sourceId: 'n',
  confidence: 0.8,
  occurredAt: '2026-09-30T00:00:00Z',
  createdAt: '',
});
const FACTS = [
  fact('f1', 'advice', 'the key is showing how you handled ambiguity in one project story'),
  fact('f2', 'offer', 'offered to refer me when the posting goes up'),
  fact('f3', 'hook', 'they are hiring interns in January'),
];

const base = (over: Partial<DraftContext> = {}): DraftContext => ({
  user: {
    firstName: 'Alex',
    lastName: 'Rivera',
    fullName: 'Alex Rivera',
    school: 'Cornell University',
    gradYear: 2028,
    degree: 'BS',
    majors: ['Computer Science'],
    cycleLabel: 'Summer 2027 internship',
    targetFunctions: ['swe'],
    timezone: 'America/New_York',
    credibility: 'built a campus marketplace used by 800 students',
    pastOrgs: ['Brex'],
  },
  styleCard: defaultStyleCard('warm', 'Alex'),
  person: {
    firstName: 'Priya',
    lastName: 'Patel',
    fullName: 'Priya Patel',
    title: 'Product Manager',
    org: 'Figma',
    isAlumni: true,
    relationshipType: 'alumni',
    strength: 0.4,
  },
  facts: [],
  kind: 'outreach',
  channel: 'gmail',
  now: NOW,
  seed: 'priya',
  ...over,
});
const check = (ctx: DraftContext, extra: Partial<Parameters<typeof validateDraft>[1]> = {}) => {
  const d = generateDraft(ctx);
  const issues = validateDraft(d, {
    kind: ctx.kind,
    facts: ctx.facts,
    allowedUrls: [ctx.user.schedulingLink ?? ''],
    recipientFirstName: ctx.person.firstName,
    recipientFullName: ctx.person.fullName,
    channel: ctx.channel,
    context: contextText(ctx),
    ...extra,
  });
  return { d, issues, blocking: issues.filter((i) => i.blocking) };
};

describe('sector and seniority', () => {
  it('classifies', () => {
    expect(sectorOf({ title: 'Investment Banking Analyst', org: 'Goldman Sachs' })).toBe('finance');
    expect(sectorOf({ title: 'Associate Consultant', org: 'Bain & Company' })).toBe('consulting');
    expect(sectorOf({ title: 'Software Engineer', org: 'Stripe' })).toBe('tech');
    expect(sectorOf({ title: 'Software Engineer', org: 'Goldman Sachs' })).toBe('tech');
    expect(sectorOf({ title: 'Marketing Manager', org: 'Acme' }, ['ib'])).toBe('finance');
    expect(seniorityOf('Managing Director')).toBe('exec');
    expect(seniorityOf('Vice President, M&A')).toBe('senior');
    expect(seniorityOf('Analyst')).toBe('junior');
    expect(yearLabel(2028, 'BS', NOW)).toBe('junior');
    expect(yearLabel(2027, 'BS', NOW)).toBe('senior');
    expect(yearLabel(2028, 'MBA', NOW)).toBe('first-year MBA student');
  });
});

describe('connection derivation', () => {
  it('prefers referral, then event, warm-up, alumni, shared employer, transition, hook', () => {
    // a completed warm-up (a post the student engaged with) beats a shared school
    expect(
      deriveConnection(base({ chat: { warmUpNote: 'migrating off a monolith', warmUpDone: 3 } }))!.kind,
    ).toBe('warmup');
    expect(deriveConnection(base({ chat: { referrerName: 'Mei Chen' } }))!.kind).toBe('referral');
    expect(
      deriveConnection(
        base({
          person: { ...base().person, isAlumni: false },
          facts: [fact('e', 'hook', 'spoke at the Cornell Fintech Club panel on Tuesday')],
        }),
      )!.kind,
    ).toBe('event');
    expect(deriveConnection(base())!.kind).toBe('alumni');
    expect(
      deriveConnection(
        base({
          person: { ...base().person, isAlumni: false },
          chat: { warmUpNote: 'migrating off a monolith', warmUpDone: 2 },
        }),
      )!.kind,
    ).toBe('warmup');
    expect(
      deriveConnection(
        base({
          person: { ...base().person, isAlumni: false, previousOrg: 'Stripe', previousTitle: 'Analyst' },
        }),
      )!.kind,
    ).toBe('transition');
    expect(
      deriveConnection(base({ person: { ...base().person, isAlumni: false, previousOrg: 'Brex' } }))!.kind,
    ).toBe('shared_employer');
    expect(
      deriveConnection(base({ person: { ...base().person, isAlumni: false }, facts: [FACTS[2]!] }))!.kind,
    ).toBe('hook');
    expect(deriveConnection(base({ person: { ...base().person, isAlumni: false } }))).toBeUndefined();
    expect(
      deriveConnection(
        base({
          person: { ...base().person, isAlumni: false },
          facts: [fact('c', 'connection', 'we were both in the Cornell Data Science club')],
        }),
      )!.kind,
    ).toBe('user_supplied');
  });
});

describe('outreach', () => {
  it('a "Why them" line typed as a bare phrase becomes a sentence, and the situation keeps what you are recruiting for', () => {
    const r = check(
      base({
        person: { ...base().person, isAlumni: false },
        facts: [fact('c', 'connection', 'Your talk at the Berkeley ML meetup on eval tooling')],
      }),
    );
    expect(r.d.body).toMatch(/I'm writing because of your talk at the Berkeley ML meetup on eval tooling\./);
    expect(r.d.body).not.toMatch(/,\n\nYour talk/);
    expect(r.d.body).toMatch(/recruiting for .* this cycle/);
    // a full sentence is kept as the student wrote it
    const s = check(
      base({
        person: { ...base().person, isAlumni: false },
        facts: [fact('c', 'connection', 'we were both in the Cornell Data Science club')],
      }),
    );
    expect(s.d.body).toMatch(/We were both in the Cornell Data Science club\./);
  });
  it('the missing line is named "Why them" in the draft', () => {
    const r = check(base({ person: { ...base().person, isAlumni: false } }));
    expect(r.d.body).toMatch(/\[Why them: one line only true of /);
  });
  it('cold outreach without any link is gated, not drafted generically', () => {
    const r = check(base({ person: { ...base().person, isAlumni: false } }));
    expect(r.d.needsInput).toContain('connection');
    expect(isBlocked(r.issues)).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain('needs_connection');
  });
  it('alumni outreach passes every check and reads as a person', () => {
    const r = check(base());
    expect(r.blocking, JSON.stringify(r.issues)).toEqual([]);
    expect(r.d.subject!.length).toBeLessThanOrEqual(60);
    // students say "Cornell", not "Cornell University" (DQ-05)
    expect(r.d.body).toMatch(/\bCornell\b/);
    expect(r.d.body).not.toMatch(/Cornell University/);
    expect(r.d.body).toMatch(/20 minutes|20-minute/);
    expect(r.d.body).toMatch(/\?/);
    expect(wordsIn(r.d.body)).toBeLessThanOrEqual(MAX_WORDS.outreach);
    expect(r.d.body).toMatch(/Hi Priya,/);
    expect(r.d.body).toMatch(/Thanks,\nAlex$/);
  });
  it('finance register: five-sentence budget, formal sign-off with school and class year', () => {
    const r = check(
      base({
        person: {
          firstName: 'Daniel',
          fullName: 'Daniel Kim',
          title: 'Investment Banking Analyst',
          org: 'Goldman Sachs',
          group: 'healthcare',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0,
        },
        user: { ...base().user, targetFunctions: ['ib'], majors: ['Economics'] },
      }),
    );
    expect(r.blocking).toEqual([]);
    expect(r.d.sector).toBe('finance');
    expect(r.d.body).toMatch(/Best,\nAlex Rivera\nCornell '28$/);
    expect(r.d.register).toBe('formal');
    expect(r.d.subject).toMatch(/Cornell '28, quick question on Goldman Sachs healthcare/);
    const sentences = r.d.body
      .split('\n')
      .slice(1)
      .join(' ')
      .split(/(?<=[.?])\s+/)
      .filter((s) => s.length > 3 && !/^(Best|Alex|Cornell)/.test(s));
    expect(sentences.length).toBeLessThanOrEqual(7);
  });
  it('exec at a bank gets Dear Full Name; an engineer gets Hi', () => {
    const r = check(
      base({
        person: {
          firstName: 'Sofia',
          fullName: 'Sofia Rossi',
          title: 'Managing Director',
          org: 'Evercore',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0,
        },
      }),
    );
    expect(r.d.body.startsWith('Dear Sofia Rossi,')).toBe(true);
    const t = check(
      base({
        person: {
          firstName: 'Omar',
          fullName: 'Omar Hassan',
          title: 'Senior Software Engineer',
          org: 'Stripe',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0,
        },
      }),
    );
    expect(t.d.body.startsWith('Hi Omar,')).toBe(true);
  });
  it('recruiters get a logistics question, never a coffee-chat ask', () => {
    const r = check(
      base({
        person: {
          firstName: 'Nina',
          fullName: 'Nina Park',
          title: 'University Recruiting Lead',
          org: 'Ramp',
          isAlumni: false,
          relationshipType: 'recruiter',
          strength: 0,
        },
      }),
      {},
    );
    expect(r.d.body).not.toMatch(/minutes/);
    expect(r.d.body).toMatch(/rolling basis|deadline/);
    expect(r.d.needsInput).toEqual([]);
  });
  it('a recruiter message on LinkedIn signs off once, not "Thank you for your time." and then "Thanks"', () => {
    const r = generateDraft(
      base({
        channel: 'linkedin',
        person: {
          firstName: 'Felix',
          fullName: 'Felix Sato',
          title: 'Campus Recruiter',
          org: 'Ramp',
          isAlumni: false,
          relationshipType: 'recruiter',
          strength: 0,
        },
      }),
    );
    expect(r.body).toMatch(/Thanks,\s+\w+\s*$/);
    expect(r.body).not.toMatch(/Thank you for your time/);
  });
  it('transition and referral openers name the fact', () => {
    const t = check(
      base({
        person: { ...base().person, isAlumni: false, previousOrg: 'Stripe', previousTitle: 'Analyst' },
      }),
    );
    expect(t.d.body).toMatch(/analyst at Stripe/);
    expect(t.d.subject).toMatch(/Your move from analyst at Stripe to Figma/);
    const ref = check(
      base({ person: { ...base().person, isAlumni: false }, chat: { referrerName: 'Mei Chen' } }),
    );
    expect(ref.d.body).toMatch(
      /^Hi Priya,\n\nMei Chen (suggested I write to you|mentioned you'd be the right person)/,
    );
    expect(ref.d.subject).toBe('Mei Chen suggested I write to you');
  });
  it('LinkedIn note stays under 300 characters and carries the ask; connected person gets a message instead', () => {
    const n = check(base({ channel: 'linkedin' }));
    expect(n.d.bodyShort!.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
    expect(n.d.bodyShort).toMatch(/Hi Priya, Cornell junior here/);
    expect(n.d.bodyShort).not.toMatch(/fellow|Cornell University/i);
    expect(n.d.bodyShort).toMatch(/20 minutes/);
    expect(n.d.subject).toBeUndefined();
    const m = check(
      base({
        channel: 'linkedin',
        person: { ...base().person, linkedinConnected: true, linkedinConnectedAt: '2026-10-01' },
      }),
    );
    expect(m.d.body).toMatch(/^Hi Priya, thanks for connecting\./);
    // a connection from two years ago is not thanked for connecting
    const old = check(
      base({
        channel: 'linkedin',
        person: { ...base().person, linkedinConnected: true, linkedinConnectedAt: '2024-09-01' },
      }),
    );
    expect(old.d.body).not.toMatch(/thanks for connecting/);
    expect(wordsIn(m.d.body)).toBeLessThanOrEqual(90);
  });
  it('varies openings by seed and avoids a recent opening to the same company', () => {
    const a = generateDraft(base({ seed: 'a' }));
    const b = generateDraft(base({ seed: 'b' }));
    const c = generateDraft(base({ seed: 'c' }));
    expect(new Set([a.opening, b.opening, c.opening]).size).toBeGreaterThanOrEqual(2);
    const avoided = generateDraft(base({ seed: 'a', recentOpenings: [a.opening] }));
    expect(avoided.opening).not.toBe(a.opening);
  });
  it('never contains banned phrases or dashes across the matrix', () => {
    const people = [
      {
        firstName: 'Priya',
        fullName: 'Priya Patel',
        title: 'Product Manager',
        org: 'Figma',
        isAlumni: true,
        relationshipType: 'alumni',
        strength: 0.4,
      },
      {
        firstName: 'Daniel',
        fullName: 'Daniel Kim',
        title: 'Investment Banking Associate',
        org: 'Morgan Stanley',
        group: 'TMT',
        isAlumni: false,
        relationshipType: 'unknown',
        strength: 0,
        previousOrg: 'Lazard',
        previousTitle: 'Analyst',
      },
      {
        firstName: 'Mei',
        fullName: 'Mei Chen',
        title: 'Consultant',
        org: 'Bain & Company',
        group: 'the Chicago office',
        isAlumni: true,
        relationshipType: 'alumni',
        strength: 0.1,
      },
      {
        firstName: 'Omar',
        fullName: 'Omar Hassan',
        title: 'Staff Engineer',
        org: 'Stripe',
        isAlumni: false,
        relationshipType: 'unknown',
        strength: 0.05,
        previousOrg: 'Brex',
      },
      {
        firstName: 'Grace',
        fullName: 'Grace Adeyemi',
        title: 'Product Designer',
        org: 'Linear',
        isAlumni: false,
        relationshipType: 'peer',
        strength: 0.7,
      },
    ];
    const kinds: DraftContext['kind'][] = [
      'outreach',
      'bump',
      'schedule',
      'thank_you',
      'nurture',
      'congratulate',
      'referral_ask',
      'intro_request',
      'reply',
      'report_back',
    ];
    let count = 0;
    for (const p of people)
      for (const kind of kinds)
        for (const channel of ['gmail', 'linkedin'] as const)
          for (const withFacts of [true, false]) {
            const ctx = base({
              person: p,
              kind,
              channel,
              facts: withFacts ? FACTS : [],
              seed: `${p.firstName}${kind}${channel}${withFacts}`,
              bumpNumber: 1,
              proposedWindows: [{ startIso: '2026-10-08T14:00:00Z' }, { startIso: '2026-10-09T18:00:00Z' }],
              thread: {
                firstOutboundAt: '2026-09-28T12:00:00Z',
                proposedTimes:
                  kind === 'reply' ? [{ startIso: '2026-10-08T18:00:00Z', raw: 'Thursday 2pm' }] : [],
                asksOfUser:
                  kind === 'reply' ? ['Could you send your resume?', 'Which teams interest you?'] : [],
              },
              target: {
                name: 'Lucas Fischer',
                firstName: 'Lucas',
                title: 'Engineering Manager',
                org: 'Ramp',
              },
              newAffiliation: { title: 'Senior PM', org: 'Figma' },
              targetCompany: {
                name: p.org,
                roleLabel: 'Software Engineering Intern',
                reqId: '4412',
                applied: kind === 'referral_ask' && channel === 'gmail',
              },
              chat: {
                completedAt: '2026-10-05T15:00:00Z',
                referrerName: kind === 'report_back' ? 'Mei Chen' : undefined,
              },
              reportBack: {
                targetName: 'Lucas Fischer',
                outcome: 'spoke',
                when: 'yesterday',
                line: 'he walked me through how the platform team hires',
              },
              update: kind === 'nurture' ? 'I switched my summer to the ops role you suggested' : undefined,
            });
            const r = check(ctx, { hadConversation: true });
            count++;
            const text = `${r.d.subject ?? ''}\n${r.d.body}\n${r.d.bodyShort ?? ''}`.toLowerCase();
            for (const b of BANNED_PHRASES)
              expect(text, `${kind}/${p.firstName}: banned "${b}"`).not.toContain(b);
            expect(text, `${kind}/${p.firstName}: dash`).not.toMatch(/[—–]/);
            expect(r.d.body, `${kind}/${p.firstName}: name`).toContain(p.firstName);
            const blockers = r.blocking.filter(
              (i) =>
                !(kind === 'outreach' && i.code === 'needs_connection') &&
                !(kind === 'reply' && i.code === 'needs_input') &&
                // a thank-you with nothing they said asks the student for one thing (EG-15)
                !(kind === 'thank_you' && !withFacts && i.code === 'needs_input') &&
                i.code !== 'placeholder' &&
                i.code !== 'no_specific_line',
            );
            expect(
              blockers,
              `${kind}/${p.firstName}/${channel}/${withFacts}: ${JSON.stringify(blockers)} :: ${r.d.body}`,
            ).toEqual([]);
            expect(wordsIn(r.d.body), `${kind}/${p.firstName} too long: ${r.d.body}`).toBeLessThanOrEqual(
              MAX_WORDS[kind] + 10,
            );
            expect(r.d.body).not.toMatch(/undefined|null|\{first\}|\{org\}/);
          }
    expect(count).toBe(people.length * kinds.length * 4);
  });
});

describe('other kinds', () => {
  it('bump 1 says buried and offers a pointer; bump 2 is the graceful last word', () => {
    const b1 = generateDraft(
      base({
        kind: 'bump',
        bumpNumber: 1,
        thread: { firstOutboundAt: '2026-09-29T12:00:00Z', inThread: true },
      }),
    );
    expect(b1.body).toMatch(/buried|lost/);
    expect(b1.subject).toBeUndefined();
    expect(wordsIn(b1.body)).toBeLessThanOrEqual(55);
    const b2 = generateDraft(base({ kind: 'bump', bumpNumber: 2 }));
    expect(b2.body).toMatch(/Last note from me|One last nudge/);
    expect(wordsIn(b2.body)).toBeLessThanOrEqual(45);
  });
  it('schedule proposes two windows with the timezone and an out; reply confirms a proposed time', () => {
    const s = generateDraft(
      base({
        kind: 'schedule',
        proposedWindows: [{ startIso: '2026-10-08T14:00:00Z' }, { startIso: '2026-10-09T18:30:00Z' }],
      }),
    );
    expect(s.body).toMatch(/Thursday, Oct 8 at 10am or Friday, Oct 9 at 2:30pm \(EDT\)/);
    expect(s.body).toMatch(/send me a time/);
    const r = generateDraft(
      base({
        kind: 'reply',
        thread: {
          proposedTimes: [{ startIso: '2026-10-08T18:00:00Z', raw: 'Thursday at 2pm' }],
          asksOfUser: ['Could you send your resume?'],
        },
      }),
    );
    expect(r.body).toMatch(/Thursday, Oct 8 at 2pm EDT works/);
    expect(r.body).toMatch(/calendar invite/);
    expect(r.body).toMatch(/I'll send it over today/);
  });
  it('thank-you locates the memory, quotes advice, mentions the offer, asks permission', () => {
    const t = generateDraft(
      base({ kind: 'thank_you', facts: FACTS, chat: { completedAt: '2026-10-05T19:00:00Z' } }),
    );
    expect(t.body).toMatch(/Thank you for making time yesterday/);
    expect(t.body).toMatch(/your point that the key is showing how I handled ambiguity/i);
    expect(t.body).toMatch(/Thanks also for offering to refer me when the posting goes up/);
    expect(t.body).toMatch(/\?/);
    expect(t.claims.filter((c) => c.factId).length).toBe(2);
  });
  it('nurture without a hook or update is gated; with a hook it asks about it and needs no reply', () => {
    const gated = generateDraft(base({ kind: 'nurture', facts: [] }));
    expect(gated.needsInput).toContain('update');
    const n = generateDraft(
      base({ kind: 'nurture', facts: [FACTS[2]!], chat: { completedAt: '2026-08-10T00:00:00Z' } }),
    );
    // "hiring in January", asked in October, is still ahead (DQ-08)
    expect(n.body).toMatch(/You mentioned you're hiring interns in January\. How is that shaping up\?/);
    expect(n.body).toMatch(/No reply needed/);
  });
  it('referral ask in tech asks before the portal and makes it a two-minute task', () => {
    const r = generateDraft(
      base({
        kind: 'referral_ask',
        facts: FACTS,
        chat: { completedAt: '2026-10-01T15:00:00Z' },
        targetCompany: {
          name: 'Figma',
          roleLabel: 'PM Intern',
          reqId: '7731',
          link: 'https://figma.com/careers/7731',
        },
      }),
    );
    expect(r.body).toMatch(/offered to refer me when the posting goes up, so I wanted to follow up/);
    expect(r.body).toMatch(/req 7731/);
    expect(r.body).toMatch(/before I submit through the portal/);
    expect(r.body).toMatch(/Completely fine if not/);
    expect(r.body).toMatch(/https:\/\/figma.com\/careers\/7731/);
    expect(
      validateDraft(r, {
        kind: 'referral_ask',
        facts: FACTS,
        allowedUrls: ['https://figma.com/careers/7731'],
        recipientFirstName: 'Priya',
        hadConversation: false,
      }).some((i) => i.code === 'referral_without_conversation'),
    ).toBe(true);
  });
  it('intro request carries a forwardable third-person blurb with a credibility fact', () => {
    const i = generateDraft(
      base({
        kind: 'intro_request',
        target: { name: 'Lucas Fischer', firstName: 'Lucas', title: 'Engineering Manager', org: 'Ramp' },
        connection: { kind: 'shared_employer', text: '', sharedOrg: 'Stripe' },
      }),
    );
    expect(i.body).toMatch(/"Alex Rivera is a junior at Cornell studying computer science/);
    expect(i.body).toMatch(/hear about Lucas's path to engineering manager at Ramp/);
    expect(i.body).toMatch(/built a campus marketplace used by 800 students/);
    expect(i.body).toMatch(/worked together at Stripe/);
    expect(i.subject).toBe('Small ask: intro to Lucas Fischer?');
  });
  it('congratulate ties the news to something they said; report-back closes the loop', () => {
    const c = generateDraft(
      base({
        kind: 'congratulate',
        facts: [fact('p', 'preference', 'wanted to sit closer to the product')],
        newAffiliation: { title: 'Senior PM', org: 'Figma' },
      }),
    );
    // the old expectation pinned an ungrammatical splice ("what you said about wanted to ..."), see DQ-01
    expect(c.body).toMatch(/Just saw the news about your move to Figma as a senior PM\. Congratulations\./);
    expect(c.body).toMatch(/I remember you saying you wanted to sit closer to the product/);
    const rb = generateDraft(
      base({
        kind: 'report_back',
        reportBack: {
          targetName: 'Lucas Fischer',
          outcome: 'spoke',
          when: 'on Tuesday',
          line: 'he walked me through how the platform team hires',
        },
      }),
    );
    expect(rb.body).toMatch(
      /thank you for the intro to Lucas Fischer\. We spoke on Tuesday he walked me through|We spoke on Tuesday\. he walked|We spoke on Tuesday/,
    );
  });
  it('warm-up comment needs the post claim and never praises', () => {
    expect(draftWarmUpComment(undefined).needsInput).toEqual(['post']);
    const c = draftWarmUpComment('writing the memo before the model saves a week', { seed: 'x' });
    expect(c.text).toMatch(/\?$/);
    expect(c.text.toLowerCase()).not.toMatch(/great post|thanks for sharing|insightful/);
  });
});

describe('audit round 1 regressions', () => {
  const ALINA = {
    firstName: 'Alina',
    lastName: 'Rossi',
    fullName: 'Alina Rossi',
    title: 'Software Engineer II',
    org: 'Jane Street',
    isAlumni: true,
    relationshipType: 'alumni',
    strength: 0.5,
  };
  const NOTE_FACTS = [
    fact(
      'n1',
      'advice',
      'They recommended focusing on one concrete project story for interviews and said the key is showing how you handled ambiguity.',
    ),
    fact('n2', 'offer', 'Alina offered to refer me when the posting goes up.'),
    fact('n3', 'role_detail', 'Alina leads a small team on payments onboarding at Jane Street.'),
    fact('n4', 'hook', 'They are hiring interns in January for the platform team.'),
    fact('n5', 'personal', 'They ran a marathon in April and grew up in Chicago.'),
  ];

  it('clause() turns stored note sentences into grammatical second person, or refuses (DQ-01, UI-04)', () => {
    const p = { firstName: 'Alina', fullName: 'Alina Rossi' };
    expect(clause('Alina offered to refer me when the posting goes up.', p)?.text).toBe(
      'you offered to refer me when the posting goes up',
    );
    expect(clause('Alina leads a small team on payments onboarding at Jane Street.', p)?.text).toBe(
      'you lead a small team on payments onboarding at Jane Street',
    );
    expect(clause('She is hiring interns in January.', p)?.text).toBe("you're hiring interns in January");
    expect(clause('Happy to intro me to their PM lead.', p)?.text).toBe(
      "you said you'd be happy to intro me to your PM lead",
    );
    expect(clause('Recommended reading "Working Backwards".', p)?.text).toBe(
      'you recommended reading "Working Backwards"',
    );
    expect(clause("Alina's team is hiring in January", p)?.text).toBe('your team is hiring in January');
    expect(clause('The team is launching a new product in November', p)?.text).toBe(
      'your team is launching a new product in November',
    );
    // a third party, a question, or a fact about the student cannot be addressed to the person
    expect(clause('Mei said the team is great', p)).toBeUndefined();
    expect(clause('What should I read next?', p)).toBeUndefined();
    expect(clause('I will send my resume by Friday', p)).toBeUndefined();
  });

  it('thank-you and nurture never splice raw note sentences (DQ-01, UI-04)', () => {
    const t = generateDraft(
      base({
        kind: 'thank_you',
        person: ALINA,
        facts: NOTE_FACTS,
        chat: { meetingAt: '2026-10-05T19:00:00Z' },
      }),
    );
    expect(t.body).toMatch(/what you said about focusing on one concrete project story for interviews/i);
    // what the student felt or did about it is not in the data, so it is never claimed
    expect(t.body).not.toMatch(/putting it to use|started acting|acting on it|hadn't heard|kept thinking/i);
    expect(t.body).toMatch(/Thanks also for offering to refer me when the posting goes up/);
    expect(t.body).not.toMatch(/Alina offered|point that recommended|follow up on alina/i);
    const n = generateDraft(base({ kind: 'nurture', person: ALINA, facts: NOTE_FACTS }));
    expect(n.body).toMatch(/You mentioned you're hiring interns in January for the platform team\./);
    expect(n.body).not.toMatch(/mentioned (Alina|they)|offered to refer me/i);
    expect(n.body).not.toMatch(/It's been a little while/);
  });

  it('facts are picked by type priority, and claims list only facts used in the body (DQ-14)', () => {
    const facts = [
      {
        ...fact('b', 'background', 'They previously worked at McKinsey for three years.'),
        occurredAt: '2026-10-04T00:00:00Z',
      },
      fact('a', 'advice', 'They recommended practicing paper LBOs before superdays.'),
    ];
    const t = generateDraft(base({ kind: 'thank_you', facts, chat: { meetingAt: '2026-10-05T19:00:00Z' } }));
    expect(t.body).toMatch(/practicing paper LBOs/);
    expect(t.claims.map((c) => c.factId).filter(Boolean)).toEqual(['a']);
    for (const c of t.claims.filter((x) => x.factId)) {
      const used = facts.find((f) => f.id === c.factId)!;
      expect(t.body.toLowerCase()).toContain(
        clause(used.text)!.rest!.split(' ').slice(0, 3).join(' ').toLowerCase(),
      );
    }
    // outreach to an alum with facts on file cites the alumni link, not a fact it never mentions
    const o = generateDraft(base({ facts: NOTE_FACTS, person: ALINA }));
    expect(o.claims.filter((c) => c.factId)).toEqual([]);
    // a hook connection prefers a hook over background
    const hookFirst = generateDraft(
      base({
        person: { ...ALINA, isAlumni: false },
        facts: [
          { ...fact('bg', 'background', 'She studied physics at MIT.'), occurredAt: '2026-10-05T00:00:00Z' },
          fact('hk', 'hook', 'Her team is hiring interns in January.'),
        ],
      }),
    );
    expect(hookFirst.body).toMatch(/your team is hiring interns in January/);
    expect(hookFirst.claims.some((c) => c.factId === 'hk')).toBe(true);
    expect(hookFirst.claims.some((c) => c.factId === 'bg')).toBe(false);
  });

  it('reply never answers a question for the student, keeps paragraphs, and fills in their answer (DQ-02)', () => {
    const q = generateDraft(
      base({ kind: 'reply', thread: { asksOfUser: ['What area of PM are you most interested in?'] } }),
    );
    expect(q.body).not.toMatch(/send that over today/);
    expect(q.body).toMatch(/\[Your answer to: What area of PM are you most interested in\?\]/);
    expect(q.needsInput).toEqual(['answer']);
    expect(q.body).toMatch(/^Hi Priya,\n\n.+\n\nThanks,\nAlex$/s); // paragraphs survive
    const a = generateDraft(
      base({
        kind: 'reply',
        thread: { asksOfUser: ['What area of PM are you most interested in?'] },
        answer: 'Mostly growth and onboarding, since that is what I worked on at Brex',
      }),
    );
    expect(a.needsInput).toEqual([]);
    expect(a.body).toMatch(/Mostly growth and onboarding, since that is what I worked on at Brex\./);
    // nothing to answer and no time: it moves scheduling forward instead of saying nothing
    const empty = generateDraft(
      base({
        kind: 'reply',
        proposedWindows: [{ startIso: '2026-10-08T14:00:00Z' }, { startIso: '2026-10-12T18:00:00Z' }],
      }),
    );
    expect(empty.body).toMatch(
      /Would either of these work for a quick call\? Thursday, Oct 8 at 10am or Monday, Oct 12 at 2pm \(EDT\)/,
    );
  });

  it('outreach differs by sector and relationship and makes no unsupported claim (DQ-05)', () => {
    const ib = generateDraft(
      base({
        person: {
          firstName: 'Daniel',
          fullName: 'Daniel Kim',
          title: 'Investment Banking Analyst',
          org: 'Goldman Sachs',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0,
        },
        user: { ...base().user, targetFunctions: ['ib'], majors: ['Economics'] },
      }),
    );
    const pm = generateDraft(base());
    expect(ib.body).not.toBe(pm.body);
    for (const d of [ib, pm]) {
      expect(d.body).not.toMatch(/I've been following|the kind of route I'd love to understand/);
      expect(d.body).not.toMatch(/Cornell University/);
    }
    const bg = generateDraft(
      base({
        person: { ...base().person, isAlumni: false, title: undefined, org: undefined },
        facts: [fact('m', 'background', 'She previously worked at McKinsey for three years.')],
      }),
    );
    expect(bg.body).toMatch(/I saw that you previously worked at McKinsey for three years/);
    expect(bg.body).not.toMatch(/I noticed She|I read that/);
  });

  it('picks the function that matches the recipient and gives recruiters a logistics note (DQ-06)', () => {
    const user = { ...base().user, targetFunctions: ['swe', 'pm'] };
    expect(targetLabel({ user, person: { title: 'Associate Product Manager' } })).toBe('product management');
    expect(targetLabel({ user, person: { title: 'Software Engineer' } })).toBe('software engineering');
    expect(targetLabel({ user: { ...user, targetFunctions: ['early_career'] } })).toBe('early career');
    const r = generateDraft(
      base({
        user,
        person: {
          firstName: 'Nina',
          fullName: 'Nina Park',
          title: 'University Recruiter',
          org: 'Notion',
          relationshipType: 'recruiter',
          strength: 0,
        },
        sameOrgContacts: ['Grace'],
      }),
    );
    expect(r.body).toMatch(/^Dear Nina,/);
    expect(r.body).toMatch(/planning to apply for software engineering internships at Notion/);
    expect(r.body).toMatch(/helpful conversations with Grace on the team/);
    expect(r.body).not.toMatch(/your path|minutes/);
  });

  it('thank-you locates the memory by its real date and never says "this cycle recruiting" (DQ-07)', () => {
    const at = (iso: string, cycleLabel = 'Summer 2027 internship') =>
      generateDraft(
        base({ kind: 'thank_you', user: { ...base().user, cycleLabel }, chat: { meetingAt: iso } }),
      ).body;
    expect(at('2026-10-06T13:00:00Z')).toMatch(/making time this morning/);
    expect(at('2026-10-05T20:00:00Z')).toMatch(/making time yesterday/);
    expect(at('2026-10-02T15:00:00Z')).toMatch(/making time on Friday/);
    expect(at('2026-09-28T15:00:00Z')).toMatch(/making time last week/);
    expect(at('2026-09-01T15:00:00Z')).toMatch(/making time on September 1/);
    const blank = at('2026-10-05T20:00:00Z', 'This cycle');
    expect(blank).not.toMatch(/this cycle (search|recruiting)|the this/i);
    expect(blank).toMatch(/how recruiting goes/);
  });

  it('nurture needs a real update or a hook; offers are never "how did that go" (DQ-08)', () => {
    expect(generateDraft(base({ kind: 'nurture', facts: [] })).needsInput).toEqual(['update']);
    const offerOnly = generateDraft(base({ kind: 'nurture', facts: [NOTE_FACTS[1]!] }));
    expect(offerOnly.needsInput).toEqual(['update']);
    expect(offerOnly.body).not.toMatch(/offered/);
    const noAdvice = generateDraft(
      base({ kind: 'nurture', facts: [], update: 'I had a first round at Ramp last week' }),
    );
    expect(noAdvice.body).not.toMatch(/your advice/i);
    expect(noAdvice.body).toMatch(/Quick update: I had a first round at Ramp last week\./);
    const past = generateDraft(
      base({
        kind: 'nurture',
        facts: [fact('h', 'hook', 'They were launching the new dashboard in August.')],
      }),
    );
    expect(past.body).toMatch(/How did it go\?/);
  });

  it('proposes real free windows on different days and times, dated, in the user zone (DQ-09)', () => {
    const now = new Date('2026-10-05T14:00:00Z'); // Monday 10am in New York
    const busy = [{ startIso: '2026-10-06T14:00:00Z', endIso: '2026-10-06T15:00:00Z' }];
    const w = proposeWindows(busy, now, 'America/New_York', { seed: 'x' });
    expect(w).toHaveLength(2);
    const local = w.map((x) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(x.startIso)),
    );
    expect(new Set(local.map((l) => l.split(' ')[0])).size).toBe(2); // different days
    expect(new Set(local.map((l) => l.split(' ').slice(1).join(' '))).size).toBe(2); // different times
    for (const x of w) {
      expect(new Date(x.startIso).getTime()).toBeGreaterThan(now.getTime());
      expect(overlapsBusy(x.startIso, 30, busy)).toBe(false);
    }
    expect(local.some((l) => /AM/.test(l)) && local.some((l) => /PM/.test(l))).toBe(true);
    // the zone label follows the window's own date (EST after Nov 1)
    const s = generateDraft(
      base({
        kind: 'schedule',
        now: new Date('2026-10-30T14:00:00Z'),
        proposedWindows: [{ startIso: '2026-11-03T15:00:00Z' }],
      }),
    );
    expect(s.body).toMatch(/Tuesday, Nov 3 at 10am \(EST\)/);
    expect(s.body).toMatch(/If not, send me a time/);
    // the calendar link is the fallback only when there are no windows, and windows in the past are dropped
    const link = generateDraft(
      base({
        kind: 'schedule',
        user: { ...base().user, schedulingLink: 'https://cal.com/alex' },
        proposedWindows: [{ startIso: '2026-10-01T14:00:00Z' }],
      }),
    );
    expect(link.body).toMatch(/https:\/\/cal\.com\/alex\n/);
    expect(link.body).not.toMatch(/If neither works|Oct 1/);
    const withBoth = generateDraft(
      base({
        kind: 'schedule',
        user: { ...base().user, schedulingLink: 'https://cal.com/alex' },
        proposedWindows: [{ startIso: '2026-10-08T14:00:00Z' }],
      }),
    );
    expect(withBoth.body).not.toMatch(/cal\.com/);
    // a time they proposed that clashes with the calendar gets a counter-proposal, not "works perfectly"
    const clash = generateDraft(
      base({
        kind: 'reply',
        busy: [{ startIso: '2026-10-08T18:00:00Z', endIso: '2026-10-08T19:00:00Z' }],
        proposedWindows: [{ startIso: '2026-10-09T14:00:00Z' }, { startIso: '2026-10-13T19:00:00Z' }],
        thread: { proposedTimes: [{ startIso: '2026-10-08T18:00:00Z', raw: 'Thursday at 2pm' }] },
      }),
    );
    expect(clash.body).toMatch(
      /Thursday, Oct 8 at 2pm is tight for me, sorry\. Could you do Friday, Oct 9 at 10am or Tuesday, Oct 13 at 3pm \(EDT\) instead\?/,
    );
    // outreach never carries a calendar link or a slot grid to a stranger
    const o = generateDraft(base({ user: { ...base().user, schedulingLink: 'https://cal.com/alex' } }));
    expect(o.body).not.toMatch(/cal\.com/);
  });

  it('LinkedIn note uses the short school name and is never cut mid-word (DQ-10)', () => {
    const long = generateDraft(
      base({
        channel: 'linkedin',
        user: {
          ...base().user,
          oneLiner:
            'a junior at Cornell studying computer science and economics, interested in payments infrastructure, developer tools and market structure',
        },
        person: {
          ...base().person,
          isAlumni: false,
          title: 'Vice President, Leveraged Finance Capital Markets',
          org: 'Morgan Stanley & Co. International plc',
          previousOrg: 'Credit Suisse First Boston Securities',
          previousTitle: 'Associate',
        },
      }),
    );
    expect(long.bodyShort!.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
    expect(long.bodyShort).toMatch(/[.?!a-z]$/);
    const words = long.bodyShort!.split(/\s+/);
    expect(long.bodyShort!.replace(/[.,?!]/g, ' ')).toContain(words.at(-1)!.replace(/[.,?!]/g, ''));
    expect(fitNote('one two three four five six', 12)).toBe('one two');
    const alum = generateDraft(base({ channel: 'linkedin' }));
    expect(alum.bodyShort).toMatch(/Cornell/);
    expect(alum.bodyShort).not.toMatch(/fellow Cornell University|Cornell University/i);
  });

  it('intro request needs a target and names them; the blurb has no self-praise (DQ-11)', () => {
    const none = generateDraft(base({ kind: 'intro_request' }));
    expect(none.needsInput).toEqual(['target']);
    expect(none.body).not.toMatch(/\bthem thinks|reach someone/);
    const i = generateDraft(
      base({
        kind: 'intro_request',
        target: {
          name: 'Daniel Kim',
          title: 'Engineering Manager',
          org: 'Stripe',
          why: 'their work at Stripe',
        },
      }),
    );
    expect(i.body).toMatch(
      /I'm hoping to talk with Daniel Kim \(Engineering Manager at Stripe\) about Daniel's work at Stripe\./,
    );
    expect(i.body).not.toMatch(/thoughtful|will come prepared|They'd love/);
  });

  it('bump: dated or "last week", second bump differs, formal style is applied (DQ-12)', () => {
    const b = generateDraft(base({ kind: 'bump', seed: 'zz1', thread: { inThread: true } }));
    expect(b.body).not.toMatch(/wrote on last week/);
    const b1 = generateDraft(base({ kind: 'bump', bumpNumber: 1, thread: { inThread: true } }));
    const b2 = generateDraft(base({ kind: 'bump', bumpNumber: 2, thread: { inThread: true } }));
    expect(b1.body).not.toBe(b2.body);
    const formal = generateDraft(
      base({
        kind: 'bump',
        styleCard: defaultStyleCard('formal', 'Alex'),
        thread: { inThread: true, firstOutboundAt: '2026-09-24T14:00:00Z' },
      }),
    );
    expect(formal.body).toMatch(/^Dear Priya,/);
    expect(formal.body).not.toMatch(/Floating|buried|Totally|\b\w+'(m|ll|d|ve|re|s)\b/);
    // Sep 24 is the week before last from Tuesday Oct 6, so it is dated rather than called "last week"
    expect(formal.body).toMatch(/I wanted to follow up on my note from September 24/);
    expect(formal.body).toMatch(/Kind regards,\nAlex$/);
  });

  it('congratulate needs the news; with a job change on record it names it (DQ-13)', () => {
    const none = generateDraft(base({ kind: 'congratulate' }));
    expect(none.needsInput).toEqual(['news']);
    expect(none.body).not.toMatch(/new role|the news/);
    const typed = generateDraft(base({ kind: 'congratulate', news: 'your promotion to senior PM' }));
    expect(typed.body).toMatch(
      /Just saw the news about your promotion to senior PM\. Congratulations, well deserved\./,
    );
    const move = generateDraft(
      base({
        kind: 'congratulate',
        newAffiliation: { title: 'Senior Product Manager', org: 'Figma', since: '2026-09-20' },
      }),
    );
    expect(move.body).toMatch(/your move to Figma as a senior product manager/);
    expect(move.body).toMatch(/Hope the first few weeks are going well/);
    expect(move.subject).toBe('Congratulations on Figma');
  });

  it('subjects fit the kind; no "Quick question" on a check-in (DQ-15)', () => {
    const n = generateDraft(
      base({ kind: 'nurture', facts: [NOTE_FACTS[3]!], chat: { meetingAt: '2026-08-10T15:00:00Z' } }),
    );
    expect(n.subject).toBe('Quick update since August');
    const t = generateDraft(base({ kind: 'thank_you', chat: { meetingAt: '2026-10-05T19:00:00Z' } }));
    expect(t.subject).toBe('Thank you for yesterday');
    const o = generateDraft(base());
    expect(o.subject).toMatch(/^Cornell junior, quick question on Figma$/);
    for (const k of ['nurture', 'thank_you', 'congratulate', 'report_back', 'bump', 'schedule'] as const)
      expect(generateDraft(base({ kind: k, news: 'the launch' })).subject ?? '').not.toMatch(
        /^quick question$/i,
      );
  });

  it('referral ask: needs a company, mentions a conversation only if there was one, handles another company (DQ-16)', () => {
    const none = generateDraft(base({ kind: 'referral_ask', person: { ...base().person, org: undefined } }));
    expect(none.needsInput).toEqual(['role']);
    expect(none.body).not.toMatch(/your company/);
    const cold = generateDraft(
      base({ kind: 'referral_ask', targetCompany: { name: 'Figma', roleLabel: 'PM Intern' } }),
    );
    expect(cold.body).not.toMatch(/after our conversation|Thanks again for the conversation/);
    const other = generateDraft(
      base({
        kind: 'referral_ask',
        chat: { completedAt: '2026-09-20T15:00:00Z' },
        targetCompany: { name: 'Notion', roleLabel: 'PM Intern' },
      }),
    );
    expect(other.body).toMatch(/I know you're at Figma, but if you know anyone at Notion/);
  });

  it('outreach "who I am" comes from structured fields (UI-03)', () => {
    const d = generateDraft(
      base({ user: { ...base().user, school: 'University of Michigan', gradYear: 2027 } }),
    );
    // structured fields, school named once (EG-20)
    expect(d.body).toMatch(
      /I'm a senior (at Michigan studying computer science|studying computer science at Michigan)/,
    );
    expect(d.body.match(/Michigan/g)?.length).toBe(1);
    expect(schoolShort('Massachusetts Institute of Technology')).toBe('MIT');
    expect(schoolShort('University of California, Los Angeles')).toBe('UCLA');
    expect(schoolShort('University of California, San Diego')).toBe('UC San Diego');
    expect(schoolShort('Duke University')).toBe('Duke');
  });

  it('validator flags names, posts, mutual connections and figures not in the context even with no claims (EG-17)', () => {
    const ctx = base();
    const llm = {
      body: 'Hi Priya,\n\nOur mutual connection Mei Chen suggested I write. I loved your recent post on pricing, and with a 3.9 GPA I think I could add a lot at Figma. Would you have 15 minutes?\n\nThanks,\nAlex',
      claims: [],
    };
    const issues = validateDraft(llm, {
      kind: 'outreach',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Priya',
      context: contextText(ctx),
    });
    const details = issues
      .filter((i) => i.code === 'unsupported_detail')
      .map((i) => i.detail)
      .join(' | ');
    expect(details).toMatch(/Mei Chen/);
    expect(details).toMatch(/mutual connection/);
    expect(details).toMatch(/post or article/);
    expect(details).toMatch(/3\.9/);
    expect(isBlocked(issues)).toBe(true);
    // the template itself is always grounded
    const t = generateDraft(ctx);
    expect(unsupportedDetails(`${t.subject}\n${t.body}`, contextText(ctx))).toEqual([]);
  });
});

describe('audit round 1, expert gaps (EG, SND, UI-10)', () => {
  const dana = {
    firstName: 'Dana',
    lastName: 'Cole',
    fullName: 'Dana Cole',
    title: 'Software Engineer',
    org: 'Stripe',
    relationshipType: 'unknown',
    strength: 0,
  };

  it('a reply that asks for the resume and the teams is answered before times are proposed (EG-03)', () => {
    const ctx = base({
      kind: 'schedule',
      thread: {
        inThread: true,
        lastSignal: 'reply_positive',
        lastInboundBody:
          "Hi Alex, happy to chat! Could you send over your resume and let me know which teams you're most interested in?",
        asksOfUser: ['Could you send over your resume', "let me know which teams you're most interested in"],
      },
      proposedWindows: [
        { startIso: '2026-10-08T14:00:00Z', endIso: '2026-10-08T14:30:00Z' },
        { startIso: '2026-10-12T18:00:00Z', endIso: '2026-10-12T18:30:00Z' },
      ],
    });
    const d = generateDraft(ctx);
    expect(d.body).toMatch(/resume/);
    expect(d.needsInput).toEqual(['answer']);
    expect(d.body).toMatch(/\[Your answer to: let me know which teams you're most interested in\?\]/);
    expect(d.body).toMatch(/Thursday, Oct 8 at 10am or Monday, Oct 12 at 2pm \(EDT\)/);
    // resume answer, then the student's answer, then the times
    expect(d.body.indexOf('resume')).toBeLessThan(d.body.indexOf('[Your answer'));
    expect(d.body.indexOf('[Your answer')).toBeLessThan(d.body.indexOf('Thursday'));
    const answered = generateDraft({ ...ctx, answer: 'Payments infrastructure first, then developer tools' });
    expect(answered.needsInput).toEqual([]);
    expect(answered.body).toMatch(/Payments infrastructure first, then developer tools\./);
    const opts = {
      kind: 'schedule' as const,
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Priya',
      context: contextText(ctx),
      asks: ctx.thread!.asksOfUser,
    };
    expect(validateDraft(answered, opts).filter((i) => i.blocking)).toEqual([]);
    // an LLM rewrite that drops the resume is rejected
    const ignoring = { body: answered.body.replace(/[^.]*resume[^.]*\./g, ''), claims: [] };
    expect(validateDraft(ignoring, opts).some((i) => i.code === 'ignores_ask' && i.blocking)).toBe(true);
  });

  it("a booking link in their reply is used instead of proposing the student's own times (EG-16)", () => {
    const d = generateDraft(
      base({
        kind: 'schedule',
        thread: {
          inThread: true,
          lastSignal: 'scheduling_proposal',
          lastInboundBody: 'Sure, grab a slot here: https://calendly.com/priya-patel/20min',
        },
        proposedWindows: [{ startIso: '2026-10-08T14:00:00Z' }, { startIso: '2026-10-12T18:00:00Z' }],
      }),
    );
    expect(d.body).toMatch(/through your link today/);
    expect(d.body).not.toMatch(/Thursday|Monday|calendly/);
    expect(bookingLinkIn('book some time here: cal.com/priya')).toBe(true);
    expect(bookingLinkIn('Would Thursday at 2pm work?')).toBe(false);
  });

  it('outreach names the student target only when it is the recipient field (EG-06)', () => {
    const d = generateDraft(
      base({
        user: { ...base().user, targetFunctions: ['swe', 'pm'] },
        person: {
          firstName: 'Rhea',
          fullName: 'Rhea Reyes',
          title: 'Investment Banking Analyst',
          org: 'Goldman Sachs',
          relationshipType: 'unknown',
          strength: 0,
        },
      }),
    );
    expect(d.body).not.toMatch(/software engineering|product management/);
    expect(d.body).not.toMatch(/your path to Investment Banking Analyst/i);
    const eng = generateDraft(
      base({
        user: { ...base().user, targetFunctions: ['swe', 'pm'] },
        person: { ...dana, previousOrg: 'Brex' },
        seed: 'x2',
      }),
    );
    expect(eng.body).toMatch(/Stripe/);
    expect(targetLabel({ user: base().user, person: { title: 'Software Engineer' } })).toBe(
      'software engineering',
    );
  });

  it('someone the student already emailed with is not written to as a stranger (EG-06)', () => {
    const history = { lastAt: '2026-09-05T15:00:00Z', lastInbound: true, repliedEver: true, threadId: 't1' };
    const recruiter = generateDraft(
      base({
        person: {
          firstName: 'Diego',
          fullName: 'Diego Lopez',
          title: 'Recruiter',
          org: 'Ramp',
          relationshipType: 'recruiter',
          strength: 0.45,
        },
        history,
        thread: { inThread: true, subject: 'Catching up' },
      }),
    );
    expect(recruiter.body).toMatch(
      /^Dear Diego,\n\nThanks again for your note a few weeks ago, and sorry it took me a while to follow up\. As a quick reminder, I'm a junior at Cornell/,
    );
    expect(recruiter.subject).toBe('Re: Catching up');
    const peer = generateDraft(
      base({
        person: { ...dana, strength: 0.4 },
        history: { lastAt: '2026-05-05T15:00:00Z', lastInbound: false, repliedEver: true },
      }),
    );
    expect(peer.needsInput).toEqual([]);
    expect(peer.body).toMatch(/We traded emails in May, and I wanted to pick that conversation back up\./);
    expect(peer.body).not.toMatch(/came across your profile/);
    // they never wrote back: that is not a relationship, the outreach still needs a real link
    const ignored = generateDraft(
      base({
        person: dana,
        history: { lastAt: '2026-05-05T15:00:00Z', lastInbound: false, repliedEver: false },
      }),
    );
    expect(ignored.needsInput).toEqual(['connection']);
    for (const d of [recruiter, peer]) {
      const ctx = base({ person: dana, history });
      expect(unsupportedDetails(d.body, `${contextText(ctx)} Diego Lopez Ramp Recruiter`)).toEqual([]);
    }
  });

  it("a thank-you with no notes asks for one thing they said; it keeps the student's promise (EG-15, UI-10)", () => {
    const none = generateDraft(base({ kind: 'thank_you', chat: { meetingAt: '2026-10-05T19:00:00Z' } }));
    expect(none.needsInput).toEqual(['takeaway']);
    expect(none.body).not.toMatch(/much clearer picture|really useful/);
    const typed = generateDraft(
      base({
        kind: 'thank_you',
        chat: { meetingAt: '2026-10-05T19:00:00Z' },
        takeaway: 'to lead every interview answer with one project story',
        promises: ['I will send my resume by Friday and share the marketplace project link.'],
      }),
    );
    expect(typed.needsInput).toEqual([]);
    expect(typed.body).toMatch(/your advice to lead every interview answer with one project story/i);
    expect(typed.body).toMatch(
      /As promised, I'll send my resume by Friday and share the marketplace project link\./,
    );
    expect(
      generateDraft(base({ kind: 'thank_you', takeaway: 'She said recruiting starts in August' })).body,
    ).toMatch(/your point that recruiting starts in August/i);
    expect(promiseLine('Ask about the Q3 roadmap?')).toBeUndefined();
    // with note facts the specific line comes from them (UI-10)
    const facts = generateDraft(
      base({
        kind: 'thank_you',
        facts: [
          fact(
            'n1',
            'advice',
            'They recommended focusing on one concrete project story for interviews and said the key is showing how you handled ambiguity.',
          ),
        ],
      }),
    );
    expect(facts.needsInput).toEqual([]);
    expect(facts.body).toMatch(/what you said about focusing on one concrete project story/i);
  });

  it('validator catches an invented friend, blog post and grades with no claims (EG-17)', () => {
    const issues = validateDraft(
      {
        body: "Hi Priya,\n\nMy friend Daniel Kim at Stripe said you'd be perfect to talk to. I read your recent blog post, and I graduated top of my class with a 4.0. Would you have 15 minutes?\n\nThanks,\nAlex",
        claims: [],
      },
      {
        kind: 'outreach',
        facts: [],
        allowedUrls: [],
        recipientFirstName: 'Priya',
        context: contextText(base({ person: { ...base().person, isAlumni: false } })),
      },
    );
    const details = issues.map((i) => i.detail).join(' | ');
    expect(details).toMatch(/Daniel Kim/);
    expect(details).toMatch(/Stripe/);
    expect(details).toMatch(/mutual connection/);
    expect(details).toMatch(/post or article/);
    expect(details).toMatch(/academic honor/);
    expect(details).toMatch(/4\.0/);
    expect(issues.some((i) => i.code === 'no_specific_line' && i.blocking)).toBe(true);
  });

  it('LinkedIn notes aim for 200 characters, never cut mid-word, recruiters included (SND-08, EG-20)', () => {
    const long = generateDraft(
      base({
        channel: 'linkedin',
        user: {
          ...base().user,
          school: 'University of Michigan',
          gradYear: 2028,
          oneLiner:
            'a junior studying Computer Science and Economics at the University of Michigan, interested in payments infrastructure, developer tools and early-stage fintech',
        },
        person: {
          firstName: 'Christopher',
          fullName: 'Christopher Hall',
          title: 'Software Engineer',
          org: 'Stripe',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0.1,
        },
      }),
    );
    expect(long.bodyShort!.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
    expect(long.bodyShort).toMatch(/\?/); // the ask survives
    expect(long.bodyShort).toMatch(/Alex$/); // and the sign-off
    expect(long.bodyShort).not.toMatch(/fellow|University of Michigan/);
    const alum = generateDraft(base({ channel: 'linkedin' }));
    expect(alum.bodyShort!.length).toBeLessThanOrEqual(200);
    const recruiter = generateDraft(
      base({
        channel: 'linkedin',
        person: {
          firstName: 'Nina',
          fullName: 'Nina Park',
          title: 'University Recruiter',
          org: 'Notion',
          relationshipType: 'recruiter',
          strength: 0,
        },
      }),
    );
    expect(recruiter.subject).toBeUndefined();
    expect(recruiter.bodyShort!.length).toBeLessThanOrEqual(200);
    expect(recruiter.bodyShort).toMatch(
      /^Hi Nina, Cornell junior here, planning to apply for software engineering/,
    );
  });

  it('the warm-up shows up in the LinkedIn note; a comment without a note is never made generic (SND-09)', () => {
    const noted = generateDraft(
      base({
        channel: 'linkedin',
        person: dana,
        chat: { warmUpNote: 'junior engineers should own a metric', warmUpDone: 2 },
      }),
    );
    expect(noted.bodyShort).toMatch(
      /Read your post making the point that junior engineers should own a metric/,
    );
    expect(noted.bodyShort!.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
    const bare = generateDraft(base({ person: dana, chat: { warmUpDone: 2, commentedOnPost: true } }));
    expect(bare.needsInput).toEqual(['connection']);
    expect(bare.body).toMatch(/\[What their post was about/);
    expect(bare.body).not.toMatch(/enjoyed your recent posts/);
    const alum = generateDraft(base({ chat: { warmUpDone: 2, commentedOnPost: true } }));
    expect(alum.body).toMatch(/I also left a comment on your recent post\./);
    expect(unsupportedDetails(alum.body, contextText(base({ chat: { commentedOnPost: true } })))).toEqual([]);
  });

  it('a bump on LinkedIn or a new Gmail chat dates the first note, never "wrote on last week" (SND-10)', () => {
    for (const firstOutboundAt of ['2026-09-29T14:00:00Z', '2026-10-01T14:00:00Z', undefined]) {
      for (const seed of ['a', 'b', 'c', 'd']) {
        const d = generateDraft(
          base({ kind: 'bump', channel: 'linkedin', person: dana, seed, thread: { firstOutboundAt } }),
        );
        expect(d.body).not.toMatch(/wrote on last week|on on |from on /);
      }
    }
    const dated = generateDraft(
      base({
        kind: 'bump',
        person: dana,
        styleCard: defaultStyleCard('formal', 'Alex'),
        thread: { firstOutboundAt: '2026-10-01T14:00:00Z' },
      }),
    );
    expect(dated.body).toMatch(/my note from Thursday/);
  });
});

describe('audit round 2 regressions', () => {
  const WED = new Date('2026-10-07T14:00:00Z'); // Wednesday 10am in New York
  const NY = 'America/New_York';

  it('whenLabel and sinceLabel use calendar weeks; the week before last is dated', () => {
    expect(whenLabel('2026-09-24T15:00:00Z', WED, NY)).toBe('on September 24');
    expect(whenLabel('2026-09-30T15:00:00Z', WED, NY)).toBe('last week'); // Wednesday a week ago
    expect(whenLabel('2026-10-02T15:00:00Z', WED, NY)).toBe('on Friday');
    expect(whenLabel('2026-10-06T15:00:00Z', WED, NY)).toBe('yesterday');
    expect(whenLabel('2025-12-01T15:00:00Z', WED, NY)).toBe('on December 1, 2025');
    expect(sinceLabel('2026-10-05T15:00:00Z', WED, NY)).toBe('earlier this week');
    expect(sinceLabel('2026-10-01T15:00:00Z', WED, NY)).toBe('last week');
    expect(sinceLabel('2026-09-24T15:00:00Z', WED, NY)).toBe('a couple of weeks ago');
    expect(sinceLabel('2026-09-10T15:00:00Z', WED, NY)).toBe('a few weeks ago');
    const ty = generateDraft(
      base({ kind: 'thank_you', facts: FACTS, now: WED, chat: { meetingAt: '2026-09-24T15:00:00Z' } }),
    );
    expect(ty.body).toMatch(/Thank you for making time on September 24/);
    const bump = generateDraft(
      base({
        kind: 'bump',
        now: WED,
        seed: 'b2',
        thread: { inThread: true, firstOutboundAt: '2026-09-24T14:00:00Z' },
      }),
    );
    expect(bump.body).not.toMatch(/last week/);
    const undated = generateDraft(base({ kind: 'bump', now: WED, seed: 'b2', thread: { inThread: true } }));
    expect(undated.body).not.toMatch(/last week|from on/);
  });

  it('thank-you states what they said and never what the student felt or did', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const over of [
        { facts: FACTS },
        { facts: [], takeaway: 'to lead every interview answer with one project story' },
        { facts: [fact('h', 'hook', 'they are hiring interns in January')] },
      ]) {
        const d = generateDraft(
          base({ kind: 'thank_you', seed, chat: { meetingAt: '2026-10-05T19:00:00Z' }, ...over }),
        );
        expect(d.body).not.toMatch(
          /putting it to use|started acting|acting on it|hadn't heard|kept thinking|keep coming back|this week/i,
        );
        expect(d.needsInput).toEqual([]);
      }
    }
    const t = generateDraft(
      base({
        kind: 'thank_you',
        seed: 'a',
        facts: [],
        takeaway: 'to lead every interview answer with one project story',
        chat: { meetingAt: '2026-10-05T19:00:00Z' },
      }),
    );
    expect(t.body).toMatch(/your advice to lead every interview answer with one project story/);
  });

  it('alumni and research openers never claim how the student found the person', () => {
    const found =
      /alumni page|alumni database|came across your profile|found you|while (reading|looking|researching)/i;
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const channel of ['gmail', 'linkedin'] as const) {
        const alum = generateDraft(base({ seed, channel }));
        expect(alum.body, alum.body).not.toMatch(found);
        expect(alum.bodyShort ?? '', alum.bodyShort).not.toMatch(found);
        const trans = generateDraft(
          base({
            seed,
            channel,
            person: { ...base().person, isAlumni: false, previousOrg: 'Goldman Sachs' },
          }),
        );
        expect(trans.body).not.toMatch(found);
        const hook = generateDraft(
          base({
            seed,
            channel,
            person: { ...base().person, isAlumni: false },
            facts: [fact('h', 'hook', 'they are hiring interns in January')],
          }),
        );
        expect(hook.body).not.toMatch(found);
      }
    }
    const note = generateDraft(base({ seed: 'a', channel: 'linkedin' })).bodyShort!;
    expect(note.match(/Cornell/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('a past proposed time is dated, and a meeting already on the calendar is confirmed, not moved', () => {
    const thread = {
      inThread: true,
      lastSignal: 'scheduling_proposal',
      proposedTimes: [{ startIso: '2026-10-01T15:30:00Z', raw: 'tomorrow 11:30' }],
    };
    const past = generateDraft(
      base({
        kind: 'reply',
        now: WED,
        thread,
        proposedWindows: [{ startIso: '2026-10-09T14:00:00Z' }, { startIso: '2026-10-13T19:30:00Z' }],
      }),
    );
    expect(past.body).toMatch(/Thursday, Oct 1 at 11:30am has already passed/);
    expect(past.body).not.toMatch(/come and gone/);
    const booked = generateDraft(
      base({
        kind: 'reply',
        now: WED,
        thread,
        busy: [{ startIso: '2026-10-08T15:30:00Z', endIso: '2026-10-08T16:00:00Z', withPerson: true }],
        chat: { upcomingAt: '2026-10-08T15:30:00Z' },
        proposedWindows: [{ startIso: '2026-10-09T14:00:00Z' }],
      }),
    );
    expect(booked.body).toMatch(/I have us down for Thursday, Oct 8 at 11:30am EDT\./);
    // who sent the invite is not in the data (L39)
    expect(booked.body).not.toMatch(/invite/);
    expect(booked.body).not.toMatch(/instead|Friday|has already passed/);
    // they propose the very time that is already on the calendar with them: that is not a clash
    const same = generateDraft(
      base({
        kind: 'reply',
        now: WED,
        thread: { ...thread, proposedTimes: [{ startIso: '2026-10-08T15:30:00Z', raw: 'Thursday 11:30' }] },
        busy: [{ startIso: '2026-10-08T15:30:00Z', endIso: '2026-10-08T16:00:00Z', withPerson: true }],
        chat: { upcomingAt: '2026-10-08T15:30:00Z' },
      }),
    );
    expect(same.body).toMatch(/Thursday, Oct 8 at 11:30am EDT/);
    expect(same.body).not.toMatch(/tight for me|instead/);
  });

  it('congratulate: a same-company title change is a new role, and an observed change is not assumed recent', () => {
    const sameOrg = generateDraft(
      base({
        kind: 'congratulate',
        newAffiliation: {
          title: 'Staff Engineer',
          org: 'Figma',
          previousOrg: 'Figma',
          since: '2026-10-06',
          observed: true,
        },
      }),
    );
    expect(sameOrg.body).toMatch(/your new role as a staff engineer at Figma/i);
    expect(sameOrg.body).not.toMatch(/move to Figma|first few weeks/);
    expect(sameOrg.subject).toBe('Congratulations');
    const moved = generateDraft(
      base({
        kind: 'congratulate',
        newAffiliation: { title: 'Staff Engineer', org: 'Stripe', previousOrg: 'Figma', since: '2026-09-20' },
      }),
    );
    expect(moved.body).toMatch(/your move to Stripe/);
    expect(moved.body).toMatch(/first few weeks/);
  });

  it('congratulate: a legal suffix is not a new employer, and abbreviated titles read as words (L37)', () => {
    const promoted = generateDraft(
      base({
        kind: 'congratulate',
        newAffiliation: { title: 'Sr. Analytics Engineer', org: 'Anthropic PBC', previousOrg: 'Anthropic' },
      }),
    );
    expect(promoted.body).toMatch(/your new role as a senior analytics engineer at Anthropic\./);
    expect(promoted.body).not.toMatch(/move to|sr\./i);
    expect(promoted.subject).toBe('Congratulations');
    const vp = generateDraft(
      base({
        kind: 'congratulate',
        newAffiliation: { title: 'VP, Analytics', org: 'Stripe', previousOrg: 'Figma' },
      }),
    );
    expect(vp.body).toMatch(/your move to Stripe as a VP of analytics\./);
    expect(roleNoun('Jr. Data Analyst')).toBe('junior data analyst');
    expect(roleNoun('Software Engineer, Payments')).toBe('software engineer');
    expect(roleNoun('Vice President, Finance')).toBe('vice president of finance');
  });

  it('a typed takeaway in the first person still reads as a sentence (L38)', () => {
    const ty = (takeaway: string, seed = 'priya') =>
      generateDraft(
        base({ kind: 'thank_you', seed, takeaway, chat: { meetingAt: '2026-09-24T19:00:00Z' } }),
      ).body.split('\n\n')[1]!;
    for (const seed of ['priya', 'x1', 'k7']) {
      const line = ty('that I should learn SQL', seed);
      expect(line).toMatch(/your advice that I should learn SQL\./);
      expect(line).not.toMatch(/about I\b/);
    }
    expect(ty('I should talk to her manager Sam')).toMatch(
      /your advice that I should talk to your manager Sam/,
    );
    expect(ty('I learned that recruiting starts in August')).toMatch(
      /your point that recruiting starts in August/,
    );
    expect(ty('my resume needs a projects section')).toMatch(
      /your point that my resume needs a projects section/,
    );
    expect(ty('I loved the story about Stripe')).toBe(
      'Thank you for making time on September 24, and especially for everything you shared. I loved the story about Stripe.',
    );
    expect(ty("I can't stop thinking about the Stripe story")).not.toMatch(/your (point|advice) that/);
    // the forms that already worked are unchanged
    expect(ty('to lead with a project')).toMatch(/your advice to lead with a project/);
  });

  it('a typed takeaway turns only pronouns that can mean the recipient into "you" (L38)', () => {
    const ty = (takeaway: string) =>
      generateDraft(
        base({ kind: 'thank_you', takeaway, chat: { meetingAt: '2026-09-24T19:00:00Z' } }),
      ).body.split('\n\n')[1]!;
    // a third party named before the pronoun owns it: the student's words are kept
    const jenna = ty('I should email Jenna and ask about her team');
    expect(jenna).toMatch(/your advice that I should email Jenna and ask about her team\./);
    expect(jenna).not.toMatch(/your team/);
    expect(ty('I should ask my roommate about his internship')).toMatch(/about his internship/);
    expect(ty('I loved the story about Sam and his startup')).toMatch(/Sam and his startup/);
    expect(ty('I should ask if she is hiring and email her')).toMatch(/she is hiring and email her\./);
    // with nobody else in the sentence the pronoun is the recipient
    expect(ty('I should talk to her manager Sam')).toMatch(/talk to your manager Sam/);
    expect(ty('I should email her about the role')).toMatch(/I should email you about the role\./);
    expect(ty('I should ask her about Priya')).not.toMatch(/ask your\b/);
    expect(ty('I should follow up with him next month')).toMatch(/follow up with you next month/);
  });

  it("a first-person takeaway thank-you is long enough for Orbit's own length check (L38)", () => {
    for (const takeaway of ['I loved the story about Stripe', "I'm going to apply to Figma"])
      for (const seed of ['priya', 'x1', 'k7', 'z9', 'm3']) {
        const { d, issues } = check(
          base({ kind: 'thank_you', seed, takeaway, chat: { meetingAt: '2026-09-24T19:00:00Z' } }),
        );
        expect(d.body).toContain(`${takeaway}.`);
        expect(issues.map((i) => i.code)).not.toContain('too_short');
      }
  });

  it('a time-limited decline gives a re-engagement date; the second try quotes only what they said (EG-20)', () => {
    const said = new Date(2026, 8, 19, 10); // Sep 19, local
    const q = declineReengage('Unfortunately I am not able to take calls this quarter. Best of luck!', said)!;
    expect(new Date(q.at).getMonth()).toBe(9); // October 1
    expect(new Date(q.at).getDate()).toBe(1);
    expect(q.said).toBe('this quarter');
    const jan = declineReengage("I'm swamped until January, sorry.", said)!;
    expect(new Date(jan.at).getFullYear()).toBe(2027);
    expect(new Date(jan.at).getMonth()).toBe(0);
    expect(declineReengage('Thanks, but I will pass.', said)).toBeUndefined();
    const d = generateDraft(
      base({
        kind: 'nurture',
        now: new Date('2026-10-20T14:00:00Z'),
        thread: { inThread: true },
        reengage: { said: q.said, past: q.past, at: said.toISOString() },
      }),
    );
    expect(d.needsInput).toEqual([]);
    expect(d.body).toMatch(/you mentioned last quarter wasn't a good time, so I wanted to try once more/);
    expect(d.body).toMatch(/\b20 minutes/); // an alum: 20
    expect(d.body).not.toMatch(/\[|No reply needed/);
  });
});

describe('financeFirmKind', () => {
  it('tells banks apart from venture, buyout and trading firms', () => {
    expect(financeFirmKind('Goldman Sachs')).toBe('bank');
    expect(financeFirmKind('Sequoia Capital')).toBe('vc');
    expect(financeFirmKind('Blackstone')).toBe('pe');
    expect(financeFirmKind('Bain Capital')).toBe('pe');
    expect(financeFirmKind('Citadel')).toBe('trading');
    expect(financeFirmKind('Citi')).toBe('bank');
    expect(financeFirmKind('Ramp')).toBeUndefined();
    expect(financeFirmKind(undefined)).toBeUndefined();
  });
});

describe('wordsIn', () => {
  it('counts a one-paragraph LinkedIn note, leaving out only the greeting', () => {
    expect(
      wordsIn(
        'Hi Noah, I read your post on onboarding and liked the point about shipping early. Open to a short chat?',
      ),
    ).toBe(18);
    expect(wordsIn('Hi Noah,\n\nOne line here.\n\nThanks,\nAlex')).toBe(3);
  });
});

describe('usability round 2: thank-you phrasing from typed notes', () => {
  it('"recommended I read X" is the advice to read X, and "their" after a company stays the company\'s', () => {
    const c = clause('She recommended I read the Ramp engineering blog post on their ledger', {
      firstName: 'Lena',
      fullName: 'Lena Novak',
    });
    expect(pointPhrase(c)).toBe('your advice to read the Ramp engineering blog post on their ledger');
    // with no company named, "their" is still the person's
    expect(clause('They recommended reading their team blog', { firstName: 'Lena' })?.text).toBe(
      'you recommended reading your team blog',
    );
  });
  it('a two-part promise keeps one "I\'ll"', () => {
    expect(promiseLine('Send her my resume by Friday and share my side project link')).toBe(
      "As promised, I'll send you my resume by Friday and share my side project link.",
    );
  });
});
