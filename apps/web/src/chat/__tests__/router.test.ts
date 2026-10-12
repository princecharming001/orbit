import { describe, expect, it } from 'vitest';
import type { MatchablePerson } from '../agent/people-match';
import { matchPeople, rankPerson, resolvePerson } from '../agent/people-match';
import { type RouterContext, routeUtterance } from '../agent/router';
import { makeStubRegistry } from '../test/stubRegistry';

const person = (
  id: string,
  first: string,
  last: string,
  org: string,
  title: string,
  strength: number,
): MatchablePerson => ({
  id,
  displayName: `${first} ${last}`,
  firstName: first,
  lastName: last,
  currentOrganizationRaw: org,
  currentTitle: title,
  strength,
  isHuman: true,
});

const PEOPLE: MatchablePerson[] = [
  person('p1', 'Priya', 'Patel', 'Stripe', 'Product Manager', 0.8),
  person('p2', 'Daniel', 'Kim', 'Ramp', 'Engineering Manager', 0.6),
  person('p3', 'Dan', 'Ortiz', 'Notion', 'Recruiter', 0.5),
  person('p4', 'Mei', 'Chen', 'Stripe', 'Software Engineer', 0.7),
  person('p5', 'Sofia', 'Rossi', 'Goldman Sachs', 'Analyst', 0.4),
  person('p6', 'Lena', 'Novak', 'Figma', 'Designer', 0.3),
  person('p7', 'Elena', 'Cohen', 'Figma', 'PM', 0.9),
  person('p8', 'Sam', 'Lee', 'Figma', 'Engineer', 0.5),
  person('p9', 'Sam', 'Park', 'Datadog', 'Engineer', 0.5),
  { ...person('p10', 'Hidden', 'Person', 'Nowhere', 'Ghost', 1), hiddenAt: '2026-01-01' },
];

const MODE_NOTE = 'Add your own key in Settings, Integrations to chat freely.';

function ctx(overrides: Partial<RouterContext> = {}): RouterContext {
  return {
    registry: makeStubRegistry().registry,
    people: PEOPLE,
    companies: ['Stripe', 'Ramp', 'Notion', 'Goldman Sachs', 'Figma', 'Datadog'],
    modeNote: MODE_NOTE,
    settingsHref: '/settings/integrations',
    ...overrides,
  };
}

/** utterance, tool, input */
const HANDLED: [string, string, Record<string, unknown>][] = [
  // the brief
  ["what's on today", 'get_today_brief', {}],
  ['today', 'get_today_brief', {}],
  ['brief', 'get_today_brief', {}],
  ['What should I do today?', 'get_today_brief', {}],
  ['good morning', 'get_today_brief', {}],
  ['my day', 'get_today_brief', {}],
  // who went quiet
  ['who went quiet', 'list_pipeline', { stage: 'no_response' }],
  ["who hasn't replied", 'list_pipeline', { stage: 'no_response' }],
  ['anyone ghosted me?', 'list_pipeline', { stage: 'no_response' }],
  ['Who went quiet?', 'list_pipeline', { stage: 'no_response' }],
  ['waiting on a reply', 'list_pipeline', { stage: 'no_response' }],
  // the pipeline, by stage
  ['show my pipeline', 'list_pipeline', {}],
  ['pipeline', 'list_pipeline', {}],
  ['Hey Orbit, can you show my pipeline please?', 'list_pipeline', {}],
  ['my chats', 'list_pipeline', {}],
  ['who is scheduled', 'list_pipeline', { stage: 'scheduled' }],
  ['show replied', 'list_pipeline', { stage: 'replied' }],
  ['chats in scheduling', 'list_pipeline', { stage: 'scheduling' }],
  ["who's in warming up", 'list_pipeline', { stage: 'warming' }],
  ['list declined', 'list_pipeline', { stage: 'declined' }],
  ['show the staying in touch stage', 'list_pipeline', { stage: 'nurturing' }],
  // drafts
  ['drafts', 'list_drafts', { status: 'draft' }],
  ['unsent drafts', 'list_drafts', { status: 'draft' }],
  ['show my drafts', 'list_drafts', { status: 'draft' }],
  ["what's ready to send", 'list_drafts', { status: 'draft' }],
  // a person by name
  ['who is Priya', 'get_person', { personId: 'p1' }],
  ['who is priya patel', 'get_person', { personId: 'p1' }],
  ['open Daniel Kim', 'get_person', { personId: 'p2' }],
  ['tell me about Mei', 'get_person', { personId: 'p4' }],
  ['show Lena', 'get_person', { personId: 'p6' }],
  ['Priya Patel', 'get_person', { personId: 'p1' }],
  ['find Sofia', 'get_person', { personId: 'p5' }],
  ['look up Dan', 'get_person', { personId: 'p3' }],
  ['who is Sam', 'search_people', { query: 'Sam' }],
  ['find Jordan', 'search_people', { query: 'Jordan' }],
  // drafts of a kind to a person
  ['draft a thank you to Priya', 'create_draft', { kind: 'thank_you', personId: 'p1' }],
  ['write a follow up to Daniel', 'create_draft', { kind: 'bump', personId: 'p2' }],
  ['draft an intro request to Mei', 'create_draft', { kind: 'intro_request', personId: 'p4' }],
  ['write a referral ask for Sofia', 'create_draft', { kind: 'referral_ask', personId: 'p5' }],
  ['draft a message to Lena', 'create_draft', { kind: 'outreach', personId: 'p6' }],
  ['thank Priya', 'create_draft', { kind: 'thank_you', personId: 'p1' }],
  ['congratulate Daniel', 'create_draft', { kind: 'congratulate', personId: 'p2' }],
  ['draft a check in to Mei', 'create_draft', { kind: 'nurture', personId: 'p4' }],
  ['start a cold email to Sofia', 'create_draft', { kind: 'outreach', personId: 'p5' }],
  ['draft a reply to Dan', 'create_draft', { kind: 'reply', personId: 'p3' }],
  // follow up
  ['follow up with Daniel', 'create_draft', { kind: 'bump', personId: 'p2' }],
  ['bump Priya', 'create_draft', { kind: 'bump', personId: 'p1' }],
  ['nudge Mei', 'create_draft', { kind: 'bump', personId: 'p4' }],
  ['ping Sofia', 'create_draft', { kind: 'bump', personId: 'p5' }],
  // notes
  [
    'note about Priya: she suggested the platform team',
    'add_note',
    { text: 'she suggested the platform team', personId: 'p1', source: 'manual' },
  ],
  [
    'add a note for Daniel: met at the career fair',
    'add_note',
    { text: 'met at the career fair', personId: 'p2', source: 'manual' },
  ],
  [
    'note: call the Ramp recruiter tomorrow',
    'add_note',
    { text: 'call the Ramp recruiter tomorrow', source: 'manual' },
  ],
  [
    'take a note on Mei - she loves climbing',
    'add_note',
    { text: 'she loves climbing', personId: 'p4', source: 'manual' },
  ],
  [
    'save note about Sofia: wants my resume',
    'add_note',
    { text: 'wants my resume', personId: 'p5', source: 'manual' },
  ],
  // moves
  ['move Priya to scheduling', 'move_pipeline_stage', { personId: 'p1', stage: 'scheduling' }],
  ['move Daniel to scheduled', 'move_pipeline_stage', { personId: 'p2', stage: 'scheduled' }],
  ['mark Mei as replied', 'move_pipeline_stage', { personId: 'p4', stage: 'replied' }],
  ['move Sofia to staying in touch', 'move_pipeline_stage', { personId: 'p5', stage: 'nurturing' }],
  ['put Lena in declined', 'move_pipeline_stage', { personId: 'p6', stage: 'declined' }],
  ['Dan replied', 'move_pipeline_stage', { personId: 'p3', stage: 'replied' }],
  // routes
  ['who can introduce me to Stripe', 'find_routes_to_company', { company: 'Stripe' }],
  ['routes to Priya', 'find_routes_to_person', { personId: 'p1' }],
  ['how do I reach Ramp', 'find_routes_to_company', { company: 'Ramp' }],
  ['who do I know at Goldman Sachs', 'find_routes_to_company', { company: 'Goldman Sachs' }],
  ['anyone at Airbnb', 'find_routes_to_company', { company: 'Airbnb' }],
  ['warm intro to Mei', 'find_routes_to_person', { personId: 'p4' }],
];

/** utterance, expected href */
const POINTERS: [string, string][] = [
  ['import my linkedin connections', '/settings/integrations'],
  ['upload linkedin export', '/settings/integrations'],
  ['where do I change my tone', '/settings/style'],
  ['how do I connect google', '/settings/integrations'],
  ['settings', '/settings'],
  ["what's my daily limit", '/settings/limits'],
  ['add a note', '/notes/new'],
];

const REFUSED: string[] = [
  "why hasn't Priya replied?",
  'should I email Daniel again?',
  'rewrite my draft to Priya to be shorter',
  'what do you think of my pipeline?',
  'summarize my conversation with Mei',
  'which company should I focus on?',
  'help me decide between Stripe and Ramp',
  'give me tips for a coffee chat',
  "what's the best way to ask for a referral",
  'explain my strength score',
  'make it more formal',
  'translate my note to Spanish',
  'is it rude to bump twice?',
  'how should I prepare for my chat with Sofia?',
  'recommend who to talk to next',
  'compare Priya and Daniel',
  'asdfgh qwerty',
  'what is the capital of France',
  'tell me a joke',
  'plan for this week',
];

describe('people matching (lifted from the command palette)', () => {
  it('ranks exact names, then prefixes, then word prefixes, then contains, closer people first', () => {
    const c = ctx();
    expect(matchPeople(c.people, 'lena').map((p) => p.id)).toEqual(['p6', 'p7']);
    expect(rankPerson(PEOPLE[5]!, 'lena')).toBe(0);
    expect(rankPerson(PEOPLE[6]!, 'lena')).toBe(3);
    expect(matchPeople(c.people, 'figma').map((p) => p.id)).toEqual(['p7', 'p8', 'p6']);
    expect(matchPeople(c.people, 'p patel').map((p) => p.id)).toEqual(['p1']);
    expect(matchPeople(c.people, 'ghost')).toEqual([]);
  });

  it('resolves a unique person, prefers an exact first name, and reports ambiguity', () => {
    const c = ctx();
    expect(resolvePerson(c.people, 'Dan').person?.id).toBe('p3');
    expect(resolvePerson(c.people, 'Daniel').person?.id).toBe('p2');
    expect(resolvePerson(c.people, 'Sam').person).toBeUndefined();
    expect(resolvePerson(c.people, 'Sam').candidates.map((p) => p.id)).toEqual(['p8', 'p9']);
    expect(resolvePerson(c.people, 'Nobody').candidates).toEqual([]);
    expect(resolvePerson(c.people, 'stripe').person).toBeUndefined();
  });
});

describe('router: handled utterances', () => {
  it.each(HANDLED)('%s -> %s %j', (utterance, tool, input) => {
    const r = routeUtterance(utterance, ctx());
    expect(r.kind).toBe('tool');
    if (r.kind !== 'tool') return;
    expect(r.tool).toBe(tool);
    expect(r.input).toEqual(input);
  });

  it('covers at least sixty utterances', () => {
    expect(HANDLED.length).toBeGreaterThanOrEqual(60);
  });

  it.each(POINTERS)('%s -> a plain reply pointing at %s', (utterance, href) => {
    const r = routeUtterance(utterance, ctx());
    expect(r.kind).toBe('text');
    if (r.kind !== 'text') return;
    expect(r.href).toBe(href);
    expect(r.text).not.toMatch(/[—–!]/);
  });

  it('says so when nobody matches a name, instead of guessing', () => {
    const r = routeUtterance('draft a thank you to Zed', ctx());
    expect(r.kind).toBe('text');
    expect((r as { text: string }).text).toMatch(/could not find anyone called "Zed"/);
    const m = routeUtterance('move Zed to scheduling', ctx());
    expect(m.kind).toBe('text');
  });

  it('asks which person when a name is ambiguous', () => {
    const r = routeUtterance('draft a thank you to Sam', ctx());
    expect(r).toMatchObject({ kind: 'tool', tool: 'search_people', input: { query: 'Sam' } });
    expect((r as { lead?: string }).lead).toMatch(/More than one person/);
  });

  it('never routes to a tool the registry does not have', () => {
    const registry = new Map(makeStubRegistry().registry);
    registry.delete('move_pipeline_stage');
    const r = routeUtterance('move Priya to scheduling', ctx({ registry }));
    expect(r.kind).toBe('refuse');
    expect((r as { text: string }).text).toMatch(/cannot move a chat/);
  });

  it('never hands a tool input that fails its schema', () => {
    const registry = new Map(makeStubRegistry().registry);
    const spec = registry.get('list_pipeline')!;
    registry.set('list_pipeline', {
      ...spec,
      input: spec.input.omit({ stage: true }).extend({ onlyStage: spec.input.shape.stage }),
    } as never);
    const r = routeUtterance('show replied', ctx({ registry }));
    expect(r.kind).toBe('refuse');
    expect((r as { text: string }).text).toMatch(/out of step/);
  });
});

describe('router: honest refusals', () => {
  it.each(REFUSED)('%s -> refused with the key note', (utterance) => {
    const r = routeUtterance(utterance, ctx());
    expect(r.kind).toBe('refuse');
    if (r.kind !== 'refuse') return;
    expect(r.text).toContain(MODE_NOTE);
    expect(r.href).toBe('/settings/integrations');
    expect(r.text).not.toMatch(/[—–!]/);
  });

  it('refuses at least twenty shapes of request', () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(20);
  });

  it('an empty message gets the command list', () => {
    expect(routeUtterance('   ', ctx())).toMatchObject({ kind: 'text' });
    expect(routeUtterance('help', ctx())).toMatchObject({ kind: 'text' });
  });
});
