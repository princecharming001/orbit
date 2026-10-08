import { describe, expect, it } from 'vitest';
import corpus from '../drafts/corpus.json';
import { questionsFor } from '../drafts/register';
import { BANNED_PHRASES, type DraftContext, firmHook, generateDraft } from '../drafts/templates';
import { inboundNeedsAnswer } from '../drafts/thread';
import { composeKinds } from '../pipeline/transitions';
import { defaultStyleCard } from '../style/card';
import type { PersonFact } from '../types';

/**
 * Regressions for the patterns the expert panel (banker, consultant, tech referrer, career coach) found in round 3
 * of the drafts review. Each test pins a root cause across sectors, seniorities and kinds, never one draft.
 */

const NOW = new Date('2026-10-07T14:00:00Z'); // Wednesday
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const fact = (id: string, type: PersonFact['type'], text: string, daysAgo = 3): PersonFact => ({
  id,
  userId: 'u',
  personId: 'p',
  type,
  text,
  sourceTable: 'notes',
  sourceId: 'n',
  confidence: 0.8,
  occurredAt: ago(daysAgo),
  createdAt: ago(daysAgo),
});
type PersonOver = Partial<DraftContext['person']>;
const base = (over: Partial<DraftContext> = {}, person: PersonOver = {}): DraftContext => ({
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
    pastOrgs: [],
  },
  styleCard: defaultStyleCard('warm', 'Alex'),
  person: {
    firstName: 'Noor',
    lastName: 'Haddad',
    fullName: 'Noor Haddad',
    title: 'Software Engineer',
    org: 'Linear',
    isAlumni: false,
    relationshipType: 'unknown',
    strength: 0.3,
    ...person,
  },
  facts: [],
  kind: 'outreach',
  channel: 'gmail',
  now: NOW,
  seed: 'n1',
  ...over,
});
const SEEDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const IB = { ...base().user, majors: ['Economics'], targetFunctions: ['ib'] };
const STYLES = ['warm', 'direct', 'formal'] as const;
const SENIOR_BANKERS: PersonOver[] = [
  { title: 'Vice President', org: 'Morgan Stanley', group: 'Healthcare' },
  { title: 'Director', org: 'Centerview Partners' },
  { title: 'Managing Director', org: 'J.P. Morgan', group: 'Leveraged Finance' },
];
const ROLE = (text: string) => fact('r', 'role_detail', text, 10);

describe('banking: judgment from seniors, seats from recruiters', () => {
  it('a VP, director or MD is never asked about seats, off-cycle or diversity programs, whatever the link', () => {
    for (const p of SENIOR_BANKERS)
      for (const seed of SEEDS)
        for (const chat of [
          undefined,
          { referrerName: 'Mei Chen' },
          { referrerName: 'Mei Chen', introducedAt: ago(3) },
        ])
          for (const isAlumni of [true, false]) {
            const d = generateDraft(
              base(
                {
                  seed,
                  user: IB,
                  chat,
                  facts:
                    isAlumni || chat
                      ? []
                      : [
                          fact(
                            'c',
                            'connection',
                            'I heard you speak on the Cornell finance club panel last spring',
                          ),
                        ],
                },
                { ...p, isAlumni },
              ),
            );
            const text = `${d.body}\n${d.bodyShort ?? ''}`;
            expect(text, `${p.title} ${seed}`).not.toMatch(
              /diversity|still brings? on|seats|off-cycle|missed the main|before recruiting starts/,
            );
          }
  });
  it('an application already in is never followed by a question about the cycle', () => {
    const d = generateDraft(
      base(
        {
          user: IB,
          chat: { referrerName: 'Mei Chen', introducedAt: ago(2) },
          kind: 'referral_ask',
          targetCompany: { name: 'Morgan Stanley', roleLabel: 'Summer Analyst', applied: true },
        },
        SENIOR_BANKERS[0],
      ),
    );
    expect(d.body).toMatch(/I've applied for Morgan Stanley's summer analyst role\./);
    expect(d.body).not.toMatch(/this late|from here|recruiting starts|in my position/);
    expect(d.body).toMatch(/summer analysts? (who do well|to understand)/);
  });
  it('a recruiter hears the timing as the calendar has it, and nothing about diversity programs', () => {
    const d = generateDraft(
      base({ user: IB }, { title: 'Campus Recruiter', org: 'Goldman Sachs', relationshipType: 'recruiter' }),
    );
    expect(d.body).toMatch(/most Summer 2027 seats filled earlier this year/);
    expect(d.body).not.toMatch(/diversity|deadline|info session/);
    for (const q of questionsFor({ title: 'Analyst', org: 'Evercore', group: 'M&A' }, 'finance', {
      late: true,
    }))
      expect(q.q).not.toMatch(/missed|off-cycle now/);
  });
});

describe('register: the relationship and the student voice decide', () => {
  it('"Dear" only for a formal voice to a stranger senior at a bank; never "Dear ..., Cornell junior here"', () => {
    for (const style of STYLES)
      for (const [person, dear] of [
        [{ title: 'Managing Director', org: 'Evercore', relationshipType: 'cold' }, style === 'formal'],
        [{ title: 'Managing Director', org: 'Evercore', isAlumni: true, relationshipType: 'alumni' }, false],
        [{ title: 'Partner', org: 'McKinsey & Company' }, false],
        [{ title: 'Head of Quantitative Research', org: 'Hudson River Trading' }, false],
        [{ title: 'General Partner', org: 'Founders Fund' }, false],
        [{ title: 'CTO', org: 'Mercury' }, false],
      ] as [PersonOver, boolean][]) {
        const d = generateDraft(
          base(
            {
              styleCard: defaultStyleCard(style, 'Alex'),
              facts: [fact('c', 'connection', 'I heard you speak on the Cornell club panel last spring')],
            },
            person,
          ),
        );
        expect(d.body.startsWith('Dear '), `${style} ${person.title} ${person.org}`).toBe(dear);
        expect(d.body).not.toMatch(/^Dear [^\n]+\n\n\w+ (junior|sophomore|senior) here/);
      }
  });
  it('someone who gave advice or made an offer knows the student, even with no meeting on record', () => {
    const d = generateDraft(
      base(
        {
          kind: 'congratulate',
          styleCard: defaultStyleCard('formal', 'Alex'),
          facts: [
            fact('a', 'advice', 'the key is knowing one deal on our coverage list cold before superday', 2),
          ],
          newAffiliation: {
            title: 'Managing Director',
            org: 'J.P. Morgan',
            since: ago(10),
            previousOrg: 'Deloitte',
          },
        },
        {
          title: 'Managing Director',
          org: 'J.P. Morgan',
          group: 'Leveraged Finance',
          relationshipType: 'cold',
        },
      ),
    );
    expect(d.body).toMatch(/^Hi Noor,/);
  });
});

describe('alumni and role notes', () => {
  it('an alum is a fellow alum of the school, never "an alum at" the firm, and the school is named once', () => {
    for (const seed of SEEDS)
      for (const [channel, linkedinConnected] of [
        ['gmail', undefined],
        ['linkedin', true],
        ['linkedin', false],
      ] as const) {
        const d = generateDraft(
          base(
            { seed, channel, facts: [ROLE('trades ETF options on the equities desk')] },
            {
              title: 'Quantitative Trader',
              org: 'Jane Street',
              isAlumni: true,
              relationshipType: 'alumni',
              linkedinConnected,
            },
          ),
        );
        const text = `${d.body}\n${d.bodyShort ?? ''}`;
        expect(text).not.toMatch(/an alum (at|in|on) |alum, now at Jane Street\. I built/);
        expect((d.body.match(/Cornell\b/g) ?? []).length).toBeLessThanOrEqual(
          1 + (d.body.match(/Cornell '28/g)?.length ?? 0),
        );
      }
  });
  it('a role note is the line about them, without hedges, and the question it raises is the ask', () => {
    for (const [title, org, note, question] of [
      [
        'Associate',
        'Evercore',
        'works mostly on sell-side processes for software companies',
        /how much of that work a summer analyst actually sees/,
      ],
      [
        'Business Analyst',
        'McKinsey & Company',
        'works mostly on healthcare operations studies',
        /how much of that work a first-year consultant actually owns/,
      ],
      [
        'Software Engineer',
        'Google',
        'works on query understanding for Search',
        /what part of that work an intern could realistically own/,
      ],
      [
        'Quantitative Researcher',
        'Citadel Securities',
        'works on market making models for options',
        /how much of that an intern actually gets to do/,
      ],
    ] as const)
      for (const seed of SEEDS) {
        const d = generateDraft(
          base(
            {
              seed,
              user:
                org === 'Evercore'
                  ? IB
                  : org === 'Citadel Securities'
                    ? { ...base().user, targetFunctions: ['quant'] }
                    : org.startsWith('McKinsey')
                      ? { ...base().user, targetFunctions: ['consulting'] }
                      : base().user,
              chat: { referrerName: 'Mei Chen' },
              facts: [ROLE(note)],
            },
            { title, org },
          ),
        );
        expect(d.body, `${org} ${seed}`).toMatch(/I saw that you work on /);
        expect(d.body).toMatch(question);
        expect(d.body).not.toMatch(/mostly|day to day|what working/);
        expect(d.claims.some((c) => c.factId === 'r')).toBe(true);
      }
  });
  it('a role note that only restates the title is not used', () => {
    const d = generateDraft(
      base(
        { facts: [ROLE('leads the engineering team')] },
        { title: 'CTO', org: 'Mercury', isAlumni: true, relationshipType: 'alumni' },
      ),
    );
    expect(d.body).not.toMatch(/engineering team/);
  });
});

describe('the ask fits the person', () => {
  it('a VP or head of engineering gets a pointer, a head of a desk one question from the student field, never return offers', () => {
    const vp = generateDraft(
      base(
        { facts: [] },
        { title: 'Vice President of Engineering', org: 'Apple', isAlumni: true, relationshipType: 'alumni' },
      ),
    );
    expect(vp.body).toMatch(
      /Is there someone on your team, maybe a recent intern or new grad, you'd suggest I talk to\?/i,
    );
    const quant = generateDraft(
      base(
        { user: { ...base().user, targetFunctions: ['quant'] } },
        {
          title: 'Head of Quantitative Research',
          org: 'Hudson River Trading',
          isAlumni: true,
          relationshipType: 'alumni',
        },
      ),
    );
    expect(quant.body).toMatch(/coming from computer science rather than math or statistics/);
    for (const title of [
      'Vice President of Engineering',
      'Engineering Manager',
      'Director of Engineering',
      'Partner',
      'Head of Quantitative Research',
    ])
      for (const seed of SEEDS)
        expect(
          generateDraft(
            base(
              { seed },
              {
                title,
                org: title === 'Partner' ? 'Jump Trading' : 'Microsoft',
                isAlumni: true,
                relationshipType: 'alumni',
              },
            ),
          ).body,
        ).not.toMatch(/return offers/);
  });
  it('a consultant partner is asked for judgment, never about the first-years they staff, and a CS major gets the question every interviewer will ask', () => {
    const qs = questionsFor(
      { title: 'Partner', org: 'McKinsey & Company', group: 'Healthcare practice' },
      'consulting',
      { major: 'Computer Science' },
    );
    expect(qs.map((q) => q.q).join(' ')).not.toMatch(/you staff|first-years you/);
    expect(qs.some((q) => /coming from computer science should prepare for case interviews/.test(q.q))).toBe(
      true,
    );
    expect(
      questionsFor({ title: 'Consultant', org: 'Bain & Company' }, 'consulting', { major: 'Economics' }).some(
        (q) => /coming from/.test(q.q),
      ),
    ).toBe(false);
  });
  it('a designer, an ops lead or a researcher is asked what only their seat can answer, and a move is never "the kind I am trying to understand"', () => {
    for (const [title, re] of [
      ['Product Designer', /what the engineers you work best with do differently/],
      ['Operations Manager', /how operations shapes what the product and engineering teams build/],
      ['Quantitative Researcher', /what the engineers who work closest with researchers/],
    ] as const)
      for (const seed of SEEDS) {
        const d = generateDraft(
          base(
            { seed },
            {
              title,
              org: title.startsWith('Quant') ? 'Jane Street' : 'Notion',
              previousOrg: 'Linear',
              previousTitle: 'Operations Associate',
            },
          ),
        );
        expect(d.body, `${title} ${seed}`).toMatch(re);
        expect(d.body).not.toMatch(
          /kind of move I'm trying to understand|path I'm trying to understand|how you ended up as a/,
        );
      }
  });
  it('an application on record goes in; a req number is for a recruiter', () => {
    const d = generateDraft(
      base(
        {
          targetCompany: {
            name: 'Ramp',
            roleLabel: 'Software Engineering Intern',
            applied: true,
            reqId: 'R-9',
          },
        },
        { org: 'Ramp', title: 'Product Designer', isAlumni: true, relationshipType: 'alumni' },
      ),
    );
    expect(d.body).toMatch(/I've applied for Ramp's software engineering internship\./);
    expect(d.body).not.toMatch(/R-9|recruiting for software engineering internships this cycle/);
  });
  it("a hiring note is the firm's, and the question is about it, never stated and dropped", () => {
    expect(firmHook("you're hiring your first two interns in January", 'Mercury')).toBe(
      'Mercury is hiring its first two interns in January',
    );
    for (const seed of SEEDS) {
      const d = generateDraft(
        base(
          { seed, facts: [fact('h', 'hook', 'they are hiring their first two interns in January')] },
          { title: 'CTO', org: 'Mercury', isAlumni: true, relationshipType: 'alumni' },
        ),
      );
      expect(d.body).toMatch(/I saw that Mercury is hiring its first two interns in January\./);
      expect(d.body).toMatch(/stand out for one of those spots\?/);
      expect(d.body).not.toMatch(/you're hiring|I also saw|early hires/);
    }
  });
  it('a post is asked about by name, never a dangling "it", and the subject says what the email is', () => {
    for (const seed of SEEDS) {
      const d = generateDraft(
        base(
          {
            seed,
            kind: 'referral_ask',
            facts: [
              fact('c', 'connection', 'I read your article on how new consultants learn to structure a case'),
            ],
            targetCompany: { name: 'BCG', roleLabel: 'Associate Intern', applied: true, reqId: 'R-1' },
          },
          { title: 'Engagement Manager', org: 'Boston Consulting Group' },
        ),
      );
      expect(d.body).not.toMatch(/about it\?|R-1/);
      expect(d.body).toMatch(/your article\?/);
      expect(d.subject).toMatch(/your article on how new consultants learn to structure a case/i);
      expect(d.subject).not.toMatch(/your path to/);
    }
  });
});

describe('LinkedIn messages', () => {
  it('end with one way to answer, in the chat they are reading, never email', () => {
    for (const seed of SEEDS)
      for (const [title, org] of [
        ['Vice President of Engineering', 'Apple'],
        ['Head of Quantitative Research', 'Hudson River Trading'],
        ['CTO', 'Mercury'],
        ['Associate', 'Evercore'],
        ['Consultant', 'Bain & Company'],
      ] as const) {
        const d = generateDraft(
          base(
            {
              seed,
              channel: 'linkedin',
              facts: [fact('h', 'hook', 'they are hiring their first two interns in January')],
            },
            {
              title,
              org,
              isAlumni: true,
              relationshipType: 'alumni',
              linkedinConnected: true,
              linkedinConnectedAt: ago(3),
            },
          ),
        );
        expect(d.body, `${title} ${seed}`).not.toMatch(/email/i);
        expect(d.body.match(/easier/g)?.length ?? 0).toBeLessThanOrEqual(1);
        expect(d.body).not.toMatch(/Even a line back would help/);
      }
  });
  it('a connection note keeps the question a post raised when it fits', () => {
    const d = generateDraft(
      base(
        {
          channel: 'linkedin',
          facts: [fact('c', 'connection', 'I watched your talk on scaling the indexing pipeline')],
        },
        { linkedinConnected: false },
      ),
    );
    expect(d.bodyShort).toMatch(/what part of that work an intern could realistically own/);
    expect(d.bodyShort!.length).toBeLessThanOrEqual(200);
    expect(d.bodyShort).not.toMatch(/talk about your talk/);
  });
});

describe('introductions', () => {
  it('an introduction made by email is answered on that email with the introducer in bcc, even when LinkedIn was asked', () => {
    for (const linkedinConnected of [true, false]) {
      const d = generateDraft(
        base(
          { channel: 'linkedin', chat: { referrerName: 'Mei Chen', introducedAt: ago(3) } },
          { linkedinConnected },
        ),
      );
      expect(d.channel).toBe('gmail');
      expect(d.introReply).toEqual({ bcc: 'Mei' });
      expect(d.body).toMatch(/^Thanks for the introduction, Mei \(moving you to bcc\)\.\n\nHi Noor,/);
      expect(d.body).not.toMatch(/introduced us by email|great to meet you here/);
    }
  });
  it('a referrer is someone the recipient can place, when the data says who they are', () => {
    const d = generateDraft(
      base({ chat: { referrerName: 'Mei Chen', referrerTie: "who's also at Linear" } }),
    );
    expect(d.body).toMatch(/Mei Chen, who's also at Linear, suggested I/);
    const bump = generateDraft(
      base({
        kind: 'bump',
        chat: { referrerName: 'Mei Chen' },
        thread: { firstOutboundAt: ago(6), inThread: true },
      }),
    );
    expect(bump.body).toMatch(/the note I sent at Mei's suggestion/);
    expect(bump.body).not.toMatch(/Mei suggested I write to you, so/);
  });
  it('an intro request to a colleague names no title, and thanks them for the chat first', () => {
    const d = generateDraft(
      base(
        {
          kind: 'intro_request',
          chat: { meetingAt: ago(7) },
          target: { name: 'Lucas Fischer', firstName: 'Lucas', title: 'Vice President', org: 'Evercore' },
        },
        { title: 'Associate', org: 'Evercore' },
      ),
    );
    expect(d.body).toMatch(
      /^Hi Noor,\n\nThanks again for talking with me last week\. One small ask: would you be comfortable introducing me to Lucas Fischer\?/,
    );
    expect(d.body).not.toMatch(/a Vice President at Evercore/);
  });
});

describe('congratulations pick the thread back up', () => {
  const MOVE = { title: 'Principal', org: 'Oliver Wyman', since: ago(10), previousOrg: 'Deloitte' };
  it('never a one-line alert, never the employer they left, and an offer they made is taken up gently', () => {
    for (const seed of SEEDS) {
      const d = generateDraft(
        base(
          {
            seed,
            kind: 'congratulate',
            facts: [
              fact('a', 'advice', 'the key is structuring the case out loud before doing any math', 2),
              fact('o', 'offer', 'offered to do a practice case with me before first rounds', 2),
            ],
            newAffiliation: MOVE,
          },
          { title: 'Principal', org: 'Oliver Wyman', group: 'Financial Services practice' },
        ),
      );
      expect(d.body).not.toMatch(/Deloitte|your move from|as a principal\./);
      expect(d.body).toMatch(/Congratulations on (joining|the move to) Oliver Wyman/);
      expect(d.body).toMatch(/Thanks again for your point about structuring the case out loud/);
      expect(d.body).toMatch(
        /Once you've settled in, if your offer to do a practice case with me before first rounds still stands/,
      );
      expect(d.body.split(/\s+/).length).toBeGreaterThan(40);
    }
  });
  it('a referral promised for when the posting goes up waits for the posting', () => {
    const d = generateDraft(
      base({
        kind: 'congratulate',
        facts: [fact('o', 'offer', 'offered to refer me when the posting goes up', 2)],
        newAffiliation: {
          title: 'Staff Software Engineer',
          org: 'Microsoft',
          since: ago(10),
          previousOrg: 'Deloitte',
        },
      }),
    );
    expect(d.body).toMatch(
      /Once the posting is up, I'll send it your way, if your offer to refer me still stands\./,
    );
  });
});

describe('check-ins have one purpose', () => {
  it('an offer taken up is never followed by "No reply needed" or a line about their team', () => {
    for (const offer of [
      'offered to pass my resume to the summer analyst recruiting team',
      'offered to introduce me to their hiring manager',
      'offered to tell me which desks take interns',
      'offered to share the memo template their team uses',
    ])
      for (const seed of SEEDS) {
        const d = generateDraft(
          base({
            seed,
            kind: 'nurture',
            chat: { meetingAt: ago(42) },
            update: 'I accepted a spring research position with my professor',
            facts: [
              fact('o', 'offer', offer, 2),
              fact(
                'h',
                'hook',
                'their team is migrating its services to a new deployment system this quarter',
                4,
              ),
            ],
          }),
        );
        expect(d.body, offer).not.toMatch(/No reply needed|No need to reply|migrating|I also saw/);
        expect(d.body).not.toMatch(/your hiring manager/);
      }
  });
  it("a note about their team's internal work is never written back, even with nothing else to say", () => {
    const d = generateDraft(
      base({
        kind: 'nurture',
        chat: { meetingAt: ago(42) },
        update: 'I accepted a spring research position with my professor',
        facts: [
          fact(
            'h',
            'hook',
            'their team is migrating its services to a new deployment system this quarter',
            4,
          ),
        ],
      }),
    );
    expect(d.body).not.toMatch(/migrating/);
  });
  it('a quiet thread picked back up thanks the introducer and names the chat as people say it; "recruiting this cycle" is no update', () => {
    const d = generateDraft(
      base({
        kind: 'nurture',
        reopen: true,
        chat: { meetingAt: ago(60), referrerName: 'Sofia Bennett' },
        thread: {
          lastInboundBody: 'Glad it helped.',
          lastInboundAt: ago(58),
          inThread: true,
          subject: 'Cornell CS junior, Postgres or Elasticsearch?',
        },
      }),
    );
    expect(d.body).toMatch(
      /Thanks again for talking with me in August after Sofia's intro about choosing between Postgres and Elasticsearch\./,
    );
    expect(d.needsInput).toContain('update');
    expect(d.body).not.toMatch(/I'm recruiting for/);
  });
  it('a check-in with nothing only true of them asks the student for one thing from the conversation', () => {
    const d = generateDraft(
      base({
        kind: 'nurture',
        chat: { meetingAt: ago(60) },
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(d.needsInput).toContain('takeaway');
    const filled = generateDraft(
      base({
        kind: 'nurture',
        chat: { meetingAt: ago(60) },
        takeaway: 'to ship one small project end to end before applying',
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(filled.needsInput).toEqual([]);
    expect(filled.body).toMatch(
      /Thanks again for your advice to ship one small project end to end before applying\./,
    );
  });
  it('a time they proposed months ago waits on nothing, and a scheduling note is not written to it', () => {
    const thread = {
      lastInboundBody: 'Can you do Friday at 3pm?',
      lastInboundAt: ago(130),
      proposedTimes: [{ startIso: ago(128), raw: 'Friday at 3pm' }],
      asksOfUser: ['Can you do Friday at 3pm?'],
      lastSignal: 'scheduling_proposal',
      inThread: true,
    };
    expect(inboundNeedsAnswer(thread, NOW)).toBe(false);
    const d = generateDraft(base({ kind: 'schedule', chat: { meetingAt: ago(129) }, thread }));
    expect(d.kind).toBe('nurture');
    expect(d.body).not.toMatch(/slow reply|has already passed|Your answer to/);
  });
});

describe('closing loops honestly', () => {
  it('a report-back promises once, never reports a non-event as an action, and asks for one thing from the call', () => {
    const noReply = generateDraft(
      base({ kind: 'report_back', reportBack: { targetName: 'Lucas Fischer', outcome: 'no_reply' } }),
    );
    expect(noReply.body.match(/keep you posted|let you know/g)).toHaveLength(1);
    expect(noReply.body).not.toMatch(/followed up/);
    const spoke = generateDraft(
      base({
        kind: 'report_back',
        reportBack: { targetName: 'Lucas Fischer', outcome: 'spoke', when: 'on Tuesday' },
      }),
    );
    expect(spoke.needsInput).toEqual(['takeaway']);
    expect(spoke.body).toMatch(/We spoke on Tuesday, and \[one thing Lucas said/);
  });
  it('a last bump restates the ask with the cheapest way to answer, and never "I promise" or "leave you be"', () => {
    for (const relationshipType of ['friend', 'alumni', 'unknown'])
      for (const seed of SEEDS) {
        const d = generateDraft(
          base(
            { seed, kind: 'bump', bumpNumber: 2, thread: { firstOutboundAt: ago(13), inThread: true } },
            { relationshipType, strength: relationshipType === 'friend' ? 0.7 : 0.3, group: 'Payments' },
          ),
        );
        expect(d.body).not.toMatch(/I promise|leave you be|nudge/);
        expect(d.body).toMatch(/by email/);
      }
  });
  it('a bump held for an out-of-office return is dated as of the day it goes out', () => {
    const d = generateDraft(
      base({
        kind: 'bump',
        chat: { awayUntil: '2026-10-12' },
        thread: {
          lastSignal: 'out_of_office',
          lastInboundAt: ago(2),
          firstOutboundAt: ago(1.9),
          inThread: true,
        },
      }),
    );
    // sent Oct 14, the note of Oct 5 is "last week", never "Monday"
    expect(d.body).toMatch(/my note from last week/);
  });
  it("a note after the student's own unanswered one leads with the news and says to wait", () => {
    const d = generateDraft(
      base(
        {
          history: { lastAt: ago(2), lastInbound: false, repliedEver: true },
          targetCompany: { name: 'Ramp', roleLabel: 'Software Engineering Intern', applied: true },
          sameOrgContacts: [{ name: 'Lena Novak', title: 'Engineering Manager' }],
        },
        { title: 'University Recruiter', org: 'Ramp', relationshipType: 'recruiter' },
      ),
    );
    expect(d.body).toMatch(
      /A quick update since my note on Monday: I've applied for the Software Engineering Intern role at Ramp, and I've spoken with Lena Novak, an engineering manager there\./,
    );
    expect(d.body).not.toMatch(/We traded emails/);
    // five business days from Monday Oct 5, with the Oct 12 holiday skipped
    expect(d.holdUntil?.slice(0, 10)).toBe('2026-10-13');
  });
});

describe('scheduling', () => {
  it('a time given without a zone is confirmed as given, and a video call they asked for is not offered as a phone call', () => {
    const d = generateDraft(
      base({
        kind: 'reply',
        thread: {
          lastInboundBody: 'Does Thursday at 3pm work? Zoom is easiest for me.',
          lastInboundAt: ago(1),
          lastSignal: 'scheduling_proposal',
          proposedTimes: [{ startIso: '2026-10-08T19:00:00Z', raw: 'Thursday at 3pm' }],
          inThread: true,
        },
      }),
    );
    expect(d.body).toMatch(
      /Thursday, Oct 8 at 3pm works\. I'll send a calendar invite for 3pm EDT with a video link; if you meant another time zone, just say so\./,
    );
    expect(d.body).not.toMatch(/phone/);
  });
});

describe('the composer', () => {
  it('offers a referral ask only when something on record makes it fit, and an unfit one becomes the check-in', () => {
    expect(composeKinds('nurturing', 'nurture', { referral: false })).not.toContain('referral_ask');
    expect(composeKinds('nurturing', 'nurture', { referral: true })).toContain('referral_ask');
    expect(composeKinds('nurturing', 'referral_ask', { referral: false })).toContain('referral_ask');
    const d = generateDraft(
      base(
        { kind: 'referral_ask', chat: { meetingAt: ago(120) } },
        { title: 'Vice President, M&A', org: 'Goldman Sachs' },
      ),
    );
    expect(d.kind).toBe('nurture');
    expect(d.body).not.toMatch(/\[role|check-in fits better|refer/);
  });
});

describe('the exemplars added from the round-3 panel rewrites', () => {
  it('hold no banned phrase or dash, and use placeholders, never names', () => {
    const added = (corpus as { body: string; subject?: string | null; source: string }[]).filter((e) =>
      /panel round 3/i.test(e.source),
    );
    expect(added.length).toBeGreaterThanOrEqual(8);
    for (const e of added) {
      const t = `${e.subject ?? ''}\n${e.body}`.toLowerCase();
      for (const b of BANNED_PHRASES) expect(t).not.toContain(b);
      expect(t).not.toMatch(/[—–]/);
      expect(e.body).toMatch(/\{first\}/);
      expect(e.body).not.toMatch(/\b(Alex|Mei|Lucas|Deloitte|Cornell)\b/);
    }
  });
});
