import { describe, expect, it } from 'vitest';
import corpus from '../drafts/corpus.json';
import { shortOrg } from '../drafts/phrasing';
import { questionsFor } from '../drafts/register';
import { cycleTiming } from '../drafts/sector';
import { BANNED_PHRASES, type DraftContext, generateDraft } from '../drafts/templates';
import { inboundNeedsAnswer, subjectTopic } from '../drafts/thread';
import { validateDraft } from '../drafts/validate';
import { composeKindFor, composeKinds } from '../pipeline/transitions';
import { defaultStyleCard } from '../style/card';
import type { PersonFact } from '../types';

/**
 * Regressions for the patterns the expert panel (banker, consultant, tech referrer, career coach) found in round 2
 * of the drafts review: each test pins a root cause across kinds and sectors, never one draft.
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
    firstName: 'Rhea',
    lastName: 'Iyer',
    fullName: 'Rhea Iyer',
    title: 'Software Engineer',
    org: 'Linear',
    isAlumni: false,
    relationshipType: 'unknown',
    strength: 0.4,
    ...person,
  },
  facts: [],
  kind: 'outreach',
  channel: 'gmail',
  now: NOW,
  seed: 'p1',
  ...over,
});
const WINDOWS = [
  { startIso: '2026-10-12T14:30:00Z', endIso: '2026-10-12T15:00:00Z' },
  { startIso: '2026-10-14T20:00:00Z', endIso: '2026-10-14T20:30:00Z' },
];
const BANKER = { title: 'Vice President', org: 'Morgan Stanley', group: 'Healthcare' };
const IB_USER = (cycleLabel = 'Summer 2027 internship') => ({
  ...base().user,
  majors: ['Economics'],
  targetFunctions: ['ib'],
  cycleLabel,
});

describe('thread state', () => {
  const signoff = (body: string, daysAgo = 110) => ({
    lastInboundBody: body,
    lastInboundAt: ago(daysAgo),
    firstOutboundAt: ago(daysAgo + 40),
    lastSignal: 'reply_neutral',
    asksOfUser: [],
    proposedTimes: [],
    inThread: true,
    subject: 'Cornell CS sophomore, Postgres or Elasticsearch?',
  });
  it('a months-old sign-off is picked back up with a reason, never "Thank you for the reply" and times', () => {
    const d = generateDraft(
      base({
        kind: 'reply',
        thread: signoff('Love hearing that. Good luck with recruiting this fall.\n\nRhea'),
        chat: { meetingAt: ago(150), completedAt: ago(150), stage: 'nurturing' },
        proposedWindows: WINDOWS,
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(d.kind).toBe('nurture');
    expect(d.body).not.toMatch(/Thank you for the reply|Thanks for getting back|Would either of these work/);
    expect(d.body).toMatch(/Thanks again for talking with me in May about Postgres or Elasticsearch\./);
    expect(d.body).toMatch(/I'm planning to apply for Linear's software engineering internship this cycle\./);
    expect(d.body).toMatch(/15 minutes/);
    expect(d.needsInput).toEqual([]);
  });
  it('"Keep me posted" is answered with the update it asked for', () => {
    const d = generateDraft(
      base({
        kind: 'reply',
        thread: signoff('Keep me posted on where you end up.\n\nMateo', 75),
        chat: { meetingAt: ago(76), stage: 'nurturing' },
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern', applied: true },
      }),
    );
    expect(d.body).toMatch(/You asked me to keep you posted, so here's an update: I've applied for Linear's/);
  });
  it('a new role on record is the reason to write, and needs no made-up update', () => {
    const d = generateDraft(
      base({
        kind: 'reply',
        thread: signoff('Glad it was helpful, Alex. Good luck this cycle.\n\nElena', 240),
        chat: { meetingAt: ago(241), stage: 'nurturing' },
        newAffiliation: { title: 'Staff Engineer', org: 'Datadog', since: '2026-08-01', observed: true },
      }),
    );
    expect(d.body).toMatch(/^Hi Rhea,\n\nI saw you're now a Staff Engineer at Datadog\. Congratulations/);
    expect(d.body).toMatch(/No need to reply/);
    expect(d.needsInput).toEqual([]);
  });
  it('a bump to someone who has answered is the scheduling reply, and their proposed time is accepted', () => {
    const yes = generateDraft(
      base({
        kind: 'bump',
        proposedWindows: WINDOWS,
        thread: {
          lastInboundBody: 'Happy to chat. Send me a couple of times that work next week.',
          lastInboundAt: ago(1),
          firstOutboundAt: ago(5),
          lastSignal: 'reply_positive',
          inThread: true,
          subject: 'Cornell junior, your move from design to PM',
        },
      }),
    );
    expect(yes.kind).toBe('schedule');
    expect(yes.body).not.toMatch(/buried|lost|someone else on your team/);
    expect(yes.body).toMatch(/Would either of these work\?/);
    expect(yes.body).toMatch(/Looking forward to hearing about your move from design to PM\./);
    for (const kind of ['bump', 'schedule'] as const) {
      const d = generateDraft(
        base({
          kind,
          proposedWindows: WINDOWS,
          thread: {
            lastInboundBody: 'Would Friday at 2pm your time work for a video call?',
            lastInboundAt: ago(1),
            firstOutboundAt: ago(6),
            lastSignal: 'scheduling_proposal',
            proposedTimes: [{ startIso: '2026-10-09T18:00:00Z', raw: 'Friday at 2pm' }],
            inThread: true,
            subject: "Cornell junior, question about Notion's APM program",
          },
        }),
      );
      expect(d.kind).toBe('reply');
      expect(d.body).toMatch(/^Hi Rhea,\n\nFriday, Oct 9 at 2pm EDT works\./);
      expect(d.body).not.toMatch(/Would either of these|Monday, Oct 12/);
      expect(d.body).toMatch(/Looking forward to hearing about Notion's APM program\./);
    }
  });
  it('an out-of-office holds the bump until two business days after the return, and the bump says so', () => {
    const chat = {
      stage: 'outreach_sent' as const,
      lastOutboundAt: '2026-10-05T14:05:00Z',
      lastInboundAt: '2026-10-05T14:06:00Z',
      outOfOfficeUntil: '2026-10-12',
    };
    const w = composeKindFor(chat, NOW, { timezone: 'America/New_York' });
    expect(w).toMatchObject({ wait: { reason: 'away' } });
    expect('wait' in w && w.wait.until?.slice(0, 10)).toBe('2026-10-14');
    expect(composeKindFor(chat, new Date('2026-10-15T14:00:00Z'), { timezone: 'America/New_York' })).toEqual({
      kind: 'bump',
    });
    // and a bump two days after the first note waits for its business days
    expect(
      composeKindFor({ stage: 'outreach_sent', lastOutboundAt: ago(2) }, NOW, {
        timezone: 'America/New_York',
      }),
    ).toMatchObject({ wait: { reason: 'too_soon' } });
    const d = generateDraft(
      base({
        kind: 'bump',
        chat: { awayUntil: '2026-10-12' },
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern', applied: true },
        thread: {
          lastSignal: 'out_of_office',
          lastInboundAt: '2026-10-05T14:06:00Z',
          firstOutboundAt: '2026-10-05T14:05:00Z',
          inThread: true,
          subject: "Cornell junior, your first year on Ramp's card team",
        },
      }),
    );
    expect(d.kind).toBe('bump');
    expect(d.body).toMatch(/Welcome back/);
    expect(d.body).toMatch(/about your first year on Ramp's card team/);
    expect(d.body).toMatch(/I've since applied/);
  });
  it('a "first" message to someone already written to is the bump on that thread', () => {
    const d = generateDraft(
      base({
        kind: 'outreach',
        thread: { firstOutboundAt: ago(9), subject: 'Cornell CS junior, your retries post' },
      }),
    );
    expect(d.kind).toBe('bump');
    expect(d.needsInput).toEqual([]);
    expect(d.body).toMatch(/about your retries post/);
  });
  it('the composer offers no bump to someone who answered and no second first message', () => {
    expect(composeKinds('replied', 'schedule')).toEqual(['schedule']);
    expect(composeKinds('scheduling', 'schedule')).toEqual(['schedule']);
    expect(composeKinds('outreach_sent', 'bump')).toEqual(['bump']);
    // a reply is offered only while their message waits on an answer
    const nurturing = { stage: 'nurturing' as const, lastOutboundAt: ago(130), lastInboundAt: ago(110) };
    expect(
      composeKindFor(nurturing, NOW, {
        lastInbound: { lastInboundAt: ago(110), lastSignal: 'reply_neutral', asksOfUser: [] },
      }),
    ).toEqual({ kind: 'nurture' });
    expect(
      composeKindFor(nurturing, NOW, {
        lastInbound: { lastInboundAt: ago(1), lastSignal: 'question', asksOfUser: ['Which team?'] },
      }),
    ).toEqual({ kind: 'reply' });
    expect(inboundNeedsAnswer({ lastInboundAt: ago(100), lastSignal: 'reply_positive' }, NOW)).toBe(false);
    expect(subjectTopic('Cornell junior, quick question')).toBeUndefined();
    expect(subjectTopic('Intro: Alex <> Theo')).toBeUndefined();
    expect(subjectTopic('Re: Cornell CS sophomore, consulting before product, a question about Bain')).toBe(
      'consulting before product',
    );
  });
});

describe('honesty about state', () => {
  it('a recruiter hears the application as it stands, and one conversation as one', () => {
    const d = generateDraft(
      base(
        {
          targetCompany: { name: 'Ramp', roleLabel: 'Software Engineering Intern', applied: true },
          sameOrgContacts: ['Lena'],
        },
        { title: 'University Recruiter', org: 'Ramp', relationshipType: 'recruiter', strength: 0 },
      ),
    );
    expect(d.body).toMatch(/I have applied for the Software Engineering Intern role at Ramp\./);
    expect(d.body).not.toMatch(/planning to apply|helpful conversations|rolling basis/);
    expect(d.body).toMatch(/I have also spoken with Lena on the team\./);
    expect(d.body).toMatch(/first-round interviews/);
  });
  it('a thank-you never promises to follow up on a posting the student already applied to', () => {
    const d = generateDraft(
      base({
        kind: 'thank_you',
        chat: { meetingAt: ago(0.2) },
        facts: [fact('o', 'offer', 'offered to refer me when the posting goes up', 0)],
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern', applied: true },
      }),
    );
    expect(d.body).not.toMatch(/once it's live|as soon as it's live/);
    expect(d.body).toMatch(/I've attached my resume/);
    expect(d.needsInput).toContain('resume');
  });
  it('a referral ask never names a role that is not on record', () => {
    const d = generateDraft(
      base(
        { kind: 'referral_ask', chat: { completedAt: ago(40) } },
        { title: 'Group Product Manager', org: 'Datadog' },
      ),
    );
    expect(d.needsInput).toContain('role');
    expect(d.body).not.toMatch(/product management internship|software engineering internship/);
    const misfit = generateDraft(
      base(
        { kind: 'referral_ask', chat: { completedAt: ago(130) } },
        { title: 'Vice President, M&A', org: 'Goldman Sachs' },
      ),
    );
    expect(misfit.body).toMatch(/a check-in fits better than a referral ask/);
  });
  it('a hook from the notes is something the student saw, unless the note says they said it', () => {
    const saw = generateDraft(
      base({
        kind: 'nurture',
        chat: { meetingAt: ago(42) },
        update: 'I accepted a spring research position with my professor',
        facts: [fact('h', 'hook', 'they are hiring their first two interns in January', 4)],
      }),
    );
    expect(saw.body).toMatch(/I also saw that you're hiring your first two interns in January\./);
    expect(saw.body).not.toMatch(/you mentioned/i);
    const said = generateDraft(
      base({
        kind: 'nurture',
        chat: { meetingAt: ago(42) },
        update: 'I accepted a spring research position with my professor',
        facts: [fact('h', 'hook', 'Rhea mentioned they are hiring interns in January', 42)],
      }),
    );
    expect(said.body).toMatch(/You mentioned/);
  });
  it('congratulations are not "just saw the news" when they have talked since the move', () => {
    const d = generateDraft(
      base({
        kind: 'congratulate',
        chat: { meetingAt: ago(2) },
        newAffiliation: { title: 'Principal', org: 'Oliver Wyman', since: ago(10), previousOrg: 'Deloitte' },
      }),
    );
    expect(d.body).not.toMatch(/Just saw the news/);
    expect(d.body).toMatch(/Congratulations on your move from Deloitte to Oliver Wyman/);
  });
  it('a report-back never tells the introducer the person has not answered', () => {
    const d = generateDraft(
      base({ kind: 'report_back', reportBack: { targetName: 'Lucas Fischer', outcome: 'no_reply' } }),
    );
    expect(d.body).not.toMatch(/haven't heard|no reply|not heard/i);
    expect(d.body).toMatch(/I've followed up and will let you know how it goes\./);
  });
});

describe('investment banking timing', () => {
  it('in the fall a summer analyst cycle is late, and nothing says "before recruiting starts"', () => {
    expect(cycleTiming('bank', 'Summer 2027 internship', NOW)).toBe('late');
    expect(cycleTiming('bank', 'Summer 2027 internship', new Date('2026-03-01T00:00:00Z'))).toBe('on_time');
    expect(cycleTiming('consulting', 'Summer 2027 internship', NOW)).toBe('on_time');
    expect(cycleTiming('bank', 'Full-time 2028', NOW)).toBe('on_time');
    for (const q of questionsFor(BANKER, 'finance', { late: true }))
      expect(q.q).not.toMatch(/before recruiting starts/);
    for (const seed of ['a', 'b', 'c', 'd']) {
      const d = generateDraft(base({ seed, user: IB_USER(), chat: { referrerName: 'Mei Chen' } }, BANKER));
      expect(d.body).not.toMatch(/before recruiting starts|this cycle/);
    }
    const recruiter = generateDraft(
      base(
        { user: IB_USER() },
        { title: 'Campus Recruiter', org: 'Goldman Sachs', relationshipType: 'recruiter' },
      ),
    );
    expect(recruiter.body).toMatch(/main Summer 2027 cycle ran earlier this year/);
    expect(recruiter.body).toMatch(/off-cycle or diversity programs/);
    expect(recruiter.body).not.toMatch(/planning to apply/);
  });
});

describe('the ask', () => {
  it('no referral dressed as a process question: a stranger gets the conversation ask, a friend a direct one', () => {
    const stranger = generateDraft(
      base({
        kind: 'referral_ask',
        facts: [
          fact('c', 'connection', 'I read your post on how your team runs design reviews for new services'),
        ],
        targetCompany: {
          name: 'Google',
          roleLabel: 'Software Engineering Intern',
          applied: true,
          reqId: 'R-1',
        },
      }),
    );
    expect(stranger.kind).toBe('outreach');
    expect(stranger.body).not.toMatch(/anything that helps an application|process question|refer me/);
    expect(stranger.body).toMatch(/I've applied for Google's software engineering internship \(req R-1\)\./);
    expect(stranger.body).toMatch(/15 minutes/);
    const introduced = generateDraft(
      base({
        kind: 'referral_ask',
        chat: { referrerName: 'Mei Chen', introducedAt: ago(3) },
        targetCompany: { name: 'Pylon', roleLabel: 'Software Engineering Intern', applied: true },
      }),
    );
    expect(introduced.body).toMatch(/^Thanks for the introduction, Mei \(moving you to bcc\)\./);
    const friend = generateDraft(
      base(
        {
          kind: 'referral_ask',
          targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern', applied: true },
        },
        { relationshipType: 'friend', strength: 0.7 },
      ),
    );
    expect(friend.body).toMatch(/Would you be comfortable referring me/);
    const issues = validateDraft(friend, {
      kind: 'referral_ask',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Rhea',
      hadConversation: false,
    });
    expect(issues.map((i) => i.code)).not.toContain('referral_without_conversation');
  });
  it('the line about a post is reacted to, never read back as the ask', () => {
    for (const [title, org, text] of [
      ['Analyst', 'Goldman Sachs', 'I read your post about how your team runs deal reviews'],
      ['Engagement Manager', 'BCG', 'I read your article on how new consultants learn to structure a case'],
      ['Founding Engineer', 'Hex', 'I read your post on hiring the first ten engineers'],
      [
        'Principal',
        'Lightspeed Venture Partners',
        'I read your post about how your firm evaluates developer tools',
      ],
    ] as const) {
      const d = generateDraft(base({ facts: [fact('c', 'connection', text)] }, { title, org }));
      const topic = text.replace(/^.*?\b(?:about|on) /, '');
      expect(d.body.split(topic).length - 1).toBe(1);
      expect(d.body).toMatch(/I('ve| have) been wondering /);
      expect(d.body).not.toMatch(/tell me more about/);
    }
  });
  it('a recruiter question fits the firm: no campus event at a startup or a fund, the hiring hook when there is one', () => {
    const startup = generateDraft(
      base(
        { facts: [fact('h', 'hook', 'they are hiring their first two interns in January')] },
        { title: 'Campus Recruiter', org: 'Hex', relationshipType: 'recruiter' },
      ),
    );
    expect(startup.body).not.toMatch(/campus event|info session|rolling basis/);
    expect(startup.body).toMatch(/hiring your first two interns in January/);
    const fund = generateDraft(
      base(
        { user: IB_USER() },
        { title: 'Campus Recruiter', org: 'Sequoia Capital', relationshipType: 'recruiter' },
      ),
    );
    expect(fund.body).not.toMatch(/campus event|info session/);
    const bank = generateDraft(
      base(
        { user: IB_USER('Full-time 2028') },
        { title: 'Campus Recruiter', org: 'Evercore', relationshipType: 'recruiter' },
      ),
    );
    expect(bank.body).toMatch(/Cornell info session/);
  });
  it('an offer becomes the next step, and an offered intro is what is asked for', () => {
    const cases: [string, RegExp][] = [
      [
        'offered to do a practice case with me before first rounds',
        /Would sometime in the next few weeks work\?/,
      ],
      ['offered to introduce me to their hiring manager', /I can send a two-line blurb/],
      ['offered to share the memo template their team uses', /I'd love to see it/],
      ['offered to tell me which desks take interns', /I'd love to hear whenever you have a minute/],
      ['offered to pass my resume to the summer analyst recruiting team', /I've attached my resume/],
    ];
    for (const [offer, next] of cases) {
      for (const kind of ['thank_you', 'nurture'] as const) {
        const d = generateDraft(
          base({
            kind,
            chat: { meetingAt: kind === 'thank_you' ? ago(1) : ago(42) },
            update: 'I accepted a spring research position',
            facts: [fact('o', 'offer', offer, kind === 'thank_you' ? 1 : 42)],
          }),
        );
        expect(d.body).toMatch(next);
      }
    }
    const intro = generateDraft(
      base({
        kind: 'referral_ask',
        chat: { completedAt: ago(7) },
        facts: [fact('o', 'offer', 'offered to introduce me to their hiring manager', 7)],
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(intro.body).toMatch(/introduce me to your hiring manager\. I'd love to take you up on that/);
    expect(intro.body).not.toMatch(/refer me|Completely fine if not|If you would be comfortable/);
  });
  it('a resume asked for or promised is attached, never "I\'ll send it over today"', () => {
    const d = generateDraft(
      base({
        kind: 'reply',
        answer: 'Mostly infrastructure and backend teams, since that is what I worked on last summer',
        thread: {
          lastInboundBody: 'Could you send your resume? And which teams are you most interested in?',
          lastInboundAt: ago(1),
          asksOfUser: ['Could you send your resume?', 'Which teams are you most interested in?'],
          lastSignal: 'question',
          inThread: true,
        },
      }),
    );
    expect(d.body).not.toMatch(/over today|by Friday/);
    expect(d.body).toMatch(/attached/);
    expect(d.body).toMatch(/As for teams, mostly infrastructure and backend teams/);
    expect(d.needsInput).toEqual(['resume']);
    const issues = validateDraft(d, {
      kind: 'reply',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Rhea',
    });
    expect(issues.find((i) => i.code === 'attach_resume')?.blocking).toBe(false);
  });
});

describe('register and specificity', () => {
  it('the formal preset never overrides the relationship: a friend or a peer gets "Hi", a LinkedIn message never "Dear"', () => {
    const formal = defaultStyleCard('formal', 'Alex');
    const friend = generateDraft(
      base(
        {
          styleCard: formal,
          history: { lastAt: ago(120), lastInbound: true, repliedEver: true },
        },
        { title: 'Analyst', org: 'Goldman Sachs', relationshipType: 'friend', strength: 0.7 },
      ),
    );
    expect(friend.body).toMatch(/^Hi Rhea,/);
    expect(friend.body).toMatch(/Thanks,\nAlex$/);
    expect(friend.body).not.toMatch(/Kind regards|Best regards|Cornell '28|I noticed|note in June/);
    const li = generateDraft(
      base(
        {
          channel: 'linkedin',
          facts: [fact('c', 'connection', 'I read your post about how your firm evaluates seed deals')],
        },
        { title: 'Principal', org: 'Accel', linkedinConnected: true },
      ),
    );
    expect(li.body).toMatch(/^Hi Rhea,/);
    // a "Dear" letter signs off as one, never "Dear ... Best,"
    const dear = generateDraft(
      base({ styleCard: formal }, { title: 'Managing Director', org: 'Evercore', isAlumni: true }),
    );
    expect(dear.body).toMatch(/^Dear Rhea,[\s\S]*Best regards,\nAlex Rivera\nCornell '28$/);
  });
  it('what the student built goes only to a reader it means something to, and never after a conversation', () => {
    const user = {
      ...base().user,
      credibility: 'built a reconciliation service for card transactions in Go',
    };
    const eng = generateDraft(base({ user }, { isAlumni: true }));
    expect(eng.body).toMatch(/I built a reconciliation service/);
    expect(eng.body).not.toMatch(/For context/);
    for (const title of ['Product Designer', 'Operations Manager']) {
      const d = generateDraft(base({ user }, { title, isAlumni: true }));
      expect(d.body).not.toMatch(/reconciliation/);
    }
    const met = generateDraft(
      base({
        user,
        kind: 'referral_ask',
        chat: { completedAt: ago(30) },
        targetCompany: { name: 'Linear', roleLabel: 'Software Engineering Intern' },
      }),
    );
    expect(met.body).not.toMatch(/reconciliation|For context/);
  });
  it('alumni openers name the school once, never "went from there", never restate their title', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const d = generateDraft(
        base(
          { seed, facts: [fact('r', 'role_detail', 'leads the engineering team')] },
          { title: 'CTO', org: 'Mercury', isAlumni: true, relationshipType: 'alumni' },
        ),
      );
      expect(d.body.match(/Cornell/g)?.length).toBe(1 + (d.body.match(/Cornell '28/g)?.length ?? 0));
      expect(d.body).not.toMatch(
        /from there to|which is why I'm writing to you in particular|lead the engineering team|I noticed/,
      );
      expect(d.body).not.toMatch(/Mostly I'm curious/);
    }
  });
  it('a move between companies with the same title reads as the move, and the question has a reason', () => {
    const d = generateDraft(
      base(
        {},
        {
          title: 'Product Designer',
          org: 'Stripe',
          previousOrg: 'Notion',
          previousTitle: 'Product Designer',
        },
      ),
    );
    expect(d.body).toMatch(/moved from Notion to Stripe|went from Notion to Stripe/);
    expect(d.body).not.toMatch(/product designer at Notion to/);
    expect(d.body).toMatch(/how product design and software engineering work together/);
    expect(d.body).not.toMatch(/what you'd do differently|how that happened/);
  });
  it('a mutual tie with no name is asked for, and named when given', () => {
    const line = 'You spoke with my roommate at a recruiting dinner last spring';
    const d = generateDraft(base({ facts: [fact('c', 'connection', line)] }));
    expect(d.needsInput).toContain('mutual');
    expect(d.body).toMatch(/my roommate, \[your roommate's name\], at a recruiting dinner/);
    const named = generateDraft(base({ facts: [fact('c', 'connection', line)], mutualName: 'Jordan Lee' }));
    expect(named.needsInput).not.toContain('mutual');
    expect(named.body).toMatch(/my roommate, Jordan Lee, at a recruiting dinner/);
  });
  it('a bump restates the ask, names the referrer, and offers a pointer only to someone senior', () => {
    const thread = {
      firstOutboundAt: ago(6),
      inThread: true,
      subject: 'Cornell junior, your bill matching post',
    };
    for (const seed of ['a', 'b', 'c']) {
      const peer = generateDraft(base({ kind: 'bump', seed, thread }, { title: 'Associate' }));
      expect(peer.body).toMatch(/your bill matching post/);
      expect(peer.body).not.toMatch(/someone else on your team/);
    }
    const ref = generateDraft(base({ kind: 'bump', chat: { referrerName: 'Mei Chen' }, thread }));
    expect(ref.body).toMatch(/Mei suggested I write to you/);
    const senior = generateDraft(
      base({ kind: 'bump', seed: 'a', thread }, { title: 'Director of Engineering' }),
    );
    expect(senior.body).toMatch(/someone else on your team/);
    for (const seed of ['a', 'b', 'c', 'd'])
      expect(
        generateDraft(base({ kind: 'bump', bumpNumber: 2, seed, thread }, { title: 'Partner' })).body,
      ).not.toMatch(/hard feelings/);
  });
  it('firms are written the way their people write them, and the cycle label is never pasted in', () => {
    expect(shortOrg('McKinsey & Company')).toBe('McKinsey');
    expect(shortOrg('Boston Consulting Group')).toBe('BCG');
    expect(shortOrg('Lightspeed Venture Partners')).toBe('Lightspeed');
    expect(shortOrg('Bain Capital')).toBe('Bain Capital');
    expect(shortOrg('Citadel Securities')).toBe('Citadel Securities');
    const d = generateDraft(
      base(
        { user: { ...base().user, targetFunctions: ['consulting'] } },
        { title: 'Business Analyst', org: 'McKinsey & Company', isAlumni: true },
      ),
    );
    expect(d.body).not.toMatch(/& Company/);
    const ty = generateDraft(
      base({
        kind: 'thank_you',
        chat: { meetingAt: ago(1) },
        facts: [
          fact('a', 'advice', 'the key is knowing one deal on our coverage list cold before superday', 1),
        ],
      }),
    );
    expect(ty.body).not.toMatch(/summer 2027 internship recruiting|the key is/);
    expect(ty.body).toMatch(/your point about knowing one deal on your coverage list cold/);
    const link = generateDraft(
      base({
        kind: 'referral_ask',
        chat: { completedAt: ago(7) },
        targetCompany: {
          name: 'Linear',
          roleLabel: 'Software Engineering Intern',
          reqId: 'R-1',
          link: 'https://linear.app/careers/R-1',
        },
      }),
    );
    expect(link.body.match(/below/g)).toHaveLength(1);
  });
  it('an intro request asks once and lets the blurb carry the topic with the name', () => {
    const d = generateDraft(
      base({
        kind: 'intro_request',
        target: {
          name: 'Lucas Fischer',
          firstName: 'Lucas',
          title: 'Vice President',
          org: 'Evercore',
          why: 'their move from coverage into the sponsors group',
        },
      }),
    );
    expect(d.body).not.toMatch(/\btheir\b/);
    expect(d.body.match(/move from coverage into the sponsors group/g)).toHaveLength(1);
    expect(d.body).toMatch(/Lucas's move from coverage into the sponsors group/);
  });
  it('the exemplars added from the panel rewrites hold no banned phrase or dash', () => {
    const added = (corpus as { body: string; subject?: string | null; source: string }[]).filter((e) =>
      /drafts panel, round 2/.test(e.source),
    );
    expect(added.length).toBeGreaterThanOrEqual(12);
    for (const e of added) {
      const text = `${e.subject ?? ''}\n${e.body}`.toLowerCase();
      for (const p of BANNED_PHRASES.filter((x) => !['reach out', 'reaching out'].includes(x)))
        expect(text).not.toContain(p);
      expect(e.body).not.toMatch(/[—–]/);
    }
  });
});
