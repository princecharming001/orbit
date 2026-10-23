/**
 * The chat end to end: the REAL engine (createChatEngine) over the REAL registry and execute(), on the demo in
 * fake-indexeddb. (a) Router mode, no key: realistic student requests from every area of the capability inventory,
 * each running the right tool or answering honestly that it needs a Claude key. (b) Claude mode through the scripted
 * Anthropic fetch (the real SDK, the real tool runner): conversations that call real tools and change real rows, with
 * nothing sent, wiped or imported before Approve. (c) Coverage: every capability is claimed by a tool and every tool is
 * reachable by the model's tool list or by the UI.
 */
import type { User } from '@orbit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { ATTACH_TOOL, createChatEngine } from '../agent';
import { CHIPS } from '../agent/chips';
import { makeChatClient, setChatClientFactoryForTests } from '../agent/client';
import { buildRunnerTools } from '../agent/loop';
import { routeUtterance } from '../agent/router';
import { CAPABILITIES } from '../capabilities';
import { execute, registry, tools } from '../registry';
import { type FakeAnthropic, messageRequests, type ScriptTurn, scriptedFetch } from '../test/fakeAnthropic';
import type { ChatEngine, ResultEnvelope, TurnEvent } from '../types';
import { NOW } from './helpers';

const DASH = /[—–]/;
/** a snake_case word (an internal code) in a sentence the student reads */
const CODE = /(^|[\s(])[a-z]+_[a-z_]+\b/;

interface Turn {
  id: string;
  events: TurnEvent[];
  tools: string[];
  envs: ResultEnvelope[];
  env?: ResultEnvelope;
  text: string;
}

function collect(id: string, events: TurnEvent[]): Turn {
  const tools = events.flatMap((e) => (e.type === 'tool_start' ? [e.toolName] : []));
  const envs = events.flatMap((e) => (e.type === 'tool_result' ? [e.envelope] : []));
  const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
  return { id, events, tools, envs, env: envs.at(-1), text };
}

let user: User;
let engine: ChatEngine;

async function say(text: string, conversationId?: string): Promise<Turn> {
  const id = conversationId ?? (await engine.startConversation({ temporary: false })).id;
  const events: TurnEvent[] = [];
  await engine.send(id, text, (e) => events.push(e));
  return collect(id, events);
}

const peopleCount = () => db.people.where('userId').equals(user.id).count();

// ---------------------------------------------------------------------------------------------------------------
// (a) router mode
// ---------------------------------------------------------------------------------------------------------------

type Expect = {
  /** the tool that must run; undefined: an honest text answer, no tool */
  tool?: string;
  /** envelope kinds that count as a sensible answer (default: anything but error) */
  kinds?: ResultEnvelope['kind'][];
  /** the reply must say this needs a key (and link Settings) */
  needsKey?: boolean;
  /** a pointer to this page */
  href?: string;
};

/** [area, what the student types, what must happen] */
const REQUESTS: [string, string, Expect][] = [
  // 0 shell and navigation
  ['nav', 'go to the map', { tool: 'open_page', kinds: ['text'] }],
  ['nav', 'take me to settings', { tool: 'open_page', kinds: ['text'] }],
  ['nav', 'find Hannah', { tool: 'get_person', kinds: ['person'] }],
  // 1 today and the brief
  ['today', "what's on today", { tool: 'get_today_brief', kinds: ['brief'] }],
  ['today', 'start my day', { tool: 'get_today_brief', kinds: ['brief'] }],
  ['today', 'snooze Diego Silva for a week', { tool: 'manage_suggestion', kinds: ['suggestion'] }],
  ['today', 'refresh my brief', { tool: 'refresh_brief', kinds: ['brief'] }],
  ['today', 'dismiss Victor', { tool: 'dismiss_suggestion', kinds: ['needs_confirmation'] }],
  ['today', 'show my drafts', { tool: 'list_drafts', kinds: ['drafts'] }],
  // 2 pipeline
  ['pipeline', 'show my pipeline', { tool: 'list_pipeline', kinds: ['pipeline'] }],
  ['pipeline', 'who went quiet?', { tool: 'list_pipeline', kinds: ['pipeline'] }],
  ['pipeline', 'who is scheduled', { tool: 'list_pipeline', kinds: ['pipeline'] }],
  ['pipeline', 'move Jonah to replied', { tool: 'move_pipeline_stage', kinds: ['pipeline'] }],
  ['pipeline', 'undo the move for Jonah', { tool: 'undo_stage_move', kinds: ['pipeline'] }],
  ['pipeline', 'move Ethan to completed', { tool: 'move_pipeline_stage', kinds: ['pipeline'] }],
  ['pipeline', 'what does scheduling mean', { tool: 'explain_stage', kinds: ['text'] }],
  // 3 people and profiles
  ['people', 'who is Hannah Brooks', { tool: 'get_person', kinds: ['person'] }],
  ['people', 'what do I know about Lena', { tool: 'get_person', kinds: ['person'] }],
  ['people', 'who does Maya know', { tool: 'get_person', kinds: ['person'] }],
  ['people', 'prep me for my next chat', { tool: 'get_person', kinds: ['person'] }],
  ['people', 'prep for Omar', { tool: 'get_person', kinds: ['person'] }],
  [
    'people',
    'add a person Jordan Lee at Figma, jordan.lee@figma-demo.com',
    { tool: 'add_person', kinds: ['person'] },
  ],
  ['people', 'hide Victor', { tool: 'hide_person', kinds: ['needs_confirmation'] }],
  // 4 drafts and sending
  ['drafts', 'draft a thank you to Lena', { tool: 'create_draft', kinds: ['draft'] }],
  ['drafts', 'follow up with Caleb', { tool: 'create_draft', kinds: ['draft'] }],
  ['drafts', 'congratulate Maya', { tool: 'create_draft', kinds: ['draft'] }],
  ['drafts', 'show my draft to Hannah', { tool: 'get_draft', kinds: ['draft'] }],
  ['drafts', 'send my draft to Daniel', { tool: 'send_draft', kinds: ['needs_confirmation'] }],
  ['drafts', 'unsent drafts', { tool: 'list_drafts', kinds: ['drafts'] }],
  // 5 notes
  [
    'notes',
    'note about Lena: she offered to refer me to the Ramp platform team',
    { tool: 'add_note', kinds: ['note'] },
  ],
  ['notes', 'show my notes', { tool: 'list_notes', kinds: ['note'] }],
  ['notes', 'add a note', { href: '/notes/new' }],
  // 6 map and reach
  ['map', 'who can introduce me to Stripe', { tool: 'find_routes', kinds: ['company'] }],
  ['map', 'routes to Daniel', { tool: 'find_routes', kinds: ['routes'] }],
  ['map', 'who do I know at Figma', { tool: 'find_routes', kinds: ['company'] }],
  ['map', 'show my introductions', { tool: 'get_intro_web', kinds: ['routes'] }],
  // 7 discover
  ['discover', 'show my recommendations', { tool: 'list_recommendations', kinds: ['people'] }],
  ['discover', 'who should I meet', { tool: 'list_recommendations', kinds: ['people'] }],
  // 8 integrations and imports
  [
    'integrations',
    'import my linkedin connections',
    // the drop zone once the setup tool exists, the pointer to Settings before
    registry.has('show_setup')
      ? { tool: 'show_setup', kinds: ['setup'] }
      : { href: '/settings/integrations' },
  ],
  ['integrations', 'disconnect google', { tool: 'disconnect_google', kinds: ['needs_confirmation'] }],
  ['integrations', 'how many claude requests have I used', { tool: 'get_usage', kinds: ['settings'] }],
  // 9 settings and account
  ['settings', 'set my tone to direct', { tool: 'update_settings', kinds: ['settings'] }],
  ['settings', 'set my weekly target to 5', { tool: 'update_limits', kinds: ['needs_confirmation'] }],
  ['settings', 'add Evercore to my target companies', { tool: 'manage_target_company', kinds: ['settings'] }],
  ['settings', 'turn on claude notes', { tool: 'set_llm_feature', kinds: ['needs_confirmation'] }],
  ['settings', 'export my data', { tool: 'export_data', kinds: ['needs_confirmation'] }],
  ['settings', 'where do I change my tone', { href: '/settings/style' }],
  // 10 onboarding, 11 demo
  ['demo', 'load the demo', { tool: 'load_demo', kinds: ['needs_confirmation'] }],
  ['demo', 'delete all my data', { tool: 'delete_all_data', kinds: ['needs_confirmation'] }],
  // judgement calls: an honest "needs a Claude key"
  ['needs a key', "why hasn't Daniel replied?", { needsKey: true }],
  // shortening is something Orbit does without a key now: the ask stays, the padding goes
  ['drafts', 'rewrite my draft to Lena so it is shorter', { tool: 'update_draft_body', kinds: ['draft'] }],
  ['needs a key', 'should I email Caleb again?', { needsKey: true }],
  ['needs a key', 'what is the best way to ask Maya for a referral', { needsKey: true }],
];

describe('router mode: the real engine over the real registry, no key', () => {
  beforeAll(async () => {
    await clearPrefs();
    user = await loadDemo({ reset: true, now: NOW });
    engine = createChatEngine({ registry, execute, user: () => user, now: () => NOW });
  }, 90_000);

  it('handles at least forty requests from every area of the inventory', () => {
    expect(REQUESTS.length).toBeGreaterThanOrEqual(40);
    const areas = new Set(REQUESTS.map(([a]) => a));
    for (const a of ['nav', 'today', 'pipeline', 'people', 'drafts', 'notes', 'map', 'discover'])
      expect(areas.has(a), a).toBe(true);
    for (const a of ['integrations', 'settings', 'demo', 'needs a key']) expect(areas.has(a), a).toBe(true);
  });

  it.each(REQUESTS)('[%s] %s', async (_area, utterance, want) => {
    expect(engine.mode()).toBe('router');
    const t = await say(utterance);
    const last = t.events.at(-1)!;
    expect(last.type, JSON.stringify(last)).toBe('done');
    if (want.tool) {
      expect(t.tools, `${utterance}: ${t.text}`).toEqual([want.tool]);
      const env = t.env!;
      expect(env.kind, `${utterance}: ${env.summary}`).not.toBe('error');
      if (want.kinds) expect(want.kinds, `${utterance}: ${env.kind} ${env.summary}`).toContain(env.kind);
      expect(env.summary.trim().length).toBeGreaterThan(0);
      expect(env.summary, 'dash').not.toMatch(DASH);
      expect(env.summary, 'exclamation').not.toMatch(/!/);
      expect(env.summary, 'internal code').not.toMatch(CODE);
      if (env.kind === 'needs_confirmation') {
        expect(env.confirmationId).toMatch(/^conf_/);
        const row = await db.chatActions.get(env.confirmationId!);
        expect(row?.status).toBe('pending');
      }
    } else {
      // a judgement call about someone says so, then offers what Orbit can do for them as tap-to-answer pills
      if (want.needsKey) expect(['', 'offer_choices'], utterance).toContain(t.tools.join(','));
      else expect(t.tools, utterance).toEqual([]);
      expect(t.text).not.toMatch(DASH);
      expect(t.text).not.toMatch(/!/);
      if (want.needsKey) {
        expect(t.text).toMatch(/needs a Claude key/);
        if (!t.tools.length) expect(t.env?.href).toBe('/settings/integrations');
      }
      if (want.href) expect(t.env?.href).toBe(want.href);
    }
  });

  it('the guards hold: an early "completed" waits for a yes and nothing risky ran without Approve', async () => {
    // Ethan's chat is booked for tomorrow: "move Ethan to completed" asked instead of moving
    const ethan = await db.chats.where('personId').equals('p4').first();
    expect(ethan?.stage).toBe('scheduled');
    // the approvals above were never given: Victor is not hidden, Daniel's draft is unsent, nothing was wiped
    expect((await db.people.get('p7'))?.hiddenAt).toBeUndefined();
    const daniel = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.personId === 'p1' && o.kind === 'bump')
      .first();
    expect(daniel?.status).toBe('draft');
    expect(await peopleCount()).toBeGreaterThan(50);
    expect((await db.settings.get(user.id))?.weeklyOutreachTarget).not.toBe(5);
  });

  it('every capability utterance gets a tool the registry accepts, or a plain answer; never a stale command', () => {
    const people = [] as never[];
    const counts = { tool: 0, text: 0, refuse: 0 };
    for (const c of CAPABILITIES)
      for (const u of c.utterances) {
        const r = routeUtterance(u, {
          registry,
          people,
          companies: ['Stripe', 'Figma', 'Ramp'],
          modeNote: 'Add your own key in Settings.',
          settingsHref: '/settings/integrations',
        });
        counts[r.kind]++;
        if (r.kind === 'tool') expect(registry.get(r.tool)!.input.safeParse(r.input).success).toBe(true);
        else expect(r.text, u).not.toMatch(/out of step/);
      }
    expect(counts.tool + counts.text + counts.refuse).toBe(CAPABILITIES.length * 3);
    // without any people to resolve names against, a good share still runs a tool directly
    expect(counts.tool).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (b) Claude mode through the scripted fake
// ---------------------------------------------------------------------------------------------------------------

describe('Claude mode: scripted model turns calling the real tools', () => {
  let fake: FakeAnthropic;

  beforeAll(async () => {
    await clearPrefs();
    user = await loadDemo({ reset: true, now: NOW });
    writePrefs({ anthropicApiKey: 'sk-ant-test' });
    fake = scriptedFetch();
    setChatClientFactoryForTests((key) => makeChatClient(key, { fetch: fake.fetch, maxRetries: 0 }));
    engine = createChatEngine({
      registry,
      execute,
      user: () => user,
      now: () => NOW,
      prefixMismatch: 'error',
    });
  }, 90_000);
  afterAll(async () => {
    setChatClientFactoryForTests(undefined);
    await clearPrefs();
  });

  let n = 0;
  const call = (name: string, input: Record<string, unknown>) => ({ id: `toolu_it_${++n}`, name, input });
  /** one student turn: the model calls `calls` (one round each), then answers `reply` */
  async function claude(
    text: string,
    rounds: ReturnType<typeof call>[][],
    reply: string,
    conversationId?: string,
  ) {
    fake.push(...rounds.map((toolCalls): ScriptTurn => ({ toolCalls })), { text: reply });
    const t = await say(text, conversationId);
    expect(fake.remaining(), 'every scripted turn was used').toBe(0);
    expect(t.events.at(-1)?.type, JSON.stringify(t.events.at(-1))).toBe('done');
    return t;
  }
  /** the tool_result the model got back for a call, as JSON */
  const resultSent = (toolUseId: string) => {
    for (const r of messageRequests(fake))
      for (const m of r.body.messages)
        if (Array.isArray(m.content))
          for (const b of m.content)
            if (b.type === 'tool_result' && b.tool_use_id === toolUseId)
              return JSON.parse(typeof b.content === 'string' ? b.content : b.content[0].text);
    return undefined;
  };

  it('is in Claude mode with every registry tool offered to the model', async () => {
    expect(engine.mode()).toBe('llm');
    await claude('hi', [], 'Hi Alex.');
    const offered = messageRequests(fake)[0]!.body.tools.map((t: { name: string }) => t.name);
    expect([...offered].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it("brief: the model reads today's brief and gets compact cards back", async () => {
    const c = call('get_today_brief', {});
    const t = await claude('what should I do today', [[c]], 'Start with the thank-you to Lena.');
    expect(t.tools).toEqual(['get_today_brief']);
    expect(t.env?.kind).toBe('brief');
    const sent = resultSent(c.id);
    expect(sent.kind).toBe('brief');
    expect(JSON.stringify(sent)).toContain('Lena Novak');
    expect(JSON.stringify(sent)).not.toContain('"forModel"');
  });

  it('look up a person: search, then the profile with facts and prep', async () => {
    const s = call('search_people', { query: 'Hannah' });
    const g = call('get_person', { personId: 'p2', include: ['facts', 'prep'] });
    const t = await claude('who is Hannah', [[s], [g]], 'Hannah Brooks is at Figma.');
    expect(t.tools).toEqual(['search_people', 'get_person']);
    expect(resultSent(s.id).data.people[0].id).toBe('p2');
    expect(t.env?.kind).toBe('person');
    // third-party text reaches the model wrapped, never bare
    expect(JSON.stringify(resultSent(g.id))).toMatch(/untrusted_/);
  });

  let draftId = '';
  let draftConversation = '';
  it('create a draft, then edit it in a second turn', async () => {
    // Daniel has not answered the first message: the follow-up card's draft is reopened, not written twice
    const c = call('create_draft', { personId: 'p1', kind: 'bump' });
    const t = await claude('follow up with Daniel', [[c]], 'Here is a follow-up to Daniel.');
    expect(t.env?.kind, t.env?.summary).toBe('draft');
    draftConversation = t.id;
    draftId = resultSent(c.id).data.id;
    const d = (await db.outbound.get(draftId))!;
    expect(d).toMatchObject({ personId: 'p1', kind: 'bump', status: 'draft' });
    const body = `Hi Daniel,\n\nI wanted to follow up on my note from last week about the Stripe payments team. If you have fifteen minutes in the next two weeks, I would be grateful for your advice.\n\nThanks,\nAlex`;
    const u = call('update_draft_body', { draftId, body });
    const t2 = await claude('make it say fifteen minutes', [[u]], 'Updated.', draftConversation);
    expect(t2.env?.kind).toBe('draft');
    expect((await db.outbound.get(draftId))!.bodyFinal).toBe(body);
  });

  it('send_draft needs confirmation; nothing is sent until Approve, then it is handed off or queued', async () => {
    const s = call('send_draft', { draftId });
    const t = await claude('send it', [[s]], 'Approve the card to send it.', draftConversation);
    expect(t.env?.kind).toBe('needs_confirmation');
    expect((await db.outbound.get(draftId))!.status).toBe('draft');
    // the model cannot approve for the student: a token it makes up is refused
    const forged = await execute(
      'send_draft',
      { draftId },
      {
        user,
        now: NOW,
        conversationId: draftConversation,
        nonce: 'x',
        wrap: (_l, s2) => s2,
        caller: 'llm',
        confirmation: 'conf_made_up',
      },
    );
    expect(forged.kind).toBe('error');
    expect((await db.outbound.get(draftId))!.status).toBe('draft');
    const env = await engine.approve(t.env!.confirmationId!);
    expect(env.kind, env.summary).toBe('draft');
    expect(['handed_off', 'queued']).toContain((await db.outbound.get(draftId))!.status);
    // the next model turn sees the decision line
    await claude('thanks', [], 'You are welcome.', draftConversation);
    const last = messageRequests(fake).at(-1)!.body.messages;
    expect(JSON.stringify(last)).toContain(`[Orbit] Approved ${t.env!.confirmationId}`);
  });

  it('add a note, and the facts it produced come back on the person', async () => {
    const before = await db.facts.where('personId').equals('p5').count();
    const a = call('add_note', {
      personId: 'p5',
      text: 'Coffee with Lena Novak today. She offered to refer me to the Ramp platform team and said to lead with my payments project.',
    });
    const g = call('get_person', { personId: 'p5', include: ['facts'] });
    const t = await claude(
      'add a note from my coffee with Lena',
      [[a], [g]],
      'Saved, and Orbit noted her offer.',
    );
    expect(t.tools).toEqual(['add_note', 'get_person']);
    expect(t.envs[0]!.kind).toBe('note');
    const facts = await db.facts.where('personId').equals('p5').toArray();
    expect(facts.length).toBeGreaterThan(before);
    expect(facts.some((f) => f.type === 'offer')).toBe(true);
    expect(JSON.stringify(resultSent(g.id))).toMatch(/refer/i);
  });

  it('move a stage with the guards: an early Completed waits for a yes, Scheduled asks for the time', async () => {
    const m1 = call('move_pipeline_stage', { personId: 'p4', stage: 'completed' });
    const t = await claude('mark Ethan as done', [[m1]], 'The chat is tomorrow; are you sure?');
    expect(resultSent(m1.id).data.outcome).toBe('meeting_ahead');
    expect((await db.chats.where('personId').equals('p4').first())!.stage).toBe('scheduled');
    const m2 = call('move_pipeline_stage', { personId: 'p4', stage: 'completed', confirmEarly: true });
    await claude('yes, we met early', [[m2]], 'Moved.', t.id);
    expect((await db.chats.where('personId').equals('p4').first())!.stage).toBe('completed');
    const m3 = call('move_pipeline_stage', { personId: 'p10', stage: 'scheduled' });
    await claude('Jonah booked a time', [[m3]], 'When is it?');
    expect(resultSent(m3.id).data.needsTime).toBe(true);
  });

  it('routes to a company, then an intro draft through the first hop', async () => {
    const r = call('find_routes', { company: 'Stripe' });
    const t = await claude('how do I get into Stripe', [[r]], 'Felix could introduce you.');
    expect(t.env?.kind).toBe('company');
    const via = resultSent(r.id).data.viaSomeoneYouKnow as {
      target: { id: string };
      route: { firstHopId: string };
    }[];
    expect(via.length).toBeGreaterThan(0);
    const hop = via[0]!;
    const d = call('create_draft', {
      personId: hop.route.firstHopId,
      kind: 'intro_request',
      targetPersonId: hop.target.id,
    });
    const t2 = await claude('ask them for the intro', [[d]], 'Here is the intro ask.', t.id);
    expect(t2.env?.kind, t2.env?.summary).toBe('draft');
    const made = (await db.outbound.get(resultSent(d.id).data.id))!;
    expect(made).toMatchObject({ personId: hop.route.firstHopId, kind: 'intro_request', status: 'draft' });
  });

  it('import LinkedIn connections only after Approve', async () => {
    const before = await peopleCount();
    const i = call('import_linkedin', {
      filename: 'Connections.csv',
      csvText:
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nTara,Nguyen,https://www.linkedin.com/in/tara-nguyen-it,,Brex,Associate Product Manager,01 Oct 2026\n',
    });
    const t = await claude('import these connections', [[i]], 'Approve the card to import.');
    expect(t.env?.kind).toBe('needs_confirmation');
    expect(await peopleCount()).toBe(before);
    const env = await engine.approve(t.env!.confirmationId!);
    expect(env.kind, env.summary).toBe('import');
    expect(await peopleCount()).toBe(before + 1);
  }, 30_000);

  it('change a setting', async () => {
    const u = call('update_settings', { section: 'style', tonePreset: 'formal' });
    const t = await claude('make my messages more formal', [[u]], 'Your tone is formal now.');
    expect(t.env?.kind).toBe('settings');
    expect((await db.settings.get(user.id))?.tonePreset).toBe('formal');
  });

  it('dismiss a card (after Approve) and restore it', async () => {
    const card = (await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending' && s.kind === 'nurture_checkin')
      .first())!;
    const dz = call('dismiss_suggestion', { suggestionId: card.id, reason: 'not_now' });
    const t = await claude('not now for that check-in', [[dz]], 'Approve to remove it.');
    expect(t.env?.kind).toBe('needs_confirmation');
    expect((await db.suggestions.get(card.id))!.status).toBe('pending');
    expect((await engine.approve(t.env!.confirmationId!)).kind).toBe('suggestion');
    expect((await db.suggestions.get(card.id))!.status).toBe('dismissed');
    const r = call('manage_suggestion', { suggestionId: card.id, action: 'restore' });
    await claude('actually bring it back', [[r]], 'It is back on Today.', t.id);
    expect((await db.suggestions.get(card.id))!.status).toBe('pending');
  });

  it('delete everything asks first, and Cancel leaves every row in place', async () => {
    const people = await peopleCount();
    const outbound = await db.outbound.count();
    const del = call('delete_all_data', {});
    const t = await claude('delete all my data', [[del]], 'Approve the card to delete everything.');
    expect(t.env?.kind).toBe('needs_confirmation');
    await engine.cancel(t.env!.confirmationId!);
    expect((await db.chatActions.get(t.env!.confirmationId!))?.status).toBe('cancelled');
    expect((await engine.approve(t.env!.confirmationId!)).kind).toBe('error');
    expect(await peopleCount()).toBe(people);
    expect(await db.outbound.count()).toBe(outbound);
    expect(await db.users.get(user.id)).toBeTruthy();
  });

  it('every tool_use the model made is answered in the stored history', async () => {
    for (const c of await engine.listConversations()) {
      const { messages } = await engine.loadConversation(c.id);
      const uses = messages.flatMap((m) =>
        m.role === 'assistant' && Array.isArray(m.content)
          ? (m.content as { type: string; id?: string }[])
              .filter((b) => b.type === 'tool_use')
              .map((b) => b.id!)
          : [],
      );
      const answered = new Set(
        messages.flatMap((m) =>
          m.role === 'user' && Array.isArray(m.content)
            ? (m.content as { type: string; tool_use_id?: string }[])
                .filter((b) => b.type === 'tool_result')
                .map((b) => b.tool_use_id!)
            : [],
        ),
      );
      for (const id of uses) expect(answered.has(id), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (c) coverage
// ---------------------------------------------------------------------------------------------------------------

describe('coverage', () => {
  it("every one of the 208 capabilities (184, the networking agent's 22, autopilot and small talk) is claimed by a tool", () => {
    expect(CAPABILITIES).toHaveLength(208);
    const claimed = new Set(tools.flatMap((t) => t.capabilities));
    expect(CAPABILITIES.filter((c) => !claimed.has(c.id)).map((c) => c.id)).toEqual([]);
  });

  it('every tool is reachable: offered to the model, or run by the UI (chips, attachments, Approve)', () => {
    const offered = new Set(
      buildRunnerTools(registry, { onRun: async () => ({ kind: 'text', data: {}, summary: '' }) }).map(
        (t) => t.name,
      ),
    );
    const ui = new Set<string>([
      ...CHIPS.map((c) => c.tool),
      'create_draft',
      'find_routes',
      'get_person',
      ...Object.values(ATTACH_TOOL),
      // a draft card's Approve asks send_draft, then runs it with the token
      'send_draft',
    ]);
    const unreachable = tools.map((t) => t.name).filter((n) => !offered.has(n) && !ui.has(n));
    expect(unreachable).toEqual([]);
    // the model is offered every tool: no tool's input needs a File the model could not give
    expect([...offered].sort()).toEqual(tools.map((t) => t.name).sort());
    // the request the API accepts: at most twenty strict tools, and no schema keyword strict mode rejects
    const built = buildRunnerTools(registry, {
      onRun: async () => ({ kind: 'text', data: {}, summary: '' }),
    }) as unknown as {
      strict?: boolean;
      input_schema: unknown;
    }[];
    expect(built.filter((t) => t.strict).length).toBeLessThanOrEqual(20);
    for (const t of built.filter((x) => x.strict))
      expect(JSON.stringify(t.input_schema)).not.toMatch(
        /"(minimum|maximum|minLength|maxLength|multipleOf|\$schema)"/,
      );
    for (const n of ui) expect(registry.has(n), n).toBe(true);
  });
});
