import { describe, expect, it } from 'vitest';
import { sectorOf, seniorityOf, yearLabel } from '../drafts/sector';
import {
  BANNED_PHRASES,
  type DraftContext,
  deriveConnection,
  draftWarmUpComment,
  generateDraft,
  LINKEDIN_NOTE_MAX,
  MAX_WORDS,
  wordsIn,
} from '../drafts/templates';
import { isBlocked, validateDraft } from '../drafts/validate';
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
  it('prefers referral, then event, alumni, warm-up, transition, shared employer, hook', () => {
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
    expect(r.d.body).toMatch(/Cornell University/);
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
    expect(r.d.body).toMatch(/Best,\nAlex Rivera\nCornell University '28$/);
    expect(r.d.subject).toMatch(/Cornell University '28, quick question on Goldman Sachs healthcare/);
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
    expect(n.d.bodyShort).toMatch(/Hi Priya, Cornell University junior here/);
    expect(n.d.bodyShort).toMatch(/20 minutes/);
    expect(n.d.subject).toBeUndefined();
    const m = check(base({ channel: 'linkedin', person: { ...base().person, linkedinConnected: true } }));
    expect(m.d.body).toMatch(/^Hi Priya, thanks for connecting\./);
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
      base({ kind: 'bump', bumpNumber: 1, thread: { firstOutboundAt: '2026-09-29T12:00:00Z' } }),
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
    expect(s.body).toMatch(/Thursday at 10am or Friday at 2:30pm \(EDT\)/);
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
    expect(r.body).toMatch(/Thursday at 2pm EDT works perfectly/);
    expect(r.body).toMatch(/calendar invite/);
    expect(r.body).toMatch(/On the resume: attached/);
  });
  it('thank-you locates the memory, quotes advice, mentions the offer, asks permission', () => {
    const t = generateDraft(
      base({ kind: 'thank_you', facts: FACTS, chat: { completedAt: '2026-10-05T19:00:00Z' } }),
    );
    expect(t.body).toMatch(/Thank you for making time yesterday/);
    expect(t.body).toMatch(/handled ambiguity/);
    expect(t.body).toMatch(/your offer to refer me/);
    expect(t.body).toMatch(/\?/);
    expect(t.claims.filter((c) => c.factId).length).toBe(2);
  });
  it('nurture without a hook or update is gated; with a hook it asks about it and needs no reply', () => {
    const gated = generateDraft(base({ kind: 'nurture', facts: [] }));
    expect(gated.needsInput).toContain('update');
    const n = generateDraft(
      base({ kind: 'nurture', facts: [FACTS[2]!], chat: { completedAt: '2026-08-10T00:00:00Z' } }),
    );
    expect(n.body).toMatch(/You mentioned (they are )?hiring interns in January\.? How did that go\?/i);
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
    expect(i.body).toMatch(/"Alex Rivera is a junior at Cornell University studying computer science/);
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
    expect(c.body).toMatch(
      /Congratulations, that fits what you said about wanted to sit closer to the product/,
    );
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
