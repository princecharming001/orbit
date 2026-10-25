/**
 * A scripted ChatEngine for UI work and the e2e tests. No model, no tools: it serves canned turns with text deltas,
 * progress lines and a tool result of every kind, a confirmation flow, an error of each kind, router mode with a
 * note, chips, conversation history and Temporary mode.
 *
 * The app only uses it under test automation: `?fakeEngine=1` on the first URL, read once at startup in main.tsx,
 * and only when `navigator.webdriver` is set. The choice is kept in sessionStorage so a reload in the same tab keeps
 * the fake. `&fakeMode=llm` reports mode 'llm' instead of 'router'. Under automation the engine and its call log are
 * exposed as `window.__fakeChat` so a test can assert what the UI asked of the engine.
 *
 * Script (matched on the student's text, case-insensitive):
 *   "everything"            one turn with a result of every kind
 *   "pipeline"              a pipeline card; "quiet" a people card; "route" routes; "prep" a prep card
 *   "thank-you" / "draft"   a draft card (DraftEditor, approve through engine.approve)
 *   "note"                  a note card; "message today" a brief card; "linkedin" a confirmation then an import card
 *   "show choices"          a short answer with two tap-to-answer pills ("Show my pipeline", "What else can you do?")
 *   "setup google" / "setup linkedin" / "setup claude" / "setup resume"   a message with that inline setup widget
 *   "send it"               a needs_confirmation for send_draft with the draft embedded
 *   "wipe"                  a needs_confirmation whose blockedReason disables Approve
 *   "fail no key" / "fail cap" / "fail refusal" / "fail network" / "fail other"   an error of that kind
 *   "slow"                  a long turn with progress lines, for Stop
 *   anything else           a short text answer
 */
import type { OutboundMessage, Person, Suggestion } from '@orbit/core';
import { db } from '../../db/schema';
import { SETUP_CHIPS } from '../agent/setupChips';
import type {
  ChatAction,
  ChatConversation,
  ChatEngine,
  ChatMessage,
  ChipSpec,
  ResultEnvelope,
  SetupWhat,
  TurnEvent,
} from '../types';
import {
  fixtureChat,
  fixtureDraft,
  fixtureFacts,
  fixtureNote,
  fixtureOrganization,
  fixturePerson,
  fixtureRoutes,
  fixtureSuggestion,
} from './fixtures';

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeChatEngine extends ChatEngine {
  calls: FakeCall[];
  /** every conversation, temporary ones included (the tests check what is and is not saved) */
  all(): ChatConversation[];
}

export const FAKE_MODE_NOTE =
  'Orbit is answering from templates because no Claude key is set. Add one in Settings to let it draft and answer freely.';

export const CHIPS: ChipSpec[] = [
  {
    id: 'who-today',
    label: 'Who should I message today',
    tool: 'get_brief',
    input: {},
    asUser: 'Who should I message today?',
  },
  {
    id: 'thank-you',
    label: 'Draft a thank-you',
    tool: 'create_draft',
    input: { kind: 'thank_you' },
    asUser: 'Draft a thank-you',
  },
  {
    id: 'route',
    label: 'Find a route to a company',
    tool: 'find_routes',
    input: {},
    asUser: 'Find a route to a company',
  },
  {
    id: 'add-note',
    label: 'Add a note from a chat',
    tool: 'add_note',
    input: {},
    asUser: 'Add a note from a chat',
  },
  { id: 'quiet', label: 'Who went quiet', tool: 'list_quiet', input: {}, asUser: 'Who went quiet?' },
  {
    id: 'prep',
    label: 'Prep for my next chat',
    tool: 'get_prep',
    input: {},
    asUser: 'Prep for my next chat',
  },
  {
    id: 'linkedin',
    label: 'Import my LinkedIn',
    tool: 'import_linkedin',
    input: {},
    asUser: 'Import my LinkedIn',
  },
  { id: 'pipeline', label: 'Show my pipeline', tool: 'get_pipeline', input: {}, asUser: 'Show my pipeline' },
];

type Script = (ctx: Ctx) => AsyncGenerator<TurnEvent, void, void>;
interface Ctx {
  people: Person[];
  draft: OutboundMessage;
  suggestion: Suggestion;
  nextId: () => string;
  signal?: AbortSignal;
}

export function createFakeChatEngine(opts: { mode?: 'llm' | 'router'; delay?: number } = {}): FakeChatEngine {
  const mode = opts.mode ?? 'router';
  const delay = opts.delay ?? 10;
  const conversations = new Map<string, ChatConversation>();
  const temporary = new Set<string>();
  const messages = new Map<string, ChatMessage[]>();
  const actions = new Map<string, ChatAction[]>();
  const calls: FakeCall[] = [];
  let n = 0;
  const nextId = () => `fk_${++n}`;
  const now = () => new Date().toISOString();
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });

  async function context(signal?: AbortSignal): Promise<Ctx> {
    // real rows when the demo is loaded (the draft card then approves against a person the send rules know)
    let people: Person[] = [];
    let suggestion: Suggestion | undefined;
    try {
      const userId = (await db.kv.get('currentUserId'))?.value as string | undefined;
      if (userId) {
        people = (
          await db.people
            .where('userId')
            .equals(userId)
            .filter((p) => p.isHuman && !p.hiddenAt)
            .toArray()
        )
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 4);
        suggestion = await db.suggestions
          .where('userId')
          .equals(userId)
          .filter((s) => s.status === 'pending' && !!s.personId)
          .first();
      }
    } catch {
      // no database in this environment: fixtures do
    }
    if (people.length < 2) people = [0, 1, 2, 3].map((i) => fixturePerson(i));
    const draft = fixtureDraft(people[0]!, { userId: people[0]!.userId });
    return { people, draft, suggestion: suggestion ?? fixtureSuggestion(people[0]!), nextId, signal };
  }

  /** Streams a turn: records the student's message, emits events, and stores the assistant blocks. */
  async function run(
    conversationId: string,
    userText: string,
    script: Script,
    onEvent: (e: TurnEvent) => void,
    signal?: AbortSignal,
  ) {
    const conv = conversations.get(conversationId);
    if (!conv) throw new Error(`No conversation ${conversationId}`);
    const list = messages.get(conversationId) ?? [];
    messages.set(conversationId, list);
    list.push({
      id: nextId(),
      conversationId,
      userId: conv.userId,
      seq: list.length,
      role: 'user',
      content: [{ type: 'text', text: userText }],
      createdAt: now(),
    });
    if (conv.title === 'New chat')
      conv.title = userText.length > 44 ? `${userText.slice(0, 41)}...` : userText;
    conv.updatedAt = now();
    const blocks: unknown[] = [];
    let text = '';
    const flush = () => {
      if (text) blocks.push({ type: 'text', text });
      text = '';
    };
    const ctx = await context(signal);
    const acts = actions.get(conversationId) ?? [];
    actions.set(conversationId, acts);
    const assistantId = nextId();
    let ended = false;
    for await (const e of script(ctx)) {
      if (signal?.aborted) break;
      if (e.type === 'text') text += e.delta;
      if (e.type === 'tool_start') {
        flush();
        blocks.push({ type: 'tool_use', id: e.toolUseId, name: e.toolName, input: {} });
        acts.push({
          id: e.toolUseId,
          conversationId,
          userId: conv.userId,
          messageId: assistantId,
          toolName: e.toolName,
          input: {},
          status: 'running',
          createdAt: now(),
          updatedAt: now(),
        });
      }
      if (e.type === 'tool_result') {
        const a = acts.find((x) => x.id === e.toolUseId);
        if (a) {
          a.status =
            e.envelope.kind === 'needs_confirmation'
              ? 'pending'
              : e.envelope.kind === 'error'
                ? 'error'
                : 'done';
          a.envelope = e.envelope;
          a.summary = e.envelope.summary;
          a.blockedReason = (e.envelope.data as { blockedReason?: string } | undefined)?.blockedReason;
          a.updatedAt = now();
        }
      }
      if (e.type === 'done' || e.type === 'error') ended = true;
      onEvent(e.type === 'done' ? { ...e, messageId: assistantId } : e);
      if (e.type === 'error') {
        flush();
        list.push({
          id: nextId(),
          conversationId,
          userId: conv.userId,
          seq: list.length,
          role: 'system',
          content: e.message,
          meta: 'error',
          createdAt: now(),
        });
      }
      if (ended) break;
      await sleep(delay, signal);
    }
    flush();
    if (blocks.length)
      list.push({
        id: assistantId,
        conversationId,
        userId: conv.userId,
        seq: list.length,
        role: 'assistant',
        content: blocks,
        stopReason: signal?.aborted ? 'aborted' : 'end_turn',
        createdAt: now(),
      });
    if (signal?.aborted && !ended) onEvent({ type: 'error', kind: 'aborted', message: 'Stopped.' });
    else if (!ended) onEvent({ type: 'done', stopReason: 'end_turn', messageId: assistantId });
  }

  const engine: FakeChatEngine = {
    calls,
    all: () => [...conversations.values()],
    mode: () => mode,
    modeNote: () =>
      mode === 'router' ? { text: FAKE_MODE_NOTE, href: '/settings/integrations' } : undefined,
    async startConversation({ temporary: temp }) {
      log('startConversation', { temporary: temp });
      const c: ChatConversation = {
        id: nextId(),
        userId: 'local',
        title: 'New chat',
        model: mode === 'llm' ? 'claude' : 'router',
        createdAt: now(),
        updatedAt: now(),
      };
      conversations.set(c.id, c);
      if (temp) temporary.add(c.id);
      return c;
    },
    async listConversations() {
      return [...conversations.values()]
        .filter((c) => !temporary.has(c.id) && !c.archivedAt && (messages.get(c.id)?.length ?? 0) > 0)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async loadConversation(id) {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error(`No conversation ${id}`);
      return { conversation, messages: [...(messages.get(id) ?? [])], actions: [...(actions.get(id) ?? [])] };
    },
    async renameConversation(id, title) {
      log('renameConversation', id, title);
      const c = conversations.get(id);
      if (c) c.title = title;
    },
    async archiveConversation(id) {
      log('archiveConversation', id);
      const c = conversations.get(id);
      if (c) c.archivedAt = now();
    },
    async send(conversationId, text, onEvent, signal) {
      log('send', conversationId, text);
      await run(conversationId, text, pick(text), onEvent, signal);
    },
    chips: () => CHIPS,
    async runChip(conversationId, chipId, onEvent) {
      log('runChip', conversationId, chipId);
      const chip = CHIPS.find((c) => c.id === chipId) ?? SETUP_CHIPS.find((c) => c.id === chipId);
      if (!chip) throw new Error(`No chip ${chipId}`);
      // the home's Connect buttons post the setup widget, like "setup linkedin" typed here
      const script =
        chip.tool === 'show_setup'
          ? pick(`setup ${chip.input.what === 'google' ? 'google' : 'linkedin'}`)
          : chipScript(chip);
      await run(conversationId, chip.asUser, script, onEvent);
    },
    async approve(actionId, edited) {
      log('approve', actionId, edited);
      for (const [conversationId, acts] of actions) {
        const a = acts.find((x) => x.id === actionId || x.envelope?.confirmationId === actionId);
        if (!a) continue;
        if (a.blockedReason) return { kind: 'error', data: {}, summary: a.blockedReason };
        const ctx = await context();
        const result = approvedEnvelope(a.toolName, ctx, edited);
        a.status = 'done';
        a.updatedAt = now();
        decision(conversationId, `Approved: ${a.summary ?? a.toolName}`);
        return result;
      }
      return { kind: 'error', data: {}, summary: 'That request has expired. Ask again.' };
    },
    async cancel(actionId) {
      log('cancel', actionId);
      for (const [conversationId, acts] of actions) {
        const a = acts.find((x) => x.id === actionId || x.envelope?.confirmationId === actionId);
        if (!a) continue;
        a.status = 'cancelled';
        a.updatedAt = now();
        decision(conversationId, `Cancelled: ${a.summary ?? a.toolName}`);
      }
    },
    async attach(conversationId, file, kind, onEvent) {
      log('attach', conversationId, { name: file.name, size: file.size, type: file.type }, kind);
      const label = { note: 'note', resume: 'resume', linkedin: 'LinkedIn export', email: 'email' }[kind];
      await run(conversationId, `Attached ${label}: ${file.name}`, attachScript(kind, file), onEvent);
    },
  };

  function decision(conversationId: string, text: string) {
    const conv = conversations.get(conversationId);
    const list = messages.get(conversationId);
    if (!conv || !list) return;
    list.push({
      id: nextId(),
      conversationId,
      userId: conv.userId,
      seq: list.length,
      role: 'system',
      content: text,
      meta: 'decision',
      createdAt: now(),
    });
  }

  if (typeof window !== 'undefined' && navigator.webdriver)
    (window as unknown as { __fakeChat: unknown }).__fakeChat = engine;
  return engine;
}

// ---- scripts ---------------------------------------------------------------------------------------------

async function* say(text: string): AsyncGenerator<TurnEvent> {
  // word by word, so the UI's streaming path is exercised
  for (const part of text.split(/(?<=\s)/)) yield { type: 'text', delta: part };
}

function* tool(id: string, name: string, progress: string, envelope: ResultEnvelope): Generator<TurnEvent> {
  yield { type: 'tool_start', toolUseId: id, toolName: name, progress };
  yield { type: 'tool_result', toolUseId: id, envelope };
}

function envelopes(ctx: Ctx): Record<string, () => ResultEnvelope> {
  const [p0, p1, p2, p3] = [
    ctx.people[0]!,
    ctx.people[1]!,
    ctx.people[2] ?? ctx.people[0]!,
    ctx.people[3] ?? ctx.people[1]!,
  ];
  return {
    person: () => ({
      kind: 'person',
      data: {
        person: p0,
        chat: fixtureChat(p0, 'completed'),
        facts: fixtureFacts(p0)
          .slice(0, 2)
          .map((f) => f.text),
      },
      summary: `${p0.displayName}, ${p0.currentTitle ?? 'contact'} at ${p0.currentOrganizationRaw ?? 'their company'}.`,
      href: `/people/${p0.id}`,
    }),
    people: () => ({
      kind: 'people',
      data: {
        people: [
          { person: p1, why: 'No reply in 6 business days' },
          { person: p2, why: 'Last spoke three weeks ago' },
        ],
      },
      summary: 'Two people have gone quiet.',
      href: '/people?view=board&quiet=1',
    }),
    draft: () => ({
      kind: 'draft',
      data: { draft: ctx.draft, person: p0 },
      summary: `A thank-you to ${p0.firstName} is ready to review.`,
      href: `/inbox?draft=${ctx.draft.id}`,
    }),
    drafts: () => ({
      kind: 'drafts',
      data: {
        drafts: [
          { draft: ctx.draft, person: p0 },
          {
            draft: fixtureDraft(p1, {
              id: `fx_out_${p1.id}`,
              kind: 'bump',
              status: 'handed_off',
              subject: 'Following up',
            }),
            person: p1,
          },
        ],
      },
      summary: 'Two drafts are waiting on you.',
      href: '/inbox',
    }),
    pipeline: () => ({
      kind: 'pipeline',
      data: {
        items: [
          { chat: fixtureChat(p0, 'completed'), person: p0, nextStep: 'Send the thank-you' },
          { chat: fixtureChat(p1, 'outreach_sent'), person: p1, nextStep: 'Bump on Thursday' },
          { chat: fixtureChat(p2, 'scheduled'), person: p2, nextStep: 'Prep questions' },
        ],
        counts: { completed: 1, outreach_sent: 1, scheduled: 1 },
      },
      summary: 'Three conversations are moving: one to thank, one to bump, one to prep for.',
      href: '/people?view=board',
    }),
    routes: () => ({
      kind: 'routes',
      data: { to: p3, routes: fixtureRoutes(p3, p0), people: { [p0.id]: p0, [p3.id]: p3 } },
      summary: `The warmest way to ${p3.firstName} is through ${p0.firstName}.`,
      href: `/map?reach=1&to=${p3.id}`,
    }),
    brief: () => ({
      kind: 'brief',
      data: { suggestions: [ctx.suggestion], summary: 'One thing worth doing today.' },
      summary: 'One thing worth doing today.',
      href: '/inbox',
    }),
    suggestion: () => ({
      kind: 'suggestion',
      data: { suggestion: ctx.suggestion },
      summary: ctx.suggestion.reasonText,
      href: `/inbox?card=${ctx.suggestion.id}`,
    }),
    note: () => ({
      kind: 'note',
      data: { note: fixtureNote(p0), person: p0, facts: fixtureFacts(p0).slice(0, 2) },
      summary: `Saved a note on ${p0.firstName} with two facts.`,
      href: `/people/${p0.id}#notes`,
    }),
    list: () => ({
      kind: 'list',
      data: {
        title: 'Your goals',
        items: [
          { text: 'Land a PM internship', chip: 'Recruiting', sub: 'Stripe, Ramp', href: '/settings/goals' },
          {
            text: 'Raise a pre-seed',
            chip: 'Fundraising',
            links: [{ label: '[1]', url: 'https://example.com' }],
          },
        ],
      },
      summary: '2 goals: Land a PM internship; Raise a pre-seed.',
      href: '/settings/goals',
    }),
    facts: () => ({
      kind: 'facts',
      data: { person: p0, facts: fixtureFacts(p0) },
      summary: `Three things you know about ${p0.firstName}.`,
      href: `/people/${p0.id}`,
    }),
    company: () => ({
      kind: 'company',
      data: { organization: fixtureOrganization(), people: [p0, p1], target: true },
      summary: 'Ramp: two people you know, and it is on your target list.',
      href: '/companies/fx_org_ramp',
    }),
    settings: () => ({
      kind: 'settings',
      data: { section: 'limits', changes: [{ label: 'Daily email limit', from: '15', to: '10' }] },
      summary: 'Daily email limit set to 10.',
      href: '/settings/limits',
    }),
    import: () => ({
      kind: 'import',
      data: { source: 'LinkedIn connections', counts: { added: 42, updated: 7, skipped: 3 } },
      summary: '42 people added and 7 updated from your LinkedIn export.',
      href: '/people',
    }),
    prep: () => ({
      kind: 'prep',
      data: {
        person: p2,
        when: '2026-10-07T14:00:00.000Z',
        summary: `${p2.firstName} leads product at ${p2.currentOrganizationRaw}. You met through a mutual friend.`,
        questions: [
          'How did you pick product over consulting?',
          'What does a strong first month look like on your team?',
        ],
        facts: fixtureFacts(p2)
          .slice(0, 2)
          .map((f) => f.text),
      },
      summary: `Prep for your chat with ${p2.firstName} on Wednesday.`,
      href: `/people/${p2.id}?tab=facts&prep=1`,
    }),
    needs_confirmation: () => ({
      kind: 'needs_confirmation',
      data: {
        toolName: 'send_draft',
        text: `Send the thank-you to ${p0.firstName} by email.`,
        draft: ctx.draft,
        person: p0,
      },
      summary: `Send the thank-you to ${p0.firstName} by email.`,
      confirmationId: `conf_${ctx.nextId()}`,
    }),
    blocked: () => ({
      kind: 'needs_confirmation',
      data: {
        toolName: 'wipe_data',
        text: 'Delete everything Orbit holds in this browser.',
        blockedReason: 'Export your data first. There is no undo for this.',
      },
      summary: 'Delete everything Orbit holds in this browser.',
      confirmationId: `conf_${ctx.nextId()}`,
    }),
    import_confirm: () => ({
      kind: 'needs_confirmation',
      data: { toolName: 'import_linkedin', text: 'Import your LinkedIn connections from the last export.' },
      summary: 'Import your LinkedIn connections from the last export.',
      confirmationId: `conf_${ctx.nextId()}`,
      continues: true,
    }),
    choices: () => ({
      kind: 'choices',
      data: {
        options: [
          { label: 'Show my pipeline', message: 'Show my pipeline' },
          { label: 'What else can you do?', message: 'What else can you do?' },
        ],
      },
      summary: 'Showed 2 options to tap.',
    }),
    setup_google: () => setup('google'),
    setup_linkedin: () => setup('linkedin'),
    setup_claude_key: () => setup('claude_key'),
    setup_resume: () => setup('resume'),
    error: () => ({
      kind: 'error',
      data: { message: 'Orbit could not find a chat with that person.' },
      summary: 'Orbit could not find a chat with that person.',
    }),
  };
}

function setup(what: SetupWhat): ResultEnvelope {
  return { kind: 'setup', data: { what }, summary: `Showed the ${what.replace('_', ' ')} setup.` };
}

const ALL: [kind: string, tool: string, progress: string][] = [
  ['person', 'get_person', 'Looking up the person'],
  ['people', 'list_quiet', 'Checking who went quiet'],
  ['draft', 'create_draft', 'Drafting a thank-you'],
  ['drafts', 'list_drafts', 'Listing your drafts'],
  ['pipeline', 'get_pipeline', 'Looking at your pipeline'],
  ['routes', 'find_routes', 'Finding a warm route'],
  ['brief', 'get_brief', 'Reading today'],
  ['suggestion', 'get_suggestion', 'Reading the card'],
  ['note', 'add_note', 'Saving the note'],
  ['facts', 'get_facts', 'Reading your notes'],
  ['company', 'get_company', 'Looking up the company'],
  ['settings', 'update_settings', 'Changing a setting'],
  ['import', 'import_linkedin', 'Importing connections'],
  ['prep', 'get_prep', 'Preparing your brief'],
  ['list', 'list_goals', 'Reading your goals'],
  ['needs_confirmation', 'send_draft', 'Getting ready to send'],
  ['error', 'get_chat', 'Finding the chat'],
];

function pick(text: string): Script {
  const t = text.toLowerCase();
  if (t.includes('everything')) return everything;
  if (t.includes('show choices')) return withChoices;
  const widget = t.match(/setup (google|linkedin|claude|resume)/);
  if (widget) return withSetup(widget[1] === 'claude' ? 'claude_key' : (widget[1] as SetupWhat));
  const fail = t.match(/fail (no key|cap|refusal|network|other)/);
  if (fail) return failing(fail[1]!.replace(' ', '_') as 'no_key' | 'cap' | 'refusal' | 'network' | 'other');
  if (t.includes('slow')) return slow;
  if (t.includes('send it'))
    return single(
      'needs_confirmation',
      'send_draft',
      'Getting ready to send',
      'Review it once more, then approve and Orbit opens the email.',
    );
  if (t.includes('wipe'))
    return single(
      'blocked',
      'wipe_data',
      'Checking what would go',
      'This one is blocked until you export first.',
    );
  if (t.includes('pipeline'))
    return single('pipeline', 'get_pipeline', 'Looking at your pipeline', 'Here is where things stand.');
  if (t.includes('quiet'))
    return single(
      'people',
      'list_quiet',
      'Checking who went quiet',
      'Two people have not replied for a while.',
    );
  if (t.includes('route'))
    return single(
      'routes',
      'find_routes',
      'Finding a warm route',
      'The warmest way in goes through someone you already know.',
    );
  if (t.includes('prep'))
    return single('prep', 'get_prep', 'Preparing your brief', 'Here is what to have in mind.');
  if (t.includes('thank') || t.includes('draft'))
    return single(
      'draft',
      'create_draft',
      'Drafting a thank-you',
      'Edit anything, then send it when it reads like you.',
    );
  if (t.includes('note'))
    return single('note', 'add_note', 'Saving the note', 'Saved. The facts are on their profile.');
  if (t.includes('linkedin'))
    return single(
      'import_confirm',
      'import_linkedin',
      'Checking the export',
      'Approve and Orbit imports the file.',
    );
  if (t.includes('message today') || t.includes('who should'))
    return single('brief', 'get_brief', 'Reading today', 'One thing is worth doing today.');
  if (t.includes('who is') || t.includes('tell me about'))
    return single('person', 'get_person', 'Looking up the person', 'Here is what you have on them.');
  return plain;
}

function chipScript(chip: ChipSpec): Script {
  return pick(chip.asUser);
}

function attachScript(kind: 'note' | 'resume' | 'linkedin' | 'email', file: File): Script {
  const map = {
    note: ['note', 'add_note', 'Reading the note', `Saved your note from ${file.name}.`],
    resume: ['settings', 'update_resume', 'Reading your resume', 'Your resume is on file.'],
    linkedin: [
      'import_confirm',
      'import_linkedin',
      'Checking the export',
      'Approve and Orbit imports the file.',
    ],
    email: ['person', 'ingest_email', 'Reading the email', 'Filed under the person it came from.'],
  } as const;
  const [kind2, tool2, progress, text] = map[kind];
  return single(kind2, tool2, progress, text);
}

function single(kind: string, toolName: string, progress: string, text: string): Script {
  return async function* (ctx) {
    yield { type: 'progress', text: 'Thinking about what you need' };
    yield* tool(`tu_${ctx.nextId()}`, toolName, progress, envelopes(ctx)[kind]!());
    yield* say(text);
    yield { type: 'done', stopReason: 'end_turn', messageId: '' };
  };
}

const everything: Script = async function* (ctx) {
  yield* say('Here is one of everything Orbit can show in a chat. ');
  const env = envelopes(ctx);
  for (const [kind, toolName, progress] of ALL) {
    yield { type: 'progress', text: progress };
    yield* tool(`tu_${ctx.nextId()}`, toolName, progress, env[kind]!());
  }
  yield* say('That is the whole set. Each card opens its page in the app.');
  yield { type: 'done', stopReason: 'end_turn', messageId: '' };
};

/** A short answer with two pills under it, the way the model ends a reply with offer_choices. */
const withChoices: Script = async function* (ctx) {
  yield* say('I can pull up your pipeline or tell you more about what I do. ');
  yield* tool(`tu_${ctx.nextId()}`, 'offer_choices', 'Adding options', envelopes(ctx).choices!());
  yield { type: 'done', stopReason: 'end_turn', messageId: '' };
};

function withSetup(what: SetupWhat): Script {
  return async function* (ctx) {
    yield* say('Here is the setup, right in the chat. ');
    yield* tool(
      `tu_${ctx.nextId()}`,
      'show_setup',
      'Getting the setup ready',
      envelopes(ctx)[`setup_${what}`]!(),
    );
    yield { type: 'done', stopReason: 'end_turn', messageId: '' };
  };
}

const plain: Script = async function* () {
  yield* say(
    'I can look at your pipeline, draft a message, find a route to a company, save a note, or prep you for a chat. Try one of the chips, or ask in your own words.',
  );
  yield { type: 'done', stopReason: 'end_turn', messageId: '' };
};

const slow: Script = async function* (ctx) {
  yield { type: 'progress', text: 'Reading your pipeline' };
  for (let i = 0; i < 40; i++) {
    yield { type: 'text', delta: `Still working, line ${i + 1}. ` };
    if (i === 10) yield { type: 'progress', text: 'Checking the calendar' };
    await new Promise((r) => setTimeout(r, 80));
    if (ctx.signal?.aborted) return;
  }
  yield { type: 'done', stopReason: 'end_turn', messageId: '' };
};

function failing(kind: 'no_key' | 'cap' | 'refusal' | 'network' | 'other'): Script {
  const message = {
    no_key: 'This needs a Claude key. Add one in Settings under Integrations.',
    cap: 'You have used today’s Claude budget. It resets at midnight.',
    refusal: 'Claude declined to answer that one.',
    network: 'Orbit could not reach Claude. Check your connection and try again.',
    other: 'Something went wrong on Orbit’s side.',
  }[kind];
  return async function* () {
    yield* say('Let me try. ');
    yield { type: 'error', kind, message };
  };
}

function approvedEnvelope(
  toolName: string,
  ctx: Ctx,
  edited?: { body: string; subject?: string },
): ResultEnvelope {
  const env = envelopes(ctx);
  if (toolName === 'send_draft') {
    const p0 = ctx.people[0]!;
    return {
      kind: 'draft',
      data: {
        draft: {
          ...ctx.draft,
          status: 'handed_off',
          handoffVia: 'mailto',
          bodyFinal: edited?.body,
          subject: edited?.subject ?? ctx.draft.subject,
        },
        person: p0,
      },
      summary: `Opened your mail app with the email to ${p0.firstName}. Press I sent it once it is out.`,
      href: `/inbox?draft=${ctx.draft.id}`,
    };
  }
  if (toolName === 'import_linkedin') return env.import!();
  if (toolName === 'wipe_data') return env.settings!();
  return { kind: 'text', data: {}, summary: 'Done.' };
}
