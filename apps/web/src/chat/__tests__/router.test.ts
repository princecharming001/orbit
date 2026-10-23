import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { MatchablePerson } from '../agent/people-match';
import { matchPeople, rankPerson, resolvePerson } from '../agent/people-match';
import { NOT_FOLLOWED_LEAD, type RouterContext, routeUtterance } from '../agent/router';
import { registry as realRegistry } from '../registry';
import type { ChoiceOption, ToolSpec } from '../types';

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
    registry: realRegistry,
    people: PEOPLE,
    companies: ['Stripe', 'Ramp', 'Notion', 'Goldman Sachs', 'Figma', 'Datadog'],
    cards: [
      { id: 's_p1', personId: 'p1', kind: 'thank_you' },
      { id: 's_p4', personId: 'p4', kind: 'nurture_checkin' },
    ],
    drafts: [
      { id: 'out_p1', personId: 'p1', status: 'draft', kind: 'thank_you' },
      { id: 'out_p2', personId: 'p2', status: 'handed_off', kind: 'bump' },
    ],
    nextChat: { personId: 'p2' },
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
  // autopilot
  ['send these on autopilot', 'schedule_sends', {}],
  ['spread my emails over the week so they do not look like spam', 'schedule_sends', {}],
  ['schedule my drafts, 4 a day', 'schedule_sends', { perDay: 4 }],
  ['What should I do today?', 'get_today_brief', {}],
  ['start my day', 'get_today_brief', {}],
  ['my day', 'get_today_brief', {}],
  // who went quiet
  ['who went quiet', 'list_pipeline', { quietOnly: true }],
  ["who hasn't replied", 'list_pipeline', { quietOnly: true }],
  ['anyone ghosted me?', 'list_pipeline', { quietOnly: true }],
  ['Who went quiet?', 'list_pipeline', { quietOnly: true }],
  ['waiting on a reply', 'list_pipeline', { quietOnly: true }],
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
  ['drafts', 'list_drafts', { list: 'to_send' }],
  ['unsent drafts', 'list_drafts', { list: 'to_send' }],
  ['show my drafts', 'list_drafts', { list: 'to_send' }],
  ["what's ready to send", 'list_drafts', { list: 'to_send' }],
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
  ['who can introduce me to Stripe', 'find_routes', { company: 'Stripe' }],
  ['routes to Priya', 'find_routes', { personId: 'p1' }],
  ['how do I reach Ramp', 'find_routes', { company: 'Ramp' }],
  ['who do I know at Goldman Sachs', 'find_routes', { company: 'Goldman Sachs' }],
  // several people picked on a card
  ['find warm routes to each of: Priya Patel and Elena Cohen', 'find_routes', { personIds: ['p1', 'p7'] }],
  ['Routes to both of them: Priya Patel, Elena Cohen', 'find_routes', { personIds: ['p1', 'p7'] }],
  [
    'Add to People and find warm routes to each of: Dana Lee [rec li:1] and Kai Ito [rec li:2]',
    'add_sourced',
    { recommendationIds: ['li:1', 'li:2'], next: 'routes' },
  ],
  ['Add to People: Dana Lee [rec li:1]', 'add_sourced', { recommendationIds: ['li:1'] }],
  [
    'Add to People and draft a message to each of: Kai Ito [rec li:2]',
    'add_sourced',
    { recommendationIds: ['li:2'], next: 'drafts' },
  ],
  [
    'Add to People and draft a message to each of: Priya Patel and Elena Cohen',
    'create_drafts',
    { personIds: ['p1', 'p7'] },
  ],
  ['anyone at Airbnb', 'find_routes', { company: 'Airbnb' }],
  ['warm intro to Mei', 'find_routes', { personId: 'p4' }],
  // what Orbit knows, prep, and who someone knows
  ['what do I know about Priya', 'get_person', { personId: 'p1', include: ['facts', 'notes'] }],
  ['prep me for my chat with Mei', 'get_person', { personId: 'p4', include: ['prep', 'facts'] }],
  ['prep for Sofia', 'get_person', { personId: 'p5', include: ['prep', 'facts'] }],
  ['who does Daniel know', 'get_person', { personId: 'p2', include: ['connections'] }],
  ['prep me for my next chat', 'get_person', { personId: 'p2', include: ['prep', 'facts'] }],
  // notes on record, Discover, introductions, the stages, the budget
  ['show my notes', 'list_notes', {}],
  ['notes about Priya', 'list_notes', { personId: 'p1' }],
  ['show my recommendations', 'list_recommendations', {}],
  ['who should I meet', 'list_recommendations', {}],
  ['who introduced me to Mei', 'get_intro_web', { query: 'mei' }],
  ['show my introductions', 'get_intro_web', {}],
  ['what are the stages', 'explain_stage', {}],
  ['what does scheduling mean', 'explain_stage', { stage: 'scheduling' }],
  ['how many claude requests have I used', 'get_usage', {}],
  ['refresh my brief', 'refresh_brief', {}],
  // pages, people, targets and Today cards
  ['go to the map', 'open_page', { page: 'map' }],
  ['go to discover', 'open_page', { page: 'discover' }],
  ['open discover', 'list_recommendations', {}],
  ['take me to settings', 'open_page', { page: 'settings' }],
  ['open Stripe', 'find_routes', { company: 'Stripe' }],
  [
    'add a person Jordan Lee at Figma, jordan@figma.com',
    'add_person',
    { name: 'Jordan Lee', company: 'Figma', email: 'jordan@figma.com' },
  ],
  ['add Evercore to my target companies', 'manage_target_company', { action: 'add', names: 'Evercore' }],
  ['hide Lena', 'hide_person', { personId: 'p6' }],
  ['undo the move for Dan', 'undo_stage_move', { personId: 'p3' }],
  ['snooze Priya', 'manage_suggestion', { suggestionId: 's_p1', action: 'snooze', days: 1 }],
  [
    'snooze the card for Priya for a week',
    'manage_suggestion',
    { suggestionId: 's_p1', action: 'snooze', days: 7 },
  ],
  ['dismiss Mei', 'dismiss_suggestion', { suggestionId: 's_p4', reason: 'not_now' }],
  // drafts that already exist: send one, read one, log a hand-off
  ['send my draft to Priya', 'send_draft', { draftId: 'out_p1' }],
  ['send the thank you to Priya', 'send_draft', { draftId: 'out_p1' }],
  ['show my draft to Priya', 'get_draft', { draftId: 'out_p1' }],
  ['send a congrats note to Mei', 'create_draft', { kind: 'congratulate', personId: 'p4' }],
  ['I sent it to Daniel', 'confirm_handoff', { draftId: 'out_p2' }],
  // settings that change something: each asks first where it should
  ['set my tone to direct', 'update_settings', { section: 'style', tonePreset: 'direct' }],
  ['turn on claude notes', 'set_llm_feature', { feature: 'notes', on: true }],
  ['set my weekly target to 5', 'update_limits', { weeklyOutreachTarget: 5 }],
  ['load the demo', 'load_demo', {}],
  ['export my data', 'export_data', {}],
  ['delete all my data', 'delete_all_data', {}],
  ['disconnect google', 'disconnect_google', {}],
  ['set up orbit for me', 'leave_demo', {}],
  // connecting Gmail and LinkedIn shows the widget; live LinkedIn, mutuals and warm intros
  ['connect gmail', 'show_setup', { what: 'google' }],
  ['connect my Google account', 'show_setup', { what: 'google' }],
  ['how do I connect google', 'show_setup', { what: 'google' }],
  ['connect my email', 'show_setup', { what: 'google' }],
  ['connect calendar', 'show_setup', { what: 'google' }],
  ['sync my inbox', 'show_setup', { what: 'google' }],
  ['connect linkedin', 'show_setup', { what: 'linkedin' }],
  ['link my LinkedIn account', 'show_setup', { what: 'linkedin' }],
  ['sync my linkedin', 'sync_linkedin', {}],
  ['refresh my LinkedIn connections', 'sync_linkedin', {}],
  ['disconnect linkedin', 'disconnect_linkedin', {}],
  ['stop syncing LinkedIn', 'disconnect_linkedin', {}],
  ['who knows Mei', 'get_mutual_connections', { personId: 'p4' }],
  ['mutual connections with Priya', 'get_mutual_connections', { personId: 'p1' }],
  ['who do I know who knows Sofia', 'get_mutual_connections', { personId: 'p5' }],
  ['who knows someone at Stripe', 'find_routes', { company: 'Stripe' }],
  ['warm intro to Stripe', 'find_routes', { company: 'Stripe' }],
  ['warm intros into Ramp', 'find_routes', { company: 'Ramp' }],
  ['who could warmly introduce me to Mei', 'find_routes', { personId: 'p4' }],
  ['who can get me a warm intro at Figma', 'find_routes', { company: 'Figma' }],
];

/** utterance, expected href */
const POINTERS: [string, string][] = [
  ['where do I change my tone', '/settings/style'],
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
  'compare Priya and Daniel',
  'plan for this week',
];

/** Not something Orbit does: it says it did not catch that and offers the closest things it can do. */
const NOT_UNDERSTOOD: string[] = [
  'purple monkey dishwasher',
  'the mitochondria is the powerhouse of the cell',
  'blorp the flanges',
];

/** Requests the router once refused as judgement calls and now answers with a tool. */
const NOW_HANDLED: [string, string][] = [
  ['how should I prepare for my chat with Sofia?', 'get_person'],
  ['recommend who to talk to next', 'list_recommendations'],
  ['what should I send Dan next', 'create_draft'],
  ['who should I reach out to for PM at Stripe', 'find_routes'],
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
    const registry = new Map(realRegistry);
    registry.delete('move_pipeline_stage');
    const r = routeUtterance('move Priya to scheduling', ctx({ registry }));
    expect(r.kind).toBe('refuse');
    expect((r as { text: string }).text).toMatch(/can't move a chat/);
  });

  it('never hands a tool input that fails its schema', () => {
    const registry = new Map(realRegistry);
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
  // a judgement call: said plainly, with the key line, or with what Orbit can do for the person it names
  const keyRefusal = (r: ReturnType<typeof routeUtterance>) =>
    (r.kind === 'refuse' && /needs a Claude key/.test(r.text) && r.href === '/settings/integrations') ||
    (r.kind === 'tool' && r.tool === 'offer_choices' && /needs a Claude key/.test(r.lead ?? ''));

  it.each(REFUSED)('%s -> refused with the key line', (utterance) => {
    const r = routeUtterance(utterance, ctx());
    expect(keyRefusal(r), JSON.stringify(r)).toBe(true);
    const words = r.kind === 'tool' ? (r.lead ?? '') : r.text;
    expect(words).not.toMatch(/[—–!]/);
    // one short line, not the whole mode note
    expect(words.split(/\s+/).length).toBeLessThan(30);
    expect(words).not.toContain(MODE_NOTE);
  });

  it('refuses at least twelve shapes of request', () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(12);
  });

  it.each(NOT_UNDERSTOOD)('%s -> says so and offers the closest things it can do', (utterance) => {
    const r = routeUtterance(utterance, ctx());
    expect(r).toMatchObject({ kind: 'tool', tool: 'offer_choices' });
    expect((r as { lead?: string }).lead).toMatch(NOT_FOLLOWED_LEAD);
  });

  it.each(NOW_HANDLED)('%s -> once a judgement call, now %s', (utterance, tool) => {
    expect(routeUtterance(utterance, ctx())).toMatchObject({ kind: 'tool', tool });
  });

  it('an empty message gets the command list', () => {
    expect(routeUtterance('   ', ctx())).toMatchObject({ kind: 'text' });
    expect(routeUtterance('commands', ctx())).toMatchObject({ kind: 'text' });
  });
});

// ---- small talk: short, warm, one next step ----------------------------------------------------------------------

const fakeTool = (name: string, input: z.ZodObject): ToolSpec =>
  ({
    name,
    kind: 'read',
    description: name,
    input,
    capabilities: [],
    execute: async () => ({ kind: 'text', data: {}, summary: '' }),
  }) as unknown as ToolSpec;

const offerChoices = fakeTool(
  'offer_choices',
  z.object({
    options: z
      .array(z.object({ label: z.string().max(28), message: z.string() }))
      .min(2)
      .max(3),
  }),
);
const showSetup = fakeTool(
  'show_setup',
  z.object({ what: z.enum(['google', 'linkedin', 'claude_key', 'resume']) }),
);

/** The registry with the two conversation tools, whether or not the real one has them yet. */
const withTools = new Map<string, ToolSpec>([
  ...realRegistry,
  ['offer_choices', offerChoices],
  ['show_setup', showSetup],
]);
/** The registry as it was before those tools existed. */
const withoutTools = new Map<string, ToolSpec>([...realRegistry]);
withoutTools.delete('offer_choices');
withoutTools.delete('show_setup');

const EMPTY = { people: [], companies: [], cards: [], drafts: [], nextChat: undefined };
const words = (t: string) => t.trim().split(/\s+/).length;

function reply(utterance: string, c: Partial<RouterContext> = {}) {
  const r = routeUtterance(utterance, ctx({ registry: withTools, firstName: 'Alex', ...c }));
  const text = r.kind === 'tool' ? (r.lead ?? '') : r.text;
  const options = r.kind === 'tool' && r.tool === 'offer_choices' ? (r.input.options as ChoiceOption[]) : [];
  return { r, text, options };
}

/** Anything the router says in small talk reads like a friend: short, plain, one question at most. */
function expectFriendly(text: string) {
  expect(words(text), text).toBeLessThanOrEqual(45);
  expect(text).not.toMatch(/[—–!\n*#]/);
  expect(text).not.toMatch(/^\s*(\d+[.)]|[-•])\s/m);
  expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
}

describe('router: small talk with data', () => {
  it.each([
    // a capitalised hello gets a capitalised reply; a lowercase one gets lowercase back; the lines vary by message
    [
      'Hi',
      /^(?:Hey|Hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. Want to start there?',
    ],
    [
      'Hey!!',
      /^(?:Hey|Hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. Want to start there?',
    ],
    [
      'hey',
      /^(?:hey|hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
    [
      'hello!',
      /^(?:hey|hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
    [
      'hey orbit',
      /^(?:hey|hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
    [
      'hi there',
      /^(?:hey|hi) Alex(?:, good to see you)?\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
    ['yo', /^(?:yo|hey) Alex\. /, '2 people are waiting to hear from you. want to start there?'],
    [
      'wsp',
      /^(?:hey Alex, not (?:much|a lot)|not much, Alex)\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
    [
      'sup',
      /^(?:hey Alex, not (?:much|a lot)|not much, Alex)\. /,
      '2 people are waiting to hear from you. want to start there?',
    ],
  ])('%s gets a greeting in the same register, the one most useful thing, and two choices', (g, hi, rest) => {
    const { r, text, options } = reply(g, { waiting: undefined });
    expect(r).toMatchObject({ kind: 'tool', tool: 'offer_choices' });
    expect(text).toMatch(hi);
    expect(text.endsWith(rest), text).toBe(true);
    expect(options.map((o) => o.label)).toEqual(['Show me', 'Not now']);
    expectFriendly(text);
  });

  it('varies the greeting line between messages, never one fixed string', () => {
    const lines = new Set(
      ['hi', 'hey', 'hello', 'hey there', 'heyy', 'hiii', 'hey orbi', 'hello orbi', 'hiya'].map(
        (g) => reply(g).text.split('. ')[0],
      ),
    );
    expect(lines.size).toBeGreaterThanOrEqual(2);
  });

  it('greets by the time of day and without a name', () => {
    expect(reply('Good morning').text).toMatch(/^Good morning Alex\. /);
    expect(reply('gm').text).toMatch(/^morning Alex\. /);
    expect(reply('Good evening', { firstName: undefined }).text).toMatch(/^Good evening\. /);
  });

  it('counts people waiting from the engine when it says so, and says one person in the singular', () => {
    expect(reply('hey', { waiting: 3 }).text).toContain('3 people are waiting to hear from you');
    expect(reply('hey', { waiting: 1 }).text).toMatch(/someone is waiting to hear from you/i);
    // one card, one person: their name
    expect(
      reply('hey', { waiting: 1, cards: [{ id: 's', personId: 'p1', kind: 'thank_you' }] }).text,
    ).toContain('Priya is waiting to hear from you');
  });

  it('falls back to unsent drafts, then to where the chats stand', () => {
    const noCards = { cards: [] as never[] };
    const drafts = reply('hey', {
      ...noCards,
      drafts: [{ id: 'd1', personId: 'p1', status: 'draft', kind: 'thank_you' }],
    });
    expect(drafts.text).toMatch(
      /^(?:hey|hi) Alex(?:, good to see you)?\. you've got 1 draft ready to look at\. want to start there\?$/,
    );
    expect(drafts.options[0]).toEqual({ label: 'Show me', message: 'Show my drafts' });
    const none = reply('Hey', { ...noCards, drafts: [] });
    expect(none.text).toMatch(
      /^(?:Hey|Hi) Alex(?:, good to see you)?\. Nothing's waiting on you today\. Want to see where your chats stand\?$/,
    );
    expect(none.options[0]).toEqual({ label: 'Show me', message: 'Show my pipeline' });
  });

  it.each([
    [
      'who are you',
      /^(?:I'm Orbi, the AI in Orbit|Orbi, the AI inside Orbit)\. I help you reach the right people/,
    ],
    ['What can you do?', /^I help you find who to reach out to/],
    ['help', /^I help you find who to reach out to/],
    ['thanks', /^(?:anytime|of course|sure thing|you got it)\. /],
    ['ok', /^(?:okay|cool)\. /],
    ['Thank you!', /^(?:Anytime|Of course|Sure thing|You got it)\. /],
  ])('%s gets a short warm reply with choices', (u, re) => {
    const { r, text, options } = reply(u);
    expect(r).toMatchObject({ kind: 'tool', tool: 'offer_choices' });
    expect(text).toMatch(re);
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.length).toBeLessThanOrEqual(3);
    expectFriendly(text);
  });

  it('help offers three easy asks, not a command list', () => {
    const { options, text } = reply('what can you do');
    expect(options.map((o) => o.label)).toEqual([
      "What's on today",
      'Who went quiet',
      'Where my chats stand',
    ]);
    expect(text).not.toMatch(/Try:/);
  });

  it('every pill the router offers is something the router understands, with and without data', () => {
    const states: Partial<RouterContext>[] = [
      {},
      { cards: [], drafts: [{ id: 'd1', personId: 'p1', status: 'draft', kind: 'thank_you' }] },
      { cards: [], drafts: [] },
    ];
    for (const st of states)
      for (const u of ['hey', 'who are you', 'help', 'thanks', 'ok']) {
        for (const o of reply(u, st).options) {
          expect(o.label.length, o.label).toBeLessThanOrEqual(28);
          const next = routeUtterance(o.message, ctx({ registry: withTools, ...st }));
          expect(next.kind, `${u} -> ${o.message}`).not.toBe('refuse');
        }
      }
  });

  it('"Show me" opens the brief, the drafts or the pipeline, whichever the greeting named', () => {
    expect(routeUtterance("What's on today?", ctx({ registry: withTools }))).toMatchObject({
      kind: 'tool',
      tool: 'get_today_brief',
    });
    expect(routeUtterance('show me', ctx({ registry: withTools }))).toMatchObject({
      tool: 'get_today_brief',
    });
    expect(
      routeUtterance(
        'yes',
        ctx({
          registry: withTools,
          cards: [],
          drafts: [{ id: 'd', personId: 'p1', status: 'draft', kind: 'thank_you' }],
        }),
      ),
    ).toMatchObject({ tool: 'list_drafts' });
    expect(routeUtterance('sure', ctx({ registry: withTools, cards: [], drafts: [] }))).toMatchObject({
      tool: 'list_pipeline',
    });
  });

  it('"Not now" is taken gracefully and "add someone I met" asks one question', () => {
    for (const u of ['Not now', 'maybe later', 'no thanks', "I'm good"]) {
      const r = routeUtterance(u, ctx({ registry: withTools }));
      expect(r).toMatchObject({ kind: 'text' });
      expectFriendly((r as { text: string }).text);
    }
    const add = routeUtterance('Add someone I met', ctx({ registry: withTools }));
    expect(add).toMatchObject({ kind: 'text' });
    expect((add as { text: string }).text).toMatch(/Who did you meet\?/);
    expect(add).not.toMatchObject({ tool: 'add_person' });
    // a real name asks for a way to reach them, then adds
    expect(routeUtterance('add person Jordan Lee at Figma', ctx({ registry: withTools }))).toMatchObject({
      kind: 'text',
      text: expect.stringMatching(/email or LinkedIn link\?/),
    });
    expect(
      routeUtterance('add person Jordan Lee at Figma, jordan@figma.com', ctx({ registry: withTools })),
    ).toMatchObject({ tool: 'add_person' });
  });
});

describe('router: small talk on an empty account', () => {
  it.each(['hey', 'hello', 'good morning', 'what can you do?', 'help', 'who are you', 'thanks', 'ok'])(
    '%s offers one easy step with the LinkedIn widget',
    (u) => {
      const { r, text } = reply(u, EMPTY);
      expect(r).toMatchObject({ kind: 'tool', tool: 'show_setup', input: { what: 'linkedin' } });
      expect(text).toMatch(/LinkedIn/);
      expectFriendly(text);
      // one next step in prose
      expect((text.match(/\bor\b/g) ?? []).length).toBeLessThanOrEqual(0);
    },
  );

  it('keeps the greeting personal', () => {
    expect(reply('Hey', EMPTY).text).toMatch(/^(?:Hey|Hi) Alex(?:, good to see you)?\. /);
  });

  it('"I want to connect my LinkedIn" shows the drop zone instead of explaining steps', () => {
    const { r, text } = reply('import my linkedin connections', EMPTY);
    expect(r).toMatchObject({ kind: 'tool', tool: 'show_setup', input: { what: 'linkedin' } });
    expectFriendly(text);
  });
});

describe('router: LinkedIn, then Gmail', () => {
  const connected = (o: Partial<NonNullable<RouterContext['setup']>>) => ({
    setup: { linkedin: false, linkedinLive: false, google: false, ...o },
  });

  it('an empty account with LinkedIn in greets with Gmail next', () => {
    const { r, text } = reply('Hey', { ...EMPTY, ...connected({ linkedin: true }) });
    expect(r).toMatchObject({ kind: 'tool', tool: 'show_setup', input: { what: 'google' } });
    expect(text).toMatch(
      /^(?:Hey|Hi) Alex(?:, good to see you)?\. Next easy step is Gmail, so I can see who you email and send what you approve\.$/,
    );
    expectFriendly(text);
  });

  it('an empty account without LinkedIn still starts with LinkedIn, and one with both connected stays gentle', () => {
    expect(reply('hey', { ...EMPTY, ...connected({}) }).r).toMatchObject({ input: { what: 'linkedin' } });
    expect(reply('hey', { ...EMPTY, ...connected({ linkedin: true, google: true }) }).r).toMatchObject({
      input: { what: 'linkedin' },
    });
    // the sample student is never asked
    expect(reply('hey', { ...EMPTY, ...connected({ linkedin: true, demo: true }) }).r).toMatchObject({
      input: { what: 'linkedin' },
    });
  });

  it('"sync my linkedin" shows the widget when LinkedIn is not connected live', () => {
    const r = routeUtterance(
      'sync my linkedin',
      ctx({ registry: withTools, ...connected({ linkedin: true }) }),
    );
    expect(r).toMatchObject({ kind: 'tool', tool: 'show_setup', input: { what: 'linkedin' } });
    expect(
      routeUtterance('sync my linkedin', ctx({ ...connected({ linkedin: true, linkedinLive: true }) })),
    ).toMatchObject({ tool: 'sync_linkedin' });
  });

  it('every Gmail and LinkedIn line reads like a friend', () => {
    for (const u of ['connect gmail', 'sync my inbox', 'connect linkedin']) expectFriendly(reply(u).text);
    expectFriendly(reply('sync my gmail', connected({ google: true })).text);
  });

  it('says so when nobody matches a mutual-connections name', () => {
    expect(routeUtterance('who knows Zed', ctx())).toMatchObject({ kind: 'text' });
  });
});

describe('router: small talk when the conversation tools are not in the registry', () => {
  const plain = (u: string, c: Partial<RouterContext> = {}) =>
    routeUtterance(u, ctx({ registry: withoutTools, firstName: 'Alex', ...c }));

  it.each(['hey', 'help', 'who are you', 'thanks', 'ok'])('%s degrades to short plain text', (u) => {
    for (const c of [{}, EMPTY]) {
      const r = plain(u, c);
      expect(r.kind).toBe('text');
      expectFriendly((r as { text: string }).text.replace(/[?]/g, ''));
    }
  });

  it('still names the one thing to do, in words the router understands', () => {
    const r = plain('Hey') as { text: string };
    expect(r.text).toContain('Say "What\'s on today?"');
    expect(r.text).toContain('2 people are waiting to hear from you.');
    expect(r.text).not.toMatch(/Want to start there\?/);
    const e = plain('hey', EMPTY) as { text: string };
    expect(e.text).toContain('+ button');
  });

  it('LinkedIn import falls back to the pointer to Settings', () => {
    expect(plain('import my linkedin connections')).toMatchObject({
      kind: 'text',
      href: '/settings/integrations',
    });
    expect(plain('upload linkedin export')).toMatchObject({ kind: 'text', href: '/settings/integrations' });
  });

  it('the long command list stays available to anyone who asks for it', () => {
    const r = plain('commands') as { text: string };
    expect(r.text).toMatch(/^Try: /);
  });
});
