import { describe, expect, it } from 'vitest';
import type { MatchablePerson } from '../agent/people-match';
import { type RouterContext, routeUtterance } from '../agent/router';
import { dateFrom, kindFrom } from '../agent/routerNetwork';
import { registry } from '../registry';

const person = (id: string, first: string, last: string, org: string): MatchablePerson => ({
  id,
  displayName: `${first} ${last}`,
  firstName: first,
  lastName: last,
  currentOrganizationRaw: org,
  currentTitle: 'PM',
  strength: 0.5,
  isHuman: true,
});

const PEOPLE = [
  person('p1', 'Priya', 'Patel', 'Stripe'),
  person('p2', 'Daniel', 'Kim', 'Ramp'),
  person('p3', 'Maya', 'Chen', 'Figma'),
  person('p4', 'Sam', 'Lee', 'Figma'),
];

function ctx(over: Partial<RouterContext> = {}): RouterContext {
  return {
    registry,
    people: PEOPLE,
    companies: ['Stripe', 'Ramp', 'Figma'],
    goals: [
      { id: 'goal_sales', kind: 'sales', title: 'Find dental clinics' },
      { id: 'goal_hiring', kind: 'hiring', title: 'Hire a backend engineer' },
    ],
    paths: [{ id: 'path_9', firstHopName: 'Sam Lee', targetId: 'p1' }],
    account: true,
    modeNote: 'Add your own key in Settings to chat freely.',
    settingsHref: '/settings/integrations',
    ...over,
  };
}

/** utterance, tool, input */
const HANDLED: [string, string, Record<string, unknown>][] = [
  // goals
  ['what are my goals', 'list_goals', {}],
  ['my goals', 'list_goals', {}],
  ['what am I working toward?', 'list_goals', {}],
  [
    'track a goal of raising a pre-seed for my climate startup',
    'set_goal',
    { kind: 'fundraising', title: 'raising a pre-seed for my climate startup' },
  ],
  [
    'add a goal: find customers for my dental app',
    'set_goal',
    { kind: 'sales', title: 'find customers for my dental app' },
  ],
  ['archive my sales goal', 'archive_goal', { goalId: 'goal_sales' }],
  ['pause my hiring goal', 'update_goal', { goalId: 'goal_hiring', status: 'paused' }],
  // the tie score
  ['how close am I to Maya?', 'explain_score', { personId: 'p3' }],
  ["explain Priya's score", 'explain_score', { personId: 'p1' }],
  ['I barely know Daniel', 'rate_closeness', { personId: 'p2', closeness: 1 }],
  ['Maya is a close friend', 'rate_closeness', { personId: 'p3', closeness: 5 }],
  ['rate Priya 4', 'rate_closeness', { personId: 'p1', closeness: 4 }],
  // research
  ['research Priya', 'research_person', { personId: 'p1' }],
  ['do some research on Daniel Kim before I email him', 'research_person', { personId: 'p2' }],
  ['what did you find on Maya', 'get_dossier', { personId: 'p3' }],
  ["show me Priya's research", 'get_dossier', { personId: 'p1' }],
  // finding people
  [
    'find me seed investors in climate software',
    'find_people',
    { purpose: 'fundraising', query: 'seed investors in climate software' },
  ],
  [
    'find customers at dental clinics in Ohio',
    'find_people',
    { purpose: 'sales', query: 'customers at dental clinics in Ohio' },
  ],
  [
    'find researchers working on graph learning',
    'find_people',
    { purpose: 'collaboration', query: 'researchers working on graph learning' },
  ],
  // introductions
  ['ask Sam to introduce me to Priya', 'ask_for_intro', { pathId: 'path_9', targetPersonId: 'p1' }],
  ['ask Daniel for an intro to Maya', 'find_routes', { personId: 'p3' }],
  // replies
  ['who replied?', 'list_replies', {}],
  ['any new replies', 'list_replies', {}],
  ['who wants to meet', 'list_replies', { replyClass: 'scheduling' }],
  ["answer Maya's question", 'list_replies', {}],
  ['book the call', 'list_replies', { replyClass: 'scheduling' }],
  // autonomy
  ['draft only', 'set_autonomy', { level: 0 }],
  ['send after I approve', 'set_autonomy', { level: 1 }],
  ['set autonomy to 2', 'set_autonomy', { level: 2 }],
  // pause and due
  ['pause outreach until 2026-12-20', 'pause_outreach', { until: '2026-12-20' }],
  ['resume my outreach', 'pause_outreach', {}],
  ["what's due", 'list_due', {}],
  ['what follow-ups are due?', 'list_due', {}],
  // memory
  [
    'remember that I prefer morning calls',
    'remember',
    { text: 'I prefer morning calls', kind: 'preference' },
  ],
  ["remember I can't do Fridays", 'remember', { text: "I can't do Fridays", kind: 'constraint' }],
  ['what do you remember', 'recall', { query: 'preferences and goals' }],
  ['what do you remember about Priya', 'recall', { query: 'Priya Patel', personId: 'p1' }],
  ['forget everything about Daniel', 'forget', { personId: 'p2' }],
];

describe('router: the networking agent', () => {
  it.each(HANDLED)('%s -> %s %j', (utterance, tool, input) => {
    const r = routeUtterance(utterance, ctx());
    expect(r.kind, JSON.stringify(r)).toBe('tool');
    if (r.kind !== 'tool') return;
    expect(r.tool).toBe(tool);
    expect(r.input).toEqual(input);
  });

  it('has a phrase for each of the 20 new tools, or the list that leads to it', () => {
    const tools = new Set(HANDLED.map(([, t]) => t));
    for (const t of [
      'set_goal',
      'list_goals',
      'update_goal',
      'archive_goal',
      'explain_score',
      'rate_closeness',
      'research_person',
      'get_dossier',
      'find_people',
      'ask_for_intro',
      'list_replies',
      'set_autonomy',
      'remember',
      'recall',
      'forget',
      'pause_outreach',
      'list_due',
    ])
      expect(tools.has(t), t).toBe(true);
    // add_sourced, draft_reply and book_call need an id from a list: they point to it
    expect(routeUtterance('add them all', ctx())).toMatchObject({ kind: 'text', href: '/discover?tab=find' });
  });

  it('asks instead of guessing: an unknown goal kind, a pause without a date, a forget without a name', () => {
    expect(routeUtterance('track a goal of getting better', ctx())).toMatchObject({ kind: 'text' });
    expect((routeUtterance('pause outreach', ctx()) as { text: string }).text).toMatch(/Until when/);
    expect(routeUtterance('forget that', ctx())).toMatchObject({ kind: 'text', href: '/settings/memory' });
    expect(routeUtterance('archive my fundraising goal', ctx())).toMatchObject({ tool: 'list_goals' });
  });

  it('keeps the older phrases: a plain find, stage words and a generic score question still go where they did', () => {
    expect(routeUtterance('find Priya', ctx())).toMatchObject({ kind: 'tool', tool: 'get_person' });
    expect(routeUtterance('show replied', ctx())).toMatchObject({ kind: 'tool', tool: 'list_pipeline' });
    expect(routeUtterance('explain my strength score', ctx()).kind).toBe('refuse');
    expect(routeUtterance("why hasn't Priya replied?", ctx()).kind).toBe('refuse');
  });

  it('without an Orbit account, "who replied" and "what\'s due" keep their older meaning', () => {
    for (const u of ['who replied', 'any new replies', "what's due", 'who wants to meet'])
      expect(routeUtterance(u, ctx({ account: false })), u).not.toMatchObject({
        tool: expect.stringMatching(/^list_(replies|due)$/),
      });
  });

  it('reads goal kinds and dates', () => {
    expect(kindFrom('raising a pre-seed')).toBe('fundraising');
    expect(kindFrom('PM internship at fintech')).toBe('recruiting');
    expect(kindFrom('a co-founder for my startup')).toBe('cofounder');
    expect(dateFrom('Dec 20', new Date('2026-10-06T12:00:00Z'))).toBe('2026-12-20');
    expect(dateFrom('january 5th', new Date('2026-10-06T12:00:00Z'))).toBe('2027-01-05');
    expect(dateFrom('2026-11-02')).toBe('2026-11-02');
    expect(dateFrom('soon')).toBeUndefined();
  });
});
