import { describe, expect, it } from 'vitest';
import { theirWords } from '../drafts/phrasing';
import { questionsFor } from '../drafts/register';
import { firmKindOf, sectorOf } from '../drafts/sector';
import {
  contextText,
  type DraftContext,
  earliestFor,
  generateDraft,
  LINKEDIN_NOTE_MAX,
  proposeWindows,
  rereadTime,
} from '../drafts/templates';
import { validateDraft } from '../drafts/validate';
import { defaultStyleCard } from '../style/card';
import type { PersonFact } from '../types';

/**
 * Regressions for the patterns an expert panel found across 300 generated drafts (round 1 of the drafts review):
 * each test pins the root cause, not one draft.
 */

const NOW = new Date('2026-10-07T14:00:00Z'); // Wednesday
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
    firstName: 'Priya',
    lastName: 'Patel',
    fullName: 'Priya Patel',
    title: 'Software Engineer',
    org: 'Stripe',
    isAlumni: true,
    relationshipType: 'alumni',
    strength: 0.3,
    ...person,
  },
  facts: [],
  kind: 'outreach',
  channel: 'gmail',
  now: NOW,
  seed: 'p1',
  ...over,
});
const issuesOf = (ctx: DraftContext, body?: string) => {
  const d = generateDraft(ctx);
  return validateDraft(
    { ...d, body: body ?? d.body },
    {
      kind: ctx.kind,
      facts: ctx.facts,
      allowedUrls: [],
      recipientFirstName: ctx.person.firstName,
      recipientFullName: ctx.person.fullName,
      channel: ctx.channel,
      context: contextText(ctx),
    },
  );
};
const SEEDS = Array.from({ length: 24 }, (_, i) => `seed-${i}`);

describe('confirming a time they proposed', () => {
  const thread = (startIso: string, lastInboundAt?: string): DraftContext['thread'] => ({
    lastInboundBody: 'Sure, does Thursday at 3pm work?',
    lastInboundAt,
    lastSignal: 'scheduling_proposal',
    proposedTimes: [{ startIso, raw: 'Thursday at 3pm' }],
    inThread: true,
  });
  it('confirms the day and time in their words when the stored time disagrees with them', () => {
    // stored: Friday Oct 9 at 11am EDT; they wrote "Thursday at 3pm" on Tuesday Oct 6
    const d = generateDraft(
      base({ kind: 'reply', thread: thread('2026-10-09T15:00:00Z', '2026-10-06T16:00:00Z') }),
    );
    expect(d.body).toMatch(/Thursday, Oct 8 at 3pm EDT works/);
    expect(d.body).not.toMatch(/Friday|11am/);
  });
  it('keeps a stored time that matches the words', () => {
    const d = generateDraft(
      base({ kind: 'reply', thread: thread('2026-10-08T19:00:00Z', '2026-10-06T16:00:00Z') }),
    );
    expect(d.body).toMatch(/Thursday, Oct 8 at 3pm EDT works/);
  });
  it('without the moment they wrote it, a weekday that contradicts the stored day is confirmed as written', () => {
    const d = generateDraft(base({ kind: 'reply', thread: thread('2026-10-09T15:00:00Z') }));
    expect(d.body).toMatch(/Thursday at 3pm works\./);
    expect(d.body).not.toMatch(/Friday/);
    expect(
      rereadTime({ startIso: '2026-10-09T15:00:00Z', raw: 'Thursday at 3pm' }, undefined, 'America/New_York'),
    ).toMatchObject({ unreadable: true });
  });
});

describe('nurture', () => {
  it('never ties the update to their advice, and never asks a question before "No reply needed"', () => {
    const facts = [
      fact('a', 'advice', 'the key is knowing one deal on our coverage list cold before superday'),
      fact('h', 'hook', 'they are migrating the team to a new deployment system this quarter'),
    ];
    for (const seed of SEEDS) {
      const d = generateDraft(
        base(
          {
            kind: 'nurture',
            facts,
            seed,
            update: 'I accepted a spring research position with my professor',
            chat: { completedAt: '2026-08-20T15:00:00Z' },
          },
          { title: 'Software Engineer', org: 'Stripe' },
        ),
      );
      expect(d.body).not.toMatch(/big part of|because of your|thanks to your/i);
      expect(d.body).not.toMatch(/\?/);
      expect(d.body).toMatch(/No reply needed/);
    }
  });
  it('never mentions a live deal or a fundraise to a banker or an investor', () => {
    for (const [title, org, hook] of [
      ['Managing Director', 'J.P. Morgan', 'their group is closing a large software take-private this month'],
      ['General Partner', 'Founders Fund', 'they are raising a new early-stage fund this fall'],
    ] as const) {
      const d = generateDraft(
        base(
          {
            kind: 'nurture',
            facts: [fact('h', 'hook', hook)],
            update: 'I accepted a spring research position',
            chat: { completedAt: '2026-08-20T15:00:00Z' },
          },
          { title, org },
        ),
      );
      expect(d.body).not.toMatch(/take-private|raising|fund this fall/);
      expect(d.body).toMatch(new RegExp(`Hope things are going well at ${org.replace('.', '\\.')}`));
    }
  });
  it('a check-in with nothing to say is still a sentence to finish, with a line about them', () => {
    const d = generateDraft(
      base(
        {
          kind: 'nurture',
          chat: { completedAt: '2026-08-20T15:00:00Z' },
          newAffiliation: { title: 'Staff Engineer', org: 'Datadog', since: '2026-08-01' },
        },
        { org: 'Datadog' },
      ),
    );
    expect(d.needsInput).toEqual(['update']);
    expect(d.body).toMatch(/Quick update since we talked in August: \[one real update\]\./);
    expect(d.body).toMatch(/Hope the new role as a staff engineer is going well\./);
    expect(d.opening).toBe('');
  });
});

describe('referral ask', () => {
  const asked = (offer: string, over: Partial<DraftContext> = {}) =>
    generateDraft(
      base({
        kind: 'referral_ask',
        facts: [fact('o', 'offer', offer)],
        chat: { completedAt: '2026-09-20T15:00:00Z' },
        targetCompany: { name: 'Stripe', roleLabel: 'Software Engineering Intern' },
        ...over,
      }),
    );
  it('cites an offer only when it was an offer to refer, and never recasts another offer as one', () => {
    for (const offer of [
      'offered to do a practice case with me before first rounds',
      'offered to share the memo template their team uses',
      'offered to tell me which desks take interns',
      'offered to introduce me to their hiring manager',
    ]) {
      const d = asked(offer);
      expect(d.body).not.toMatch(/kindly offered|practice case|memo template|desks|hiring manager/);
      expect(d.body).toMatch(/Thanks again for the conversation/);
    }
    expect(asked('offered to refer me once I have picked a team').body).toMatch(
      /you kindly offered to refer me once I'd picked a team, so I wanted to follow up/,
    );
  });
  it('drops the boilerplate: no time estimate, no "has your name on it", no form-field credential', () => {
    const d = generateDraft(
      base({
        kind: 'referral_ask',
        user: { ...base().user, credibility: 'built a reconciliation service for card transactions in Go' },
        chat: { completedAt: '2026-09-20T15:00:00Z' },
        targetCompany: { name: 'Stripe', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(d.body).not.toMatch(
      /ready to send|couple of minutes|has your name on it|Most relevant thing I've done:/,
    );
    expect(d.body).toMatch(/For context, I built a reconciliation service/);
  });
  it('asks for the posting when they asked for it', () => {
    const d = asked('offered to refer me once I have picked a team', {
      thread: { lastInboundBody: "Once you've picked a team, send me the posting and I'll put you in." },
    });
    expect(d.needsInput).toContain('posting');
    const withLink = asked('offered to refer me once I have picked a team', {
      thread: { lastInboundBody: "Once you've picked a team, send me the posting and I'll put you in." },
      targetCompany: {
        name: 'Stripe',
        roleLabel: 'Software Engineering Intern',
        link: 'https://stripe.com/jobs/1',
      },
    });
    expect(withLink.needsInput).toEqual([]);
    expect(withLink.body).toMatch(/https:\/\/stripe\.com\/jobs\/1/);
  });
  it('never invents a role the firm does not hire for', () => {
    const d = generateDraft(
      base(
        { kind: 'referral_ask', chat: { completedAt: '2026-04-23T15:00:00Z' } },
        { title: 'Engagement Manager', org: 'McKinsey & Company', isAlumni: false },
      ),
    );
    expect(d.needsInput).toEqual(['role']);
    expect(d.body).not.toMatch(/software engineering/i);
  });
  it('an application already in is not "before I submit", and a friend is not reintroduced', () => {
    const d = generateDraft(
      base(
        {
          kind: 'referral_ask',
          targetCompany: { name: 'Stripe', roleLabel: 'Software Engineering Intern', applied: true },
        },
        { relationshipType: 'friend', strength: 0.7 },
      ),
    );
    expect(d.body).not.toMatch(/before I submit|I'm a junior/);
    expect(d.body).toMatch(/I've applied for the Software Engineering Intern role at Stripe/);
  });
});

describe('outreach register', () => {
  const people: [string, string, string | undefined][] = [
    ['Managing Director', 'J.P. Morgan', 'Leveraged Finance'],
    ['Vice President', 'Morgan Stanley', 'Healthcare'],
    ['Partner', 'Jump Trading', undefined],
    ['Head of Quantitative Research', 'Hudson River Trading', undefined],
    ['General Partner', 'Founders Fund', undefined],
    ['Principal', 'Lightspeed Venture Partners', undefined],
    ['Partner', 'McKinsey & Company', 'Healthcare practice'],
    ['Co-founder and CEO', 'Pylon', undefined],
    ['Vice President of Engineering', 'Apple', undefined],
  ];
  it('never asks a senior person about their first year or a new hire, nor a non-consultant about staffing', () => {
    for (const [title, org, group] of people)
      for (const seed of SEEDS) {
        const d = generateDraft(base({ seed }, { title, org, group, isAlumni: true }));
        const text = `${d.body}\n${d.bodyShort ?? ''}`;
        expect(text, `${title} ${org}`).not.toMatch(
          /first year|first few months|new hire|how recruiting went|path to (a|an) [a-z ]+ role/,
        );
        if (!/McKinsey/.test(org)) expect(text, `${title} ${org}`).not.toMatch(/staffed|staffing|the office/);
        if (!/J\.P\.|Morgan Stanley/.test(org)) expect(text).not.toMatch(/over the others|other groups/);
      }
  });
  it('a quant partner and a venture partner are finance, not consulting', () => {
    expect(sectorOf({ title: 'Partner', org: 'Jump Trading' })).toBe('finance');
    expect(firmKindOf({ title: 'Partner', org: 'Jump Trading' }, 'finance')).toBe('trading');
    expect(firmKindOf({ title: 'General Partner', org: 'Founders Fund' }, 'finance')).toBe('vc');
    expect(sectorOf({ title: 'Head of Quantitative Research', org: 'Hudson River Trading' })).toBe('finance');
  });
  it('groups and offices take their article and noun', () => {
    const qs = (title: string, org: string, group: string, sector: 'finance' | 'consulting' | 'tech') =>
      questionsFor({ title, org, group }, sector)
        .map((x) => x.q)
        .join(' | ');
    expect(qs('Consultant', 'Bain & Company', 'Boston office', 'consulting')).toMatch(/the Boston office/);
    expect(qs('Consultant', 'Bain & Company', 'Boston office', 'consulting')).not.toMatch(/on Boston office/);
    expect(qs('Associate', 'Andreessen Horowitz', 'fintech team', 'finance')).not.toMatch(
      / fintech team over/,
    );
    expect(qs('Analyst', 'Goldman Sachs', 'TMT', 'finance')).toMatch(/how you chose TMT/);
    const alum = generateDraft(
      base({ seed: 'g' }, { title: 'Vice President', org: 'Morgan Stanley', group: 'Healthcare' }),
    );
    expect(alum.body).not.toMatch(/Morgan Stanley's Healthcare(?! group)/);
    const meta = generateDraft(
      base({ seed: 'alum-0' }, { title: 'Software Engineer', org: 'Meta', group: 'Ads Infrastructure' }),
    );
    expect(meta.body).not.toMatch(/Meta's Ads Infrastructure(?! team)/);
  });
  it('no stiff cleft frames, and at most one soft line after the ask', () => {
    for (const seed of SEEDS) {
      const d = generateDraft(base({ seed }));
      expect(d.body).not.toMatch(/What I'm trying to understand is|The thing I'd most like to ask about is/);
      const soft = [
        /work around your (calendar|schedule)/,
        /Whatever time suits you|Any time that works for you/,
        /understand if|No worries at all if|Totally understand/,
        /Thanks either way/,
      ].filter((re) => re.test(d.body)).length;
      expect(soft, d.body).toBeLessThanOrEqual(1);
    }
  });
  it('never opens with a full name, and a "Dear" letter has no contractions', () => {
    const d = generateDraft(
      base(
        {},
        {
          title: 'Managing Director',
          org: 'Evercore',
          fullName: 'Elena Rossi',
          firstName: 'Elena',
          strength: 0,
        },
      ),
    );
    expect(d.body).toMatch(/^Dear Elena,/);
    expect(d.body).not.toMatch(/Elena Rossi|\bI'm\b|\bI'd\b/);
  });
  it('someone the student already met is not introduced to cold', () => {
    const d = generateDraft(
      base({ chat: { completedAt: '2026-06-10T15:00:00Z' } }, { title: 'Consultant', org: 'Bain & Company' }),
    );
    expect(d.body).toMatch(/Thanks again for talking with me in June/);
    expect(d.body).not.toMatch(/I saw that you went from|I'm a junior/);
  });
  it("the student's line about a post is followed up on, not left hanging", () => {
    const d = generateDraft(
      base(
        { facts: [fact('c', 'connection', 'I read your post about how your team runs deal reviews')] },
        { title: 'Analyst', org: 'Goldman Sachs', isAlumni: false },
      ),
    );
    expect(d.body).toMatch(/I read your post about how your team runs deal reviews\./);
    expect(d.body).toMatch(/(more )?about how your team runs deal reviews[.?]/);
    expect(d.body.match(/how your team runs deal reviews/g)).toHaveLength(2);
  });
  it('uses what they work on and, in tech, what the student built', () => {
    const d = generateDraft(
      base({
        facts: [fact('r', 'role_detail', 'They work on the card issuing platform')],
        user: { ...base().user, credibility: 'built a campus marketplace used by 800 students' },
      }),
    );
    expect(d.body).toMatch(/I (noticed|also saw that) you work on the card issuing platform\./);
    expect(d.body).toMatch(/For context, I built a campus marketplace used by 800 students\./);
    expect(d.claims.some((c) => c.factId === 'r')).toBe(true);
    // a banker does not get the brag
    const ib = generateDraft(
      base(
        { user: { ...base().user, credibility: 'built a campus marketplace used by 800 students' } },
        { title: 'Analyst', org: 'Goldman Sachs', group: 'TMT' },
      ),
    );
    expect(ib.body).not.toMatch(/marketplace/);
  });
  it('a referral is named, nothing the referrer said is invented', () => {
    for (const seed of SEEDS) {
      const d = generateDraft(base({ seed, chat: { referrerName: 'Mei Chen' } }, { isAlumni: false }));
      expect(d.body).not.toMatch(/say hello|right person to ask|mentioned you/);
      expect(d.body).toMatch(/Mei Chen suggested I/);
    }
  });
  it('a friend is not reintroduced or apologized to', () => {
    const d = generateDraft(
      base(
        { history: { lastAt: '2026-06-05T15:00:00Z', lastInbound: true, repliedEver: true } },
        { relationshipType: 'friend', strength: 0.7 },
      ),
    );
    expect(d.body).not.toMatch(/quick reminder|sorry it took me|I'm a junior/);
    expect(d.body).toMatch(/Thanks again for your note in June\./);
  });
});

describe('LinkedIn connection notes', () => {
  it('carry a plain question with a number, vary their opening, and never use the noun-phrase frame', () => {
    const openings = new Set<string>();
    for (const seed of SEEDS)
      for (const [title, org] of [
        ['Software Engineer', 'Pylon'],
        ['Managing Director', 'J.P. Morgan'],
        ['Consultant', 'McKinsey & Company'],
      ] as const) {
        const d = generateDraft(
          base({ seed, channel: 'linkedin' }, { title, org, linkedinConnected: false }),
        );
        const n = d.bodyShort!;
        expect(n.length).toBeLessThanOrEqual(LINKEDIN_NOTE_MAX);
        expect(n).toMatch(/Would you have (15|20) minutes to talk about [^?]+\?/);
        expect(n).not.toMatch(/be possible\?|for a few questions/);
        openings.add(n.split('.')[0]!.replace(/^Hi \w+, /, ''));
      }
    expect(openings.size).toBeGreaterThan(1);
  });
});

describe('closing loops', () => {
  it('a declined or unanswered intro is not thanked for "making it happen"', () => {
    for (const outcome of ['declined', 'no_reply'] as const) {
      const d = generateDraft(
        base({ kind: 'report_back', reportBack: { targetName: 'Lucas Fischer', outcome } }),
      );
      expect(d.body).not.toMatch(/making it happen/);
    }
    const spoke = generateDraft(
      base({
        kind: 'report_back',
        reportBack: { targetName: 'Lucas Fischer', outcome: 'spoke', when: 'on Tuesday' },
      }),
    );
    expect(spoke.body).toMatch(/making it happen/);
  });
  it('a stranger is not told "well deserved", and the employer they left is named', () => {
    const d = generateDraft(
      base(
        {
          kind: 'congratulate',
          newAffiliation: {
            title: 'Managing Director',
            org: 'J.P. Morgan',
            since: '2026-09-27',
            previousOrg: 'Deloitte',
          },
        },
        { strength: 0.05, relationshipType: 'cold', isAlumni: false },
      ),
    );
    expect(d.body).not.toMatch(/well deserved/);
    expect(d.body).toMatch(/your move from Deloitte to J\.P\. Morgan as a managing director/);
  });
  it('an intro request blurb names the target once and asks about the reason given', () => {
    const d = generateDraft(
      base({
        kind: 'intro_request',
        target: {
          name: 'Lucas Fischer',
          firstName: 'Lucas',
          title: 'Engineering Manager',
          org: 'Evercore',
          why: 'their path from banking into product',
        },
      }),
    );
    expect(d.body.match(/Lucas's/g)).toHaveLength(1);
    expect(d.body).toMatch(/hear about Lucas's path from banking into product\."/);
  });
  it('thank-you turns their "our" into "your" and has no vague follow-up promise', () => {
    const d = generateDraft(
      base({
        kind: 'thank_you',
        facts: [
          fact('a', 'advice', 'the key is knowing one deal on our coverage list cold before superday'),
          fact('o', 'offer', 'offered to pass my resume to the summer analyst recruiting team'),
        ],
        chat: { completedAt: '2026-10-06T15:00:00Z' },
        promises: ['I will send my resume by Friday'],
      }),
    );
    expect(d.body).toMatch(/your coverage list/);
    expect(d.body).not.toMatch(/\bour coverage list|when the timing is right|anything I can do for you/);
    expect(theirWords('we hire in January for our desk')).toBe('you hire in January for your desk');
  });
  it('empty shells still give the student a sentence to finish, and never feed the opening dedupe', () => {
    const c = generateDraft(base({ kind: 'congratulate' }));
    expect(c.body).toMatch(/Congratulations on \[what you are congratulating Priya on/);
    expect(c.opening).toBe('');
    const i = generateDraft(base({ kind: 'intro_request' }));
    expect(i.body).toMatch(/Small ask\. I'm hoping to talk with \[/);
    expect(i.opening).toBe('');
  });
});

describe('scheduling window', () => {
  it('"next week" is answered with times next week, never tomorrow', () => {
    const nb = earliestFor('Send me a couple of times that work for you next week', NOW, 'America/New_York')!;
    expect(nb.toISOString()).toBe('2026-10-12T04:00:00.000Z');
    const ws = proposeWindows([], NOW, 'America/New_York', { notBefore: nb });
    expect(ws.length).toBe(2);
    for (const w of ws) expect(new Date(w.startIso).getTime()).toBeGreaterThanOrEqual(nb.getTime());
    expect(earliestFor('happy to chat, let me know what works', NOW, 'America/New_York')).toBeUndefined();
  });
});

describe('validator false positives', () => {
  it('a group called Leveraged Finance is not the banned word, but "leverage" still is', () => {
    const ctx = base({}, { title: 'Managing Director', org: 'J.P. Morgan', group: 'Leveraged Finance' });
    expect(issuesOf(ctx).filter((x) => x.code === 'banned_phrase')).toEqual([]);
    expect(
      issuesOf(
        ctx,
        'Hi Priya,\n\nI hope to leverage my background. Would you have 15 minutes?\n\nBest,\nAlex',
      ).some((x) => x.code === 'banned_phrase'),
    ).toBe(true);
  });
  it('a short connection note is not "too short", a recruiter question needs no call length', () => {
    const note = base({ channel: 'linkedin' }, { linkedinConnected: false });
    const d = generateDraft(note);
    expect(issuesOf(note, d.bodyShort).filter((x) => x.code === 'too_short')).toEqual([]);
    const rec = base(
      {},
      { title: 'University Recruiter', org: 'Ramp', relationshipType: 'recruiter', strength: 0 },
    );
    expect(issuesOf(rec).filter((x) => x.code === 'ask_without_number')).toEqual([]);
  });
  it('a link Orbit has on record is not an unknown URL', () => {
    const ctx = base({
      kind: 'referral_ask',
      chat: { completedAt: '2026-09-20T15:00:00Z' },
      targetCompany: {
        name: 'Stripe',
        roleLabel: 'Software Engineering Intern',
        link: 'https://stripe.com/jobs/1',
      },
    });
    expect(issuesOf(ctx).filter((x) => x.code === 'unknown_url')).toEqual([]);
  });
});
