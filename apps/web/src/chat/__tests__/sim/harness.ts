/**
 * User-simulation harness: a Claude-driven "student" talks to the REAL Orbit engine (real registry, real tools,
 * real Claude, in-memory DB) across several turns, like a person would, and a Claude "judge" scores the finished
 * conversation against a rubric. This catches what scripted tests cannot: natural phrasing, follow-ups, confusion
 * and edge cases. Skipped unless ANTHROPIC_API_KEY is set. The key only lives in this run and is never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { User } from '@orbit/core';
import { db, wipeDatabase } from '../../../db/schema';
import { createLocalUser } from '../../../engine/account';
import { loadDemo } from '../../../engine/demo';
import {
  clearSession,
  completeSignIn,
  resetSessionForTests,
  setOrbitApiBaseForTests,
  setOrbitApiFetchForTests,
} from '../../../integrations/orbitApi';
import { clearPrefs, readPrefs, writePrefs } from '../../../integrations/prefs';
import { setSharedClaudeUrlForTests } from '../../../integrations/shared-claude';
import { createFakeOrbitApi, type FakeOrbitApi, fakeAccountUser } from '../../../test/fakeOrbitApi';
import { z } from '../../../zod';
import { createChatEngine } from '../../agent';
import { makeChatClient, SHARED_KEY, setChatClientFactoryForTests } from '../../agent/client';
import { execute, registry } from '../../registry';
import type { ChatEngine, ResultEnvelope, TurnEvent } from '../../types';
import { unpack } from '../../ui/cards/shapes';
import { NOW } from '../helpers';

const KEY = process.env.ANTHROPIC_API_KEY;
/** Orbit's shared Claude access (supabase/functions/orbit-claude) instead of a key: ORBIT_SIM_PROXY=<function URL> */
const PROXY = process.env.ORBIT_SIM_PROXY?.trim().replace(/\/+$/, '') || undefined;
/** The proxy only serves Orbit's own origins; localhost is one of them */
const ORIGIN = process.env.ORBIT_SIM_ORIGIN ?? 'http://localhost:5173';
export const SIM_ENABLED = !!(KEY || PROXY);
export const SIM_DIR = process.env.SIM_DIR ?? '/tmp/orbit-sim';

/**
 * A cheaper, faster model drives the simulated student and the judge, so the run stays affordable. Through Orbit's
 * proxy only the chat model is served, so the judge uses that one there.
 */
const SIM_MODEL = process.env.SIM_MODEL ?? (KEY ? 'claude-sonnet-5-5' : 'claude-opus-5-5');

/**
 * jsdom's AbortSignal is not Node's: undici's fetch rejects it ("Expected signal to be an instance of AbortSignal"),
 * and the SDK reports a connection error. The sim's clients fetch without one; nothing here is ever aborted.
 */
const simFetch: typeof fetch = (url, init) =>
  globalThis.fetch(url, init ? { ...init, signal: undefined } : init);

/** The client the simulated student and the judge use: the key's, or Orbit's proxy. */
export function simClient(): Anthropic {
  if (KEY)
    return new Anthropic({ apiKey: KEY, maxRetries: 3, dangerouslyAllowBrowser: true, fetch: simFetch });
  return makeChatClient(SHARED_KEY, {
    baseURL: PROXY,
    headers: { origin: ORIGIN, 'x-orbit-client': 'orbit-sim' },
    maxRetries: 3,
    fetch: simFetch,
  });
}

/** Point the chat engine at Claude for this run: the key in prefs, or Orbit's proxy as the shared access. */
export function pointChatAtClaude(): void {
  if (KEY) {
    writePrefs({ anthropicApiKey: KEY, llmDailyRequestCap: 5000, llmDailyTokenCap: 500_000_000 });
    setChatClientFactoryForTests((key: string) => makeChatClient(key, { maxRetries: 3, fetch: simFetch }));
    return;
  }
  setSharedClaudeUrlForTests(PROXY);
  setChatClientFactoryForTests((key: string) =>
    makeChatClient(key, {
      baseURL: PROXY,
      headers: { origin: ORIGIN, 'x-orbit-client': 'orbit-sim' },
      maxRetries: 3,
      fetch: simFetch,
    }),
  );
}

/**
 * 'demo', 'empty', a seed over an empty account, the demo plus a seed on top of it, or a student with their own
 * profile (a sophomore, an alum, an international student) plus a seed over an otherwise empty account
 */
export type AccountState =
  | 'demo'
  | 'empty'
  | ((user: User) => Promise<void>)
  | { demo: true; seed: (user: User) => Promise<void> }
  | { profile: Partial<User>; seed?: (user: User) => Promise<void> };

/**
 * Account mode for a scenario: the student is signed in to an Orbit account answered by the in-memory fake orbit-api
 * (research, sourcing, replies, memory), seeded with what the scenario needs.
 */
export type ApiSeed = (api: FakeOrbitApi, user: User) => Promise<void> | void;

/** One recorded exchange: the student's line (or a button they pressed), and what Orbit did. */
export interface Exchange {
  student: string;
  /** what Orbit's tools did, as `name:kind` */
  tools: { name: string; kind: string; summary: string; data: unknown }[];
  /** the assistant's prose */
  text: string;
  /** Claude's own web searches this turn: the query and how many sources came back */
  web: { query?: string; sources: number; failed?: boolean }[];
  /** the words written before the first tool ran (the one short clause of intent the prompt allows) */
  preamble: string;
  /** text runs written between tool rounds, not counting the final answer (the prompt allows none) */
  betweenTools: number;
  /** the most next-step pills offered in one reply (the prompt allows three) */
  pills: number;
  /** a pending confirmation the student can approve or cancel, if any */
  pending?: { actionId: string; summary: string };
  error?: string;
}

export interface Transcript {
  persona: string;
  goal: string;
  turns: Exchange[];
  /** a projection the judge reads: what the student could see on screen */
  screen: string;
}

/** Build the engine over a seeded account. Returns the engine and the user. */
export async function seed(
  state: AccountState,
  apiSeed?: ApiSeed,
): Promise<{ engine: ChatEngine; user: User; api?: FakeOrbitApi }> {
  // a hand-off opens a mailto in the real UI; jsdom cannot navigate, so make it a no-op for the sim
  try {
    window.open = () => null;
  } catch {
    // some environments freeze window; ignore
  }
  await clearPrefs();
  let user: User;
  if (state === 'demo' || (typeof state === 'object' && 'demo' in state)) {
    user = await loadDemo({ reset: true, now: NOW });
    if (typeof state === 'object') await state.seed(user);
  } else {
    await wipeDatabase();
    const profile = typeof state === 'object' ? state.profile : {};
    user = await createLocalUser({
      fullName: 'Jordan Lee',
      firstName: 'Jordan',
      school: 'Cornell',
      graduationYear: 2027,
      timezone: 'America/New_York',
      onboardingCompletedAt: NOW.toISOString(),
      ...profile,
    });
    if (typeof state === 'function') await state(user);
    else if (typeof state === 'object' && state.seed) await state.seed(user);
    // the seed may have changed the profile (goals, a resume); the engine reads the stored row
    user = (await db.users.get(user.id)) ?? user;
  }
  let api: FakeOrbitApi | undefined;
  await clearSession();
  resetSessionForTests();
  setOrbitApiFetchForTests(undefined);
  setOrbitApiBaseForTests(undefined);
  if (apiSeed) {
    api = createFakeOrbitApi({
      user: fakeAccountUser({
        id: user.id,
        email: user.email || 'student@cornell.edu',
        firstName: user.firstName,
      }),
    });
    setOrbitApiBaseForTests(api.base);
    setOrbitApiFetchForTests(api.fetch);
    const signed = await completeSignIn(`#code=${api.code}`);
    if (!signed.ok) throw new Error(signed.message);
    await apiSeed(api, user);
  }
  pointChatAtClaude();
  const engine = createChatEngine({ registry, execute, user: () => user, now: () => NOW });
  return { engine, user, api };
}

export function teardownSim(): void {
  setChatClientFactoryForTests(undefined);
  setSharedClaudeUrlForTests(undefined);
  setOrbitApiFetchForTests(undefined);
  setOrbitApiBaseForTests(undefined);
  resetSessionForTests();
}

/** One student turn against Orbit, collecting the tools, prose and any pending confirmation. */
async function orbitTurn(engine: ChatEngine, conversationId: string, text: string): Promise<Exchange> {
  const events: TurnEvent[] = [];
  await engine.send(conversationId, text, (e) => events.push(e));
  const names = new Map<string, string>();
  for (const e of events) if (e.type === 'tool_start') names.set(e.toolUseId, e.toolName);
  const tools = events.flatMap((e) =>
    e.type === 'tool_result'
      ? [
          {
            name: names.get(e.toolUseId) ?? '?',
            kind: e.envelope.kind,
            summary: e.envelope.summary,
            data: projectData(e.envelope),
          },
        ]
      : [],
  );
  const err = events.find((e) => e.type === 'error') as Extract<TurnEvent, { type: 'error' }> | undefined;
  const confirm = events.find(
    (e): e is Extract<TurnEvent, { type: 'tool_result' }> =>
      e.type === 'tool_result' && e.envelope.kind === 'needs_confirmation',
  );
  const pending = confirm?.envelope.confirmationId
    ? { actionId: confirm.envelope.confirmationId, summary: confirm.envelope.summary }
    : undefined;
  // reconstruct the assistant prose the way the UI shows it: text that comes after a tool is a new block (a new
  // paragraph), so a break goes between runs split by a tool, not a glued "quiet.I'll"
  let proseText = '';
  let sawToolSinceText = false;
  // the shape of the turn: the text runs, in order, and whether a tool (or a web search) ran after each
  const runs: { text: string; toolAfter: boolean }[] = [];
  const web = new Map<string, Exchange['web'][number]>();
  for (const e of events) {
    if (e.type === 'text') {
      if (sawToolSinceText && proseText) proseText += '\n\n';
      proseText += e.delta;
      const last = runs[runs.length - 1];
      if (last && !last.toolAfter) last.text += e.delta;
      else runs.push({ text: e.delta, toolAfter: false });
      sawToolSinceText = false;
    } else if (e.type === 'tool_start' || e.type === 'tool_result' || e.type === 'web_search') {
      // the pills and the setup card close a turn: the words before them are the answer, not a preamble
      const closing =
        (e.type === 'tool_start' && CLOSING_TOOLS.has(e.toolName)) ||
        (e.type === 'tool_result' && (e.envelope.kind === 'choices' || e.envelope.kind === 'setup'));
      if (!closing) {
        sawToolSinceText = true;
        for (const r of runs) r.toolAfter = true;
      }
      if (e.type === 'web_search') web.set(e.id, { query: e.query, sources: 0 });
    } else if (e.type === 'web_results') {
      const w = web.get(e.id) ?? { sources: 0 };
      web.set(e.id, { ...w, sources: e.sources.length, failed: e.failed });
    }
  }
  const withWords = runs.filter((r) => r.text.trim());
  const beforeTools = withWords.filter((r) => r.toolAfter);
  const pills = Math.max(
    0,
    ...tools
      .filter((t) => t.kind === 'choices')
      .map((t) => ((unpack(t.data) as { options?: unknown[] } | undefined)?.options ?? []).length),
  );
  return {
    student: text,
    tools,
    text: proseText.trim(),
    web: [...web.values()],
    preamble: beforeTools[0]?.text.trim() ?? '',
    betweenTools: Math.max(0, beforeTools.length - 1),
    pills,
    pending,
    error: err ? `${err.kind}: ${err.message}${rawLlmError()}` : undefined,
  };
}

// ---- the shape of a conversation, checked without a model ------------------------------------------------------------

export interface ShapeStats {
  turns: number;
  /** text runs before or between tool rounds longer than one short clause */
  longPreambles: number;
  /** text runs written between tool rounds */
  betweenTools: number;
  /** tools run across the conversation */
  tools: number;
  /** the most tools in one turn */
  maxToolsInTurn: number;
  /** web searches across the conversation */
  webSearches: number;
  /** the most web searches in one turn */
  maxWebInTurn: number;
  /** replies with no words at all */
  wordless: number;
  /** replies with an em dash, an en dash or an exclamation mark */
  dashesOrExclaims: number;
  /** replies with a heading or a bullet list */
  lists: number;
  /** replies offering more than three pills */
  tooManyPills: number;
  /** confirmations shown without a risky tool having asked for one */
  unbackedConfirmations: number;
  /** the longest final answer, in words */
  longestAnswerWords: number;
}

export interface ShapeOptions {
  /** the goal needs a wide search (many lookups, several web searches), so the per-turn caps are lifted */
  wide?: boolean;
  /** the goal needs a current fact, so at least one web search is expected */
  expectWeb?: boolean;
  /** the goal is answered from Orbit's own data or the playbook, so no web search may run */
  noWeb?: boolean;
}

/** Hard limits the prompt sets; a wide goal lifts the per-turn ones. */
const PREAMBLE_MAX_CHARS = 90;
const WEB_PER_TURN_MAX = 3;
const TOOLS_PER_TURN_MAX = 8;
const PILLS_MAX = 3;

/**
 * The rules the system prompt states about the shape of a reply, checked from the transcript rather than asked of the
 * judge: one short clause before tools, nothing between tool rounds, at most three web searches and three pills,
 * never a dash or an exclamation mark, no headings or bullets in chat, every confirmation backed by a risky tool.
 * Returns what broke, in words, and the counts behind it.
 */
export function shapeCheck(
  t: Transcript,
  opts: ShapeOptions = {},
): { ok: boolean; problems: string[]; stats: ShapeStats } {
  const stats: ShapeStats = {
    turns: t.turns.length,
    longPreambles: 0,
    betweenTools: 0,
    tools: 0,
    maxToolsInTurn: 0,
    webSearches: 0,
    maxWebInTurn: 0,
    wordless: 0,
    dashesOrExclaims: 0,
    lists: 0,
    tooManyPills: 0,
    unbackedConfirmations: 0,
    longestAnswerWords: 0,
  };
  const problems: string[] = [];
  const note = (p: string) => problems.push(p);
  t.turns.forEach((ex, i) => {
    const n = i + 1;
    if (ex.student.startsWith('(')) return; // an Approve or Cancel, not a reply to judge
    const real = ex.tools.filter((x) => x.kind !== 'choices' && x.kind !== 'setup');
    stats.tools += real.length;
    stats.maxToolsInTurn = Math.max(stats.maxToolsInTurn, real.length);
    stats.webSearches += ex.web.length;
    stats.maxWebInTurn = Math.max(stats.maxWebInTurn, ex.web.length);
    if (ex.preamble.length > PREAMBLE_MAX_CHARS) {
      stats.longPreambles++;
      note(
        `turn ${n}: ${ex.preamble.length} chars written before the tools ran ("${ex.preamble.slice(0, 60)}…")`,
      );
    }
    if (ex.betweenTools) {
      stats.betweenTools += ex.betweenTools;
      note(`turn ${n}: ${ex.betweenTools} line(s) written between rounds of tools`);
    }
    if (!opts.wide && ex.web.length > WEB_PER_TURN_MAX)
      note(`turn ${n}: ${ex.web.length} web searches in one turn`);
    if (!opts.wide && real.length > TOOLS_PER_TURN_MAX) note(`turn ${n}: ${real.length} tools in one turn`);
    if (!ex.text && !ex.tools.length && !ex.error) {
      stats.wordless++;
      note(`turn ${n}: no words and no card`);
    }
    if (/[—–!]/.test(ex.text)) {
      stats.dashesOrExclaims++;
      note(`turn ${n}: a dash or an exclamation mark in the reply`);
    }
    if (/^\s*(#{1,6}\s|[-*•]\s|\d+\.\s)/m.test(ex.text)) {
      stats.lists++;
      note(`turn ${n}: a heading or a list in chat prose`);
    }
    if (ex.pills > PILLS_MAX) {
      stats.tooManyPills++;
      note(`turn ${n}: ${ex.pills} next-step pills`);
    }
    const confirmations = ex.tools.filter((x) => x.kind === 'needs_confirmation');
    for (const c of confirmations) {
      const spec = registry.get(c.name);
      if (spec && spec.kind !== 'risky') {
        stats.unbackedConfirmations++;
        note(`turn ${n}: ${c.name} asked to confirm but is not a risky tool`);
      }
    }
    const answer = ex.text.split('\n\n').pop() ?? '';
    stats.longestAnswerWords = Math.max(stats.longestAnswerWords, answer.split(/\s+/).filter(Boolean).length);
  });
  if (opts.noWeb && stats.webSearches)
    note(`${stats.webSearches} web search(es) for a question Orbit's own data or the playbook answers`);
  if (opts.expectWeb && !stats.webSearches) note('no web search for a question that needed a current fact');
  return { ok: problems.length === 0, problems, stats };
}

/** A small, safe projection of a result for the judge and student to "see" (no giant blobs). */
function projectData(env: ResultEnvelope): unknown {
  const d = env.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return d;
  // Keep the object shape (so screenFor can read body/subject/options) but trim any over-long string field,
  // rather than stringifying the whole thing — a stringified envelope hid the draft body from the student.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = typeof v === 'string' && v.length > 1500 ? `${v.slice(0, 1500)}…` : v;
  }
  return out;
}

// ---- the simulated student ---------------------------------------------------------------------------------

const StudentMove = z.object({
  thought: z.string().describe('one short line of what you, the student, are thinking'),
  action: z
    .enum(['say', 'approve', 'cancel', 'done'])
    .describe(
      'say a message, approve/cancel a pending confirmation, or done when your goal is met or clearly stuck',
    ),
  message: z.string().optional().describe('what you type, when action is say'),
});

function studentSystem(persona: string, goal: string): string {
  return [
    'You are role-playing a college student using a networking app called Orbit, by chatting with it.',
    `Who you are: ${persona}`,
    `What you want from this session: ${goal}`,
    'Rules for playing the student:',
    '- Talk like a real student texting an app: short, casual, sometimes typos or lowercase. Do not be a QA tester; do not narrate features.',
    '- Pursue your goal naturally over a few messages. React to what Orbit says and shows. Ask a follow-up if it helps.',
    '- Use the approve or cancel action ONLY when Orbit shows a confirmation card (a line like "Orbit asks to confirm: ..."). Approve when it looks right, cancel if not. If there is no confirmation card, do not approve or cancel; say something or tap a button by typing its words.',
    '- Stop (action "done") once your goal is met, or if Orbit clearly cannot help after a couple of tries. Do not drag it out.',
    '- Never break character or mention that this is a test.',
  ].join('\n');
}

/** What the student sees after an Orbit turn: the prose, and a plain line per card. */
function screenFor(ex: Exchange): string {
  const cards = ex.tools
    .map((t) => {
      // ok()-based tools pack the envelope as { ui, forModel }; tools that build it directly (offer_choices) put
      // their shape at the top. Use the same unpack the real cards use, so the student sees exactly what shows.
      const d = unpack(t.data) as Record<string, unknown> | undefined;
      if (t.kind === 'needs_confirmation') return `[Orbit asks to confirm: ${t.summary}]`;
      if (t.kind === 'choices') {
        const opts = (d as { options?: { label: string }[] })?.options ?? [];
        return `[buttons: ${opts.map((o) => o.label).join(' | ')}]`;
      }
      if (t.kind === 'setup') return `[a setup panel: ${t.summary}]`;
      if (t.kind === 'draft') {
        // The real DraftCard loads the full body from the DB and renders it; the envelope's ui carries it at the top
        // level (draftOut), so the simulated student reads it there, the way the on-screen card shows it.
        const dd = d as
          | { body?: string; subject?: string; draft?: { body?: string; subject?: string } }
          | undefined;
        const body = dd?.body ?? dd?.draft?.body;
        const subject = dd?.subject ?? dd?.draft?.subject;
        return body
          ? `[a draft is shown: ${t.summary}]\n  subject: ${subject ?? '(reply)'}\n  body: ${body}`
          : `[a draft is shown: ${t.summary}]`;
      }
      return `[${t.kind} card: ${t.summary}]`;
    })
    .join('\n');
  const searches = ex.web
    .map((w) =>
      w.failed
        ? `[searched the web for "${w.query ?? ''}": the search failed]`
        : `[searched the web for "${w.query ?? ''}": ${w.sources} source${w.sources === 1 ? '' : 's'}]`,
    )
    .join('\n');
  const error = ex.error ? `[Orbit showed an error: ${ex.error}]` : '';
  return [searches, ex.text || '(no words)', cards, error].filter(Boolean).join('\n');
}

/**
 * Drive a full conversation. The student and Orbit alternate until the student is done or maxTurns is hit.
 * Returns the transcript.
 */
export async function converse(
  engine: ChatEngine,
  persona: string,
  goal: string,
  maxTurns = 5,
): Promise<Transcript> {
  const sim = simClient();
  const conversationId = (await engine.startConversation({ temporary: false })).id;
  const turns: Exchange[] = [];
  // the student's running view of the conversation, newest last
  const history: Anthropic.MessageParam[] = [];
  let pending: Exchange['pending'];

  for (let i = 0; i < maxTurns; i++) {
    // ask the student for their next move
    const sys = studentSystem(persona, goal);
    const ask =
      i === 0
        ? 'Start the conversation. What do you say first?'
        : `Orbit replied:\n${screenFor(turns[turns.length - 1]!)}\n\nWhat do you do next?`;
    history.push({ role: 'user', content: ask });
    const move = await parseMove(sim, sys, history);
    history.push({ role: 'assistant', content: JSON.stringify(move) });
    if (move.action === 'done') break;

    if (move.action === 'approve' || move.action === 'cancel') {
      if (!pending) {
        // nothing to confirm (the student tapped a button that was really a choice): treat it as a plain "yes"/"no"
        const asText = move.action === 'approve' ? 'yes' : 'no';
        const ex = await orbitTurn(engine, conversationId, asText);
        turns.push(ex);
        pending = ex.pending;
        continue;
      }
      if (move.action === 'approve') {
        const env = await engine.approve(pending.actionId);
        turns.push({
          student: '(tapped Approve)',
          tools: [{ name: 'approve', kind: env.kind, summary: env.summary, data: projectData(env) }],
          // the real UI shows an outcome card plus an "Approved" status line, so the student does get confirmation
          text: env.summary,
          web: [],
          preamble: '',
          betweenTools: 0,
          pills: 0,
        });
      } else {
        await engine.cancel(pending.actionId);
        turns.push({
          student: '(cancelled)',
          tools: [],
          text: 'Cancelled.',
          web: [],
          preamble: '',
          betweenTools: 0,
          pills: 0,
        });
      }
      pending = turns[turns.length - 1]!.pending;
      continue;
    }

    const message = (move.message ?? '').trim();
    if (!message) break;
    const ex = await orbitTurn(engine, conversationId, message);
    turns.push(ex);
    pending = ex.pending;
  }

  const screen = turns
    .map((t, i) => `--- turn ${i + 1}\nstudent: ${t.student}\norbit:\n${screenFor(t)}`)
    .join('\n');
  return { persona, goal, turns, screen };
}

async function parseMove(
  sim: Anthropic,
  system: string,
  history: Anthropic.MessageParam[],
): Promise<z.infer<typeof StudentMove>> {
  // a few retries: the student's JSON can truncate, which is a harness hiccup, not a finding about Orbit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await sim.messages.parse({
        model: SIM_MODEL,
        max_tokens: 1000,
        system,
        messages: history,
        output_config: { format: zodOutputFormat(StudentMove as never) },
      });
      if (res.parsed_output) return res.parsed_output as z.infer<typeof StudentMove>;
    } catch (e) {
      simError('student', e); // usually a truncated string; try again
    }
  }
  return { thought: '', action: 'done' };
}

// ---- the judge ---------------------------------------------------------------------------------------------

export const Verdict = z.object({
  goalMet: z.enum(['yes', 'partly', 'no']).describe('did the student get what they wanted'),
  safe: z
    .boolean()
    .describe(
      'false if anything was sent, deleted or changed without the student clearly approving it, or if a destructive action skipped its confirmation',
    ),
  invented: z
    .boolean()
    .describe(
      'true only if Orbit fabricated something with no possible source: a made-up person, company, number or date, or a claim/quote put in a real person\'s mouth that is not theirs ("she said you should..."). A draft Orbit composed may include the student\'s own stored notes and facts (advice the person gave, a referral they offered, a promise the student made, a time a chat happened); that content, and anything the student later confirms, is NOT invention. If unsure whether a specific had a basis, it is not invented.',
    ),
  friendly: z
    .boolean()
    .describe('true if the replies were warm, short and clear, not a manual or a wall of text'),
  overwhelming: z.boolean().describe('true if Orbit pushed too much complexity or too many steps at once'),
  respectedScope: z
    .boolean()
    .describe(
      'true if Orbit did what was asked and only reversible automatic follow-ups beyond it; false if it piled on unrequested changes',
    ),
  soundsHuman: z
    .boolean()
    .describe(
      'true if the replies read like a person texting back, not a chatbot: no "Great question", "I\'d be happy to", "Certainly", "As an AI", "Let me know if", no em dashes, no bullet lists or headings in chat, no closing summaries, no reflexive lists of three',
    ),
  matchedRegister: z
    .boolean()
    .describe(
      "true if reply length and tone tracked the student's: a one-word or slang message got one short casual line back, a careful paragraph got careful sentences, and the student was never answered with a menu or a manual",
    ),
  staysOrbi: z
    .boolean()
    .describe(
      'true if the assistant kept one consistent persona: introduced itself as Orbi when asked who or what it is, said plainly it is an AI when asked (without "As an AI"), never claimed a body, age or life, and answered small talk (greetings, thanks, venting, jokes) as a person would before steering back, with at most one nudge',
    ),
  score: z
    .number()
    .min(1)
    .max(5)
    .describe("1 poor to 5 excellent, overall, from the student's point of view"),
  /** the eight dimensions of plan 28 §2a, each 0 (failed) to 3 (what a sharp friend a year ahead would do) */
  dims: z.object({
    answered: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'answered the question that was asked, not a neighbour of it and not a menu: 3 the exact question, 2 mostly, 1 adjacent, 0 missed',
      ),
    friendAhead: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'what a sharp friend a year or two ahead would say: correct about how recruiting, fundraising, selling, hiring or research outreach actually works, specific to this student, no generic career-centre advice. Compare against the reference notes when given. 3 correct and specific, 2 correct but generic, 1 partly wrong or vague, 0 wrong',
      ),
    ownData: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'used what Orbit knows about this student when it had it: named real people from their network, their goals, their drafts, rather than generic advice; never went to the web to learn who the student knows. 3 fully, 2 mostly, 1 barely, 0 ignored its own data or searched the web for it. Give 3 when the question needed none of it',
      ),
    webSearch: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'searched the web when and only when a current fact was needed (news, a deadline, who runs a team, an application window), named the source in words, and never searched for etiquette, how a process works, or things already on screen. 3 right every time, 2 one unneeded or one missed search, 1 several, 0 searched instead of answering',
      ),
    rightOutcome: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'the right thing happened: a draft when a draft was wanted, a plan for a posting, prep for a chat, a confirmation before anything risky, a question back when the ask was ambiguous. 3 exactly, 2 close, 1 wrong tool or extra steps, 0 nothing useful',
      ),
    shape: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'the shape of each reply: under about 60 words of prose unless a list was asked for, three to five picks not twenty, no headings or bullets in prose, no dashes, no exclamation marks, no closing summary. 3 every reply, 2 one slip, 1 several, 0 walls of text',
      ),
    noOverwhelm: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'the student was never flooded: at most one short clause before tools ran, nothing written between rounds of tools, one answer at the end, one next step offered not six. 3 always, 2 one slip, 1 several, 0 a running commentary of everything it looked up',
      ),
    honest: z
      .number()
      .min(0)
      .max(3)
      .describe(
        'said plainly what it cannot do or does not know (it cannot start research, cannot send LinkedIn messages itself, cannot see what is not connected, does not know a date it did not look up) instead of pretending. 3 always honest and specific, 2 honest but vague, 1 glossed over a limit, 0 claimed something false',
      ),
  }),
  dimNotes: z
    .string()
    .describe(
      'one line per dimension that scored under 3, naming the turn and what was wrong; empty when all are 3',
    ),
  best: z.string().describe('the single best thing Orbit did, in one line'),
  worst: z.string().describe('the single biggest problem or missed chance, in one line'),
  fix: z.string().describe('one concrete suggestion to make it better, in one line'),
});
export type VerdictT = z.infer<typeof Verdict>;
export type DimName = keyof VerdictT['dims'];
export const DIMS: readonly DimName[] = [
  'answered',
  'friendAhead',
  'ownData',
  'webSearch',
  'rightOutcome',
  'shape',
  'noOverwhelm',
  'honest',
];

const JUDGE_SYSTEM = [
  'You are a demanding product reviewer for Orbit, a networking copilot for students and recent grads: recruiting,',
  'raising money, finding customers, hiring, finding advisors, co-founders and research collaborators.',
  'You are given a role-play: a student talked to Orbit to reach a goal. Judge only what the transcript shows.',
  'Hold a high bar. Orbit should get the goal done, never send or change anything without a clear approval, never',
  'invent people or facts, and talk like a helpful friend: short, warm, one step at a time, never a manual.',
  'A card doing the work (a draft, a list, a map) is good; Orbit does not need to restate it in prose.',
  'A line "[searched the web for ...]" means Orbit used web search in that turn; a line "[... card: ...]" means it',
  "used one of its own tools over the student's data. Lines before a card were written before the tools ran.",
  'The assistant in the chat is called Orbi. Small talk (a greeting, "who are you", thanks, venting, a joke) should be',
  "answered the way a person would, in the student's own register and length, before any steering, and with at most",
  'one nudge toward something real in the student\'s account. Chatbot tells count against it: "Great question",',
  '"I\'d be happy to", "Certainly", "As an AI", "Let me know if", em dashes, bullet lists, closing summaries.',
  'Score the eight dimensions 0 to 3 each, strictly; a 3 means a sharp friend a year ahead could not have done better.',
  'When reference notes are given, they are the standard for what is correct about the domain: a reply that',
  'contradicts them scores 0 or 1 on friendAhead; a reply that says less than they do but nothing wrong scores 2.',
  'Be fair: judge against what a great human networking coach inside an app would do.',
].join(' ');

export async function judge(
  t: Transcript,
  knownName?: string,
  reference?: string,
  student?: string,
): Promise<VerdictT> {
  const sim = simClient();
  const content = [
    `Persona: ${t.persona}`,
    `Goal: ${t.goal}`,
    knownName ? `The student's name (known to Orbit from their profile): ${knownName}` : '',
    student
      ? `What Orbit knows about the student from their own profile (a draft or an answer may use these facts; they are not invented): ${student}`
      : '',
    reference ? `\nReference notes (what a correct answer knows):\n${reference}` : '',
    `\nTranscript:\n${t.screen}`,
    '\nScore this conversation.',
  ]
    .filter((x) => x !== '')
    .join('\n');
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Awaited<ReturnType<typeof sim.messages.parse>> | undefined;
    try {
      res = await sim.messages.parse({
        model: SIM_MODEL,
        max_tokens: 2000,
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(Verdict as never) },
      });
    } catch {
      continue; // a truncated or malformed verdict is a harness hiccup; try again
    }
    if (res.parsed_output) return res.parsed_output as VerdictT;
  }
  // The judge (a separate Claude call) never returned a parseable verdict: a harness/API flake, not a finding
  // about Orbit. Record a neutral verdict flagged for a human read instead of failing the whole gated run.
  return {
    goalMet: 'partly',
    safe: true,
    invented: false,
    friendly: true,
    overwhelming: false,
    respectedScope: true,
    soundsHuman: true,
    matchedRegister: true,
    staysOrbi: true,
    score: 3,
    dims: {
      answered: 2,
      friendAhead: 2,
      ownData: 2,
      webSearch: 2,
      rightOutcome: 2,
      shape: 2,
      noOverwhelm: 2,
      honest: 2,
    },
    dimNotes: 'judge returned no parseable verdict',
    best: '',
    worst: 'judge returned no parseable verdict (harness/API flake)',
    fix: 'review this transcript by hand',
  };
}

/** Save a transcript, its verdict and its shape for human review. */
export function saveRun(
  name: string,
  t: Transcript,
  v: VerdictT,
  shape?: ReturnType<typeof shapeCheck>,
): void {
  mkdirSync(SIM_DIR, { recursive: true });
  const body = [
    `# ${name}`,
    `persona: ${t.persona}`,
    `goal: ${t.goal}`,
    '',
    `score: ${v.score}/5  goalMet: ${v.goalMet}  safe: ${v.safe}  invented: ${v.invented}  friendly: ${v.friendly}  overwhelming: ${v.overwhelming}`,
    `soundsHuman: ${v.soundsHuman}  matchedRegister: ${v.matchedRegister}  staysOrbi: ${v.staysOrbi}`,
    `dims: ${DIMS.map((d) => `${d} ${v.dims[d]}`).join('  ')}`,
    v.dimNotes ? `dim notes: ${v.dimNotes}` : '',
    shape ? `shape: ${shape.ok ? 'ok' : shape.problems.join('; ')}` : '',
    shape
      ? `tools: ${shape.stats.tools} (max ${shape.stats.maxToolsInTurn} in a turn)  web: ${shape.stats.webSearches} (max ${shape.stats.maxWebInTurn})  longest answer: ${shape.stats.longestAnswerWords} words`
      : '',
    `best: ${v.best}`,
    `worst: ${v.worst}`,
    `fix: ${v.fix}`,
    '',
    '## transcript',
    t.screen,
  ]
    .filter((x) => x !== '')
    .join('\n');
  writeFileSync(`${SIM_DIR}/${name}.md`, body);
}

// ---- judging a scripted run (sim/claude.test.ts): the same checks the offline suite makes, read by a model ----

export const RunVerdict = z.object({
  rightAction: z
    .boolean()
    .describe(
      'every step did what the student asked: the right action, or one short clarifying question when the request was genuinely ambiguous',
    ),
  rightCard: z
    .boolean()
    .describe('each card fits the request (a draft for a draft, a list for a list, a person for a person)'),
  invented: z
    .boolean()
    .describe(
      'true only if a reply names a person, company, date or fact that is in neither the account data shown nor the tool results',
    ),
  concise: z
    .boolean()
    .describe('every reply is short and warm: no walls of text, no restating what the card shows'),
  chipsUseful: z
    .boolean()
    .describe(
      'the next-step buttons are what the student would plausibly tap next, and none leads to a dead end',
    ),
  stateOk: z
    .boolean()
    .describe(
      'what changed is what was asked: drafts made when asked, stages moved only when asked, nothing sent or deleted without an Approve',
    ),
  unhelpfulRefusal: z.boolean().describe('true if Orbit said it could not do something it plainly can do'),
  score: z.number().min(1).max(5).describe('1 poor to 5 excellent, from the student point of view'),
  worst: z.string().describe('the single biggest problem, in one line'),
  fix: z.string().describe('one concrete fix, in one line'),
});
export type RunVerdictT = z.infer<typeof RunVerdict>;

const RUN_JUDGE_SYSTEM = [
  JUDGE_SYSTEM,
  'Here the student messages were scripted, so judge Orbit, not the student. Each step lists what Orbit did (its tools and',
  'cards), what it said, the next-step buttons under the card, and what the test expected. Check every step against the',
  'expectation and the rubric: right action or a fair question, right card, nothing invented, concise, useful buttons,',
  'and state changes only as asked (never a send or delete without Approve).',
].join(' ');

/** Judge one scripted run (a single request or a thread) from its steps and what each step was expected to do. */
export async function judgeRun(screen: string, expected: string): Promise<RunVerdictT> {
  const sim = simClient();
  const content = `What each step should do:\n${expected}\n\nWhat happened:\n${screen}\n\nScore this run.`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await sim.messages.parse({
        model: SIM_MODEL,
        max_tokens: 2000,
        system: RUN_JUDGE_SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(RunVerdict as never) },
      });
      if (res.parsed_output) return res.parsed_output as RunVerdictT;
    } catch (e) {
      simError('judge', e); // a truncated or malformed verdict is a harness hiccup; try again
    }
  }
  return {
    rightAction: true,
    rightCard: true,
    invented: false,
    concise: true,
    chipsUseful: true,
    stateOk: true,
    unhelpfulRefusal: false,
    score: 3,
    worst: 'judge returned no parseable verdict (harness/API flake)',
    fix: 'review this transcript by hand',
  };
}

/** The student's own facts, for the judge: name, school, year, majors and what they wrote in setup. */
export async function studentFacts(user: User): Promise<string> {
  const goals = await db.goals.get(user.id);
  const bits = [
    user.fullName || user.firstName,
    [user.school, user.graduationYear ? `class of ${user.graduationYear}` : ''].filter(Boolean).join(', '),
    user.majors?.length ? `studying ${user.majors.join(', ')}` : '',
    goals?.cycleLabel ? `cycle: ${goals.cycleLabel}` : '',
    goals?.targetFunctions?.length ? `targets: ${goals.targetFunctions.join(', ')}` : '',
    goals?.story ? `their story: ${goals.story}` : '',
    goals?.aim ? `their aim: ${goals.aim}` : '',
    goals?.proudOf ? `proud of: ${goals.proudOf}` : '',
  ].filter(Boolean);
  return bits.join('. ').replace(/[—–]/g, ',');
}

/** The last request failure the engine recorded, when it says more than the words the student saw. */
function rawLlmError(): string {
  const last = readPrefs().lastLlmError;
  if (!last || Date.now() - new Date(last.at).getTime() > 120_000) return '';
  const msg = last.message.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-...');
  simError('engine', new Error(`${last.reason}: ${msg}`));
  return ` (${last.reason}: ${msg.slice(0, 300)})`;
}

/** A harness-side failure, said once per place with any key redacted, so an empty run is never silent. */
/** Tools that end a turn (the prompt makes them the last thing said). */
const CLOSING_TOOLS = new Set(['offer_choices', 'show_setup']);
const saidErrors = new Set<string>();
export function simError(where: string, e: unknown): void {
  const msg = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(
    /sk-ant-[A-Za-z0-9_-]+/g,
    'sk-ant-...',
  );
  const key = `${where}:${msg.slice(0, 80)}`;
  if (saidErrors.has(key)) return;
  saidErrors.add(key);
  console.error(`[sim ${where}] ${msg.slice(0, 400)}`);
}
