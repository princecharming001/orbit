import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';
import { type DraftContext, generateDraft } from '../drafts/templates';
import { validateDraft } from '../drafts/validate';
import { parseConnectionsCsv } from '../linkedin/csv';
import { recommendPeople } from '../recommend/score';
import { heuristicResumeParse } from '../resume/parse';
import { buildStyleCard, defaultStyleCard } from '../style/card';
import { generateCandidates, selectForBrief } from '../suggestions/rules';
import type { PersonFact } from '../types';

const facts: PersonFact[] = [
  {
    id: 'f1',
    userId: 'u',
    personId: 'p',
    type: 'advice',
    text: 'the key is showing how you handled ambiguity',
    sourceTable: 'notes',
    sourceId: 'n',
    confidence: 0.8,
    createdAt: '',
  },
  {
    id: 'f2',
    userId: 'u',
    personId: 'p',
    type: 'offer',
    text: 'offered to refer me when the posting goes up',
    sourceTable: 'notes',
    sourceId: 'n',
    confidence: 0.8,
    createdAt: '',
  },
  {
    id: 'f3',
    userId: 'u',
    personId: 'p',
    type: 'hook',
    text: 'they are hiring interns in January',
    sourceTable: 'notes',
    sourceId: 'n',
    confidence: 0.7,
    createdAt: '',
  },
];
const ctx = (kind: DraftContext['kind'], extra: Partial<DraftContext> = {}): DraftContext => ({
  user: {
    firstName: 'Alex',
    fullName: 'Alex Rivera',
    school: 'Cornell University',
    gradYear: 2027,
    majors: ['Computer Science'],
    cycleLabel: 'Summer 2027 internship',
    targetFunctions: ['swe'],
    timezone: 'America/New_York',
    schedulingLink: 'https://cal.com/alex',
  },
  styleCard: defaultStyleCard('warm', 'Alex'),
  person: {
    firstName: 'Priya',
    fullName: 'Priya Patel',
    title: 'Product Manager',
    org: 'Figma',
    isAlumni: true,
    relationshipType: 'alumni',
    strength: 0.5,
  },
  facts,
  kind,
  channel: 'gmail',
  now: new Date('2026-10-05T12:00:00Z'),
  ...extra,
});

describe('drafts', () => {
  it('generates every kind within limits and passes validation', () => {
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
    ];
    for (const k of kinds) {
      const d = generateDraft(
        ctx(k, {
          proposedWindows: [{ startIso: '2026-10-08T18:00:00Z' }],
          thread: {
            firstOutboundAt: '2026-09-25T12:00:00Z',
            proposedTimes: [{ startIso: '2026-10-08T18:00:00Z', raw: 'Thursday 2pm' }],
            asksOfUser: ['Could you send your resume?'],
          },
          target: { name: 'Daniel Kim', title: 'EM', org: 'Stripe' },
          newAffiliation: { title: 'Senior PM', org: 'Figma' },
          targetCompany: { name: 'Figma', roleLabel: 'PM intern' },
        }),
      );
      const issues = validateDraft(d, {
        kind: k,
        facts,
        allowedUrls: ['https://cal.com/alex'],
        recipientFirstName: 'Priya',
      });
      expect(issues, `${k}: ${JSON.stringify(issues)}`).toEqual([]);
      expect(d.body).toContain('Priya');
      expect(d.body).toContain('Alex');
    }
  });
  it('flags banned phrases and unknown urls', () => {
    const d = { body: 'Hi Priya, I hope this email finds you well. See https://evil.example', claims: [] };
    const issues = validateDraft(d, {
      kind: 'outreach',
      facts,
      allowedUrls: [],
      recipientFirstName: 'Priya',
    });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['banned_phrase', 'unknown_url']));
  });
});

describe('style card', () => {
  it('learns greeting and signoff', () => {
    const bodies = Array.from(
      { length: 8 },
      (_, i) =>
        `Hey Sam,\n\nThanks for the note, I'll send the doc over by Friday and we can take it from there. Let me know if anything else comes up!\n\nBest,\nAlex ${i}`,
    );
    const card = buildStyleCard(bodies, 'Alex');
    expect(card.greetingPatterns[0]).toBe('Hey {first},');
    expect(card.signoffs[0]).toContain('Best');
    expect(card.contractions).toBe(true);
    expect(card.builtFromCount).toBe(8);
  });
});

describe('suggestions over the demo dataset', () => {
  const now = new Date('2026-10-06T13:00:00Z');
  const ds = buildDemoDataset({ now });
  const people = new Map(ds.people.map((p) => [p.id, p]));
  const lastInbound = new Map<string, (typeof ds.messages)[number]>();
  for (const m of ds.messages) {
    if (m.direction !== 'inbound') continue;
    const chat = ds.chats.find((c) => c.threadId === m.threadId);
    if (!chat) continue;
    const prev = lastInbound.get(chat.id);
    if (!prev || prev.sentAt < m.sentAt) lastInbound.set(chat.id, m);
  }
  const factsByPerson = new Map<string, PersonFact[]>([
    [
      ds.chats.find((c) => c.stage === 'nurturing')!.personId,
      [
        {
          id: 'fx',
          userId: 'u',
          personId: 'x',
          type: 'hook',
          text: 'launching a new product in November',
          sourceTable: 'notes',
          sourceId: 'note2',
          occurredAt: '2026-08-16T00:00:00Z',
          confidence: 0.7,
          createdAt: '',
        },
      ],
    ],
  ]);
  for (const p of ds.people) {
    p.strength = 0.4;
    p.lastInteractionAt = '2026-08-17T00:00:00Z';
  }
  const cands = generateCandidates({
    userId: ds.user.id,
    now,
    settings: ds.settings,
    people,
    chats: ds.chats,
    lastInboundByChat: lastInbound,
    events: ds.events,
    actionItems: [
      {
        id: 'ai1',
        userId: 'u',
        personId: 'p5',
        text: 'Send resume',
        dueAt: '2026-10-06T00:00:00Z',
        status: 'open',
        createdAt: '',
      },
    ],
    factsByPerson,
    targetCompanies: ds.targetCompanies,
    recommendations: [],
    dismissCounts: new Map(),
    outreachSentThisWeek: 0,
    freeSlotsIso: ['2026-10-08T14:00:00Z'],
    recentlyContacted: new Set(),
  });
  it('produces the expected kinds', () => {
    const kinds = new Set(cands.map((c) => c.kind));
    expect(kinds).toContain('follow_up_bump');
    expect(kinds).toContain('schedule_propose');
    expect(kinds).toContain('schedule_confirm');
    expect(kinds).toContain('prep_brief');
    expect(kinds).toContain('thank_you');
    expect(kinds).toContain('action_item_reminder');
    expect(kinds).toContain('warm_up_engage');
    expect(kinds).toContain('nurture_checkin');
  });
  it('selects at most 7 with hard-urgent first and one per person', () => {
    const sel = selectForBrief(cands, new Map());
    expect(sel.length).toBeLessThanOrEqual(7);
    expect(
      sel
        .slice(0, 3)
        .every((s) => ['schedule_confirm', 'thank_you', 'prep_brief', 'confirm_stage'].includes(s.kind)),
    ).toBe(true);
    const ids = sel.filter((s) => s.personId).map((s) => s.personId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('recommendations', () => {
  it('ranks target-company alumni first with diversity', () => {
    const ds = buildDemoDataset({ now: new Date('2026-10-06T13:00:00Z') });
    const recs = recommendPeople({
      userId: 'u',
      user: { school: ds.user.school, majors: ds.user.majors, gradYear: 2027 },
      goals: ds.goals,
      targetCompanies: ds.targetCompanies,
      resumeFacets: ds.resumeFacets,
      people: ds.people,
      chats: ds.chats,
      pathStrength: () => 0.2,
      recentlyRecommended: new Set(),
      now: new Date('2026-10-06T13:00:00Z'),
    });
    expect(recs.length).toBe(10);
    const byOrg = new Map<string, number>();
    for (const r of recs) {
      const o = ds.people.find((p) => p.id === r.personId)!.currentOrganizationRaw!;
      byOrg.set(o, (byOrg.get(o) ?? 0) + 1);
    }
    expect(Math.max(...byOrg.values())).toBeLessThanOrEqual(3);
    expect(
      recs.every((r) => !ds.chats.some((c) => c.personId === r.personId && c.stage !== 'archived')),
    ).toBe(true);
  });
});

describe('linkedin csv', () => {
  it('parses with preamble notes and quoted commas', () => {
    const csv =
      'Notes:\n"When exporting your connection data, you may notice..."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nPriya,Patel,https://www.linkedin.com/in/priya-patel,priya@figma.com,"Figma, Inc.",Product Manager,12 Mar 2025\nDaniel,Kim,https://www.linkedin.com/in/daniel-kim,,Stripe,Software Engineer,03 Jan 2024\n';
    const r = parseConnectionsCsv(csv);
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]!.company).toBe('Figma, Inc.');
    expect(r.rows[0]!.connectedOn).toBe('2025-03-12');
    expect(r.rows[1]!.email).toBeUndefined();
  });
});

describe('resume parse', () => {
  it('extracts experience and skills', () => {
    const text =
      'Alex Rivera\nalex@cornell.edu\n\nEducation\nCornell University — BS Computer Science, Aug 2023 - May 2027\nGPA 3.8\n\nExperience\nSoftware Engineering Intern, Brex, Jun 2025 - Aug 2025\n- Built a reconciliation service in Go\n- Reduced settlement mismatches by 30%\n\nSkills\nTypeScript, Go, Python, SQL';
    const facets = heuristicResumeParse(text, 'r1');
    expect(facets.some((f) => f.kind === 'education')).toBe(true);
    const exp = facets.find((f) => f.kind === 'experience');
    expect(exp?.startDate).toBe('2025-06-01');
    expect(exp?.keywords).toContain('reconciliation');
    expect(facets.find((f) => f.kind === 'skill_group')?.keywords).toContain('typescript');
  });
});
