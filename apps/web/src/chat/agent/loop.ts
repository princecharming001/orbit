import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import {
  describeLlmFailure,
  LlmError,
  makeWrap,
  neutralizeTags,
  overDailyCap,
  recordFailure,
  recordTokens,
  reserveRequest,
  toLlmError,
  type Wrap,
} from '../../integrations/anthropic';
import type { ChatConversation, ResultEnvelope, ToolContext, ToolSpec, TurnEvent } from '../types';
import { recordToolAction } from './actions';
import { sentenceGate, withoutButtonTalk } from './buttonTalk';
import { type ChatClient, usesSharedAccess } from './client';
import { knowledgeTextFor } from './knowledge';
import { isOrbitText } from './orbitNote';
import { buildSnapshot, memoryLineOf, snapshotIsStale, snapshotKeyOf, snapshotText } from './snapshot';
import { type ChatStore, conversationNonce, toolResultsOf, toolUsesOf } from './store';
import { systemBlocks } from './system';
import { WEB_SEARCH_TOOL, WEB_SEARCH_TURN_BUDGET, webSources } from './webSearch';

/**
 * One student turn against Claude: the beta tool runner with streaming over the injected tool registry. The loop
 * owns what the runner does not: the stop-reason rules (max_tokens with a tool_use, refusal), the retry for tool JSON
 * the SDK cannot parse, the daily caps, the error chain, and append-only persistence of every content block so the
 * stored history replays exactly and every stored tool_use is answered by a tool_result even when the turn is
 * stopped half way.
 */

export const CHAT_BETAS = [
  'compact-2026-01-12', // server-side compaction: `context_management.edits[].type: 'compact_20260112'`
  'server-side-fallback-2026-06-01', // refusal fallbacks in the array form of `fallbacks`
  'thinking-display-updates-2026-08-18', // progress lines between tool calls (`thinking.display: 'updates'`)
  'thinking-binding-controls-2026-08-01', // `thinking.block_binding.prefix_mismatch_behavior`
] as const;

/** The longest real answers are under 2,000 tokens; a tool input cut off here is caught as TruncatedToolInput. */
export const MAX_TOKENS = 8_000;
/** Model requests a turn may make (plan 34 C2: was 12, the bench's longest real turns used five). */
export const MAX_ITERATIONS = 8;
/** Requests a re-issued turn may make after unparseable tool JSON: enough to finish, not to start over. */
export const RETRY_MAX_ITERATIONS = 3;
/** The header that tells Orbit's shared access which request of the turn this is, so the turn's shape is measured. */
export const ITERATION_HEADER = 'x-orbit-iterations';
export const FALLBACK_MODELS = [{ model: 'claude-opus-5' }];
/** Words before the pills that are a clause of intent, not an answer: what follows them is then the reply. */
const CLAUSE_WORDS = 9;
/** Unparseable-tool-JSON failures one turn may re-issue, counted over the whole turn (never reset by a good stream). */
const MAX_PARSE_RETRIES = 2;

export const COMPACTION_INSTRUCTIONS =
  "Keep the student's name and goals, every pending confirmation and its id, every draft id and person id mentioned, every decision the student made (approved, cancelled, moved, dismissed), and what the student asked for last.";

export type ExecuteFn = (name: string, input: unknown, ctx: ToolContext) => Promise<ResultEnvelope>;

export interface TurnDeps {
  client: ChatClient;
  registry: ReadonlyMap<string, ToolSpec>;
  execute: ExecuteFn;
  store: ChatStore;
  user: User;
  conversation: ChatConversation;
  now?: () => Date;
  /** 'quick' pins effort low for the engine; the default pins medium (the model's own default, pinned so it never varies) */
  quick?: boolean;
  /** 'drop_block' in production (degrade, do not fail); 'error' in tests so any history edit fails the test */
  prefixMismatch?: 'drop_block' | 'error';
}

export class TruncatedToolInput extends Error {
  constructor() {
    super('tool input truncated at max_tokens');
    this.name = 'TruncatedToolInput';
  }
}

/**
 * The results whose data holds third-party text (an email, a note, a LinkedIn field). In the chat loop a tool's own
 * `wrap` only neutralizes such text and marks the result here; the loop then wraps the whole projected data once,
 * instead of every field in its own untrusted element with the nonce (plan 35 A3: list_inbox alone had 90).
 */
const UNTRUSTED_RESULTS = new WeakSet<ResultEnvelope>();

/** A `wrap` for one tool call in the loop: neutralizes the text and remembers that the result needs the wrapper. */
export function deferredWrap(): { wrap: Wrap; used: () => boolean } {
  let used = false;
  return {
    wrap: (_source, text) => {
      used = true;
      return neutralizeTags(text);
    },
    used: () => used,
  };
}

/** Marks a result as holding third-party text, so its data goes out inside one untrusted element. */
export function markUntrusted(env: ResultEnvelope): void {
  UNTRUSTED_RESULTS.add(env);
}

/**
 * What the model reads as the tool_result: the envelope with `data` projected by the tool. When the data holds
 * third-party text (see markUntrusted) and the conversation's wrap is given, the envelope's own fields stay JSON on
 * the first line and the data follows inside one untrusted element.
 */
export function projectEnvelope(spec: ToolSpec | undefined, env: ResultEnvelope, wrapAll?: Wrap): string {
  const data = spec?.toModel ? spec.toModel(env.data as never) : env.data;
  const head = {
    kind: env.kind,
    summary: env.summary,
    href: env.href,
    confirmationId: env.confirmationId,
    continues: env.continues,
  };
  if (wrapAll && UNTRUSTED_RESULTS.has(env) && data !== undefined)
    return `${JSON.stringify(head)}\n${wrapAll(spec?.name ?? 'tool', JSON.stringify(data))}`;
  return JSON.stringify({
    kind: env.kind,
    summary: env.summary,
    data,
    href: env.href,
    confirmationId: env.confirmationId,
    continues: env.continues,
  });
}

/** Reads a tool_result back (tests and tools that replay one): plain JSON, or the head line plus the wrapped data. */
// biome-ignore lint/suspicious/noExplicitAny: like JSON.parse, the shape is the tool's own
export function parseToolResult(text: string): any {
  const nl = text.indexOf('\n<untrusted_');
  if (nl < 0) return JSON.parse(text);
  const head = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
  const body = text.slice(nl + 1);
  const inner = body.slice(body.indexOf('>\n') + 2, body.lastIndexOf('\n</untrusted_'));
  return { ...head, data: JSON.parse(inner.replace(/&lt;(\s*\/?\s*untrusted)/gi, '<$1')) };
}

function cancelledContent(reason: string): string {
  return JSON.stringify({ kind: 'error', summary: `Cancelled: ${reason}.` });
}

/** The error envelope for a tool that threw instead of answering. The raw error stays out of the student's copy. */
export function thrownEnvelope(e: unknown): ResultEnvelope {
  return {
    kind: 'error',
    data: { detail: e instanceof Error ? e.message : String(e) },
    summary: 'The tool could not finish.',
  };
}

/** Map a failure to the event kind the UI switches on. */
export function eventKind(e: LlmError): Extract<TurnEvent, { type: 'error' }>['kind'] {
  switch (e.reason) {
    case 'auth':
    case 'permission':
      return 'no_key';
    case 'cap':
    case 'shared_limit':
      return 'cap';
    case 'refusal':
      return 'refusal';
    case 'network':
    case 'rate_limit':
    case 'server':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'other';
  }
}

/** Student-facing copy for a failed turn, in plain words. */
export function failureMessage(e: LlmError): string {
  if (e.reason === 'aborted') return 'Stopped.';
  const { title, body } = describeLlmFailure(e);
  return e.reason === 'other' && e.detail === undefined ? e.message : `${title}. ${body}`;
}

/** Tools are sorted by name and fixed for the conversation, so the cached prefix never moves. */
export function sortedSpecs(registry: ReadonlyMap<string, ToolSpec>): ToolSpec[] {
  return [...registry.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether the model can call a tool at all: a tool whose input holds a File (the imports) has no JSON Schema form,
 * so it is reachable only from the "+" menu and chips through `execute()`, never offered to the model.
 */
export function modelCallable(spec: ToolSpec): boolean {
  try {
    betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input,
      run: async () => '',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The input schema in the form strict tools accept: `betaZodTool` sends Zod's JSON Schema as it is, and strict mode
 * rejects keywords it cannot enforce (`minimum`, `maxLength` and the like). The SDK's own transform moves those into
 * the description; the runner still validates every input against the full Zod schema before it runs.
 */
export function strictSchema<S extends object>(schema: S): S {
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return transformJSONSchema(rest) as unknown as S;
}

interface ToolHooks {
  onRun: (toolUseId: string, spec: ToolSpec, input: unknown) => Promise<ResultEnvelope>;
  signal?: AbortSignal;
  /** a line for the model appended to every tool result, such as the spent web search budget */
  note?: () => string | undefined;
  /** the conversation's wrap, for results that hold third-party text (projectEnvelope) */
  wrap?: Wrap;
}

/** What the model reads back from a tool: the projected envelope, then the turn's note when there is one. */
export function toolResultText(
  spec: ToolSpec | undefined,
  env: ResultEnvelope,
  note?: string,
  wrapAll?: Wrap,
): string {
  const content = projectEnvelope(spec, env, wrapAll);
  return note ? `${content}\n${note}` : content;
}

/** The note once the turn has run its share of web searches: kept in the messages, so the cached prefix holds. */
export const WEB_BUDGET_NOTE =
  '[Orbit] The web searches for this turn are used up. Answer from what you have found; do not search again.';

/**
 * One switch for tool search (plan 35 A1): on, only CORE_TOOLS load up front and the rest are found through Claude's
 * BM25 tool search when a turn needs them (still sent in full, so the API can expand them). Off, every tool loads as
 * before. Flip this one line to go back.
 */
export const CHAT_TOOL_SEARCH = true;

/**
 * Set when the API refused a request because of tool search (a 400 naming it): every later turn in this page load
 * loads all tools again, and the refused request is re-sent that way, so a student never sees the refusal.
 */
let toolSearchRejected = false;
export function resetToolSearchForTests(): void {
  toolSearchRejected = false;
}
/** A 400 from the API about tool search or deferred tools, as opposed to any other bad request. */
export function isToolSearchRejection(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    /tool[_ ]search|defer_loading|tool_reference/i.test(err.message)
  );
}

/** The server tool that finds deferred tools by a natural-language query (docs: tool-search-tool). */
export const TOOL_SEARCH_TOOL = {
  type: 'tool_search_tool_bm25_20251119',
  name: 'tool_search_tool_bm25',
} as const satisfies Anthropic.Beta.Messages.BetaToolSearchToolBm25_20251119;

/**
 * Tools the model never sees. The admin and legacy ones are reached only from Settings, the "+" menu, the router and
 * chips; update_goal is set_goal with a goalId for the model; search_network_spec is the router's own form of
 * search_network (a compiled spec). All of them still run through `execute()`.
 */
export const MODEL_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'load_demo',
  'leave_demo',
  'delete_all_data',
  'export_data',
  'set_claude_key',
  'set_llm_feature',
  'disconnect_google',
  'disconnect_linkedin',
  'process_outbox',
  'set_autonomy',
  'update_goal',
  'search_network_spec',
]);

/**
 * The tools loaded up front when tool search is on: what most turns use (the day, people, the network, drafts,
 * autopilot, memory, the playbook) and the two that close a turn. Everything else is one search away.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'add_person',
  'autopilot_status',
  'create_draft',
  'find_people',
  'find_routes',
  'get_person',
  'get_today_brief',
  'list_drafts',
  'list_inbox',
  'list_pipeline',
  'lookup_playbook',
  'offer_choices',
  'open_page',
  'remember',
  'search_network',
  'search_people',
  'send_draft',
  'set_goal',
  'show_setup',
  'update_draft_body',
]);

/**
 * The API's limits on strict tools in one request, deferred ones included (the grammar is built from the whole list):
 * twenty strict tools, 24 optional parameters and 16 union-typed parameters across all their schemas.
 */
export const STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const;
/** Risky tools that are strict before any other: the input the student approves is exactly what runs. */
export const STRICT_FIRST = [
  'send_draft',
  'schedule_sends',
  'undo_send',
  'update_limits',
  'approve_batch',
  'set_autopilot_mode',
];
/** Kept for callers that read the old name. */
export const MAX_STRICT_TOOLS = STRICT_LIMITS.tools;

type JsonSchema = Record<string, unknown>;

/** Optional and union-typed parameters at every depth of a schema, as the strict limits count them. */
export function schemaCost(schema: unknown): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as JsonSchema;
    const props = n.properties as Record<string, JsonSchema> | undefined;
    if (props && typeof props === 'object') {
      const required = new Set((n.required as string[] | undefined) ?? []);
      for (const [k, v] of Object.entries(props)) {
        if (!required.has(k)) optional++;
        if (v && (Array.isArray(v.type) || Array.isArray(v.anyOf))) unions++;
      }
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'description' && k !== 'enum') walk(v);
  };
  walk(schema);
  return { optional, unions };
}

/**
 * Which tools are strict: the risky tools, whose input the Approve token is bound to, STRICT_FIRST first and then the
 * cheapest, for as long as the API's limits allow. Every tool's input is still validated against its full Zod schema
 * before it runs, strict or not.
 */
export function strictToolNames(specs: ToolSpec[], schemaOf: (spec: ToolSpec) => unknown): Set<string> {
  const risky = specs.filter((s) => s.kind === 'risky');
  const rank = (s: ToolSpec) => {
    const i = STRICT_FIRST.indexOf(s.name);
    return i >= 0 ? i : STRICT_FIRST.length;
  };
  const costs = new Map(risky.map((s) => [s.name, schemaCost(schemaOf(s))]));
  const ordered = [...risky].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      costs.get(a.name)!.optional - costs.get(b.name)!.optional ||
      (a.name < b.name ? -1 : 1),
  );
  const out = new Set<string>();
  let optional = 0;
  let unions = 0;
  for (const s of ordered) {
    const c = costs.get(s.name)!;
    if (out.size >= STRICT_LIMITS.tools) break;
    if (optional + c.optional > STRICT_LIMITS.optional || unions + c.unions > STRICT_LIMITS.unions) continue;
    out.add(s.name);
    optional += c.optional;
    unions += c.unions;
  }
  return out;
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The input schema without what says nothing: Zod's `$schema` line and the safe-integer bounds it puts on every
 * `.int()` (minimum -2^53+1, maximum 2^53-1). Real bounds and enums stay.
 */
export function compactSchema<S extends object>(schema: S): S {
  const clean = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(clean);
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(node as JsonSchema)) {
      if (k === '$schema') continue;
      if (k === 'minimum' && v === -SAFE_MAX) continue;
      if (k === 'maximum' && v === SAFE_MAX) continue;
      out[k] = k === 'enum' || k === 'required' ? v : clean(v);
    }
    return out;
  };
  return clean(schema) as S;
}

/** Tools whose input can run long (a message, a goal, pills): their input streams as it is written. */
const EAGER = (spec: ToolSpec) => spec.kind !== 'read' || spec.name === 'offer_choices';

/**
 * The runner tools over the registry: `betaZodTool` (the runner validates the input against the Zod schema before
 * `run`), `eager_input_streaming` on the tools whose input can run long, `strict` on the risky tools that fit the API's limits so their
 * input is exact, and `defer_loading` on every tool outside CORE_TOOLS when tool search is on. An error envelope is
 * thrown as a `ToolError` so the runner marks the result `is_error` and the model knows to recover.
 */
export function buildRunnerTools(
  registry: ReadonlyMap<string, ToolSpec>,
  hooks: ToolHooks,
  opts: { toolSearch?: boolean } = {},
): BetaRunnableTool[] {
  const search = opts.toolSearch ?? (CHAT_TOOL_SEARCH && !toolSearchRejected);
  const specs = sortedSpecs(registry).filter((s) => !MODEL_HIDDEN_TOOLS.has(s.name) && modelCallable(s));
  const made = specs.map((spec) => {
    const tool = betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input,
      run: async (input, context) => {
        const id = context?.toolUse.id ?? newId('toolu');
        const env = await hooks.onRun(id, spec, input);
        const content = toolResultText(spec, env, hooks.note?.(), hooks.wrap);
        if (env.kind === 'error') throw new ToolError(content);
        return content;
      },
    });
    const schema = compactSchema(
      (tool as { input_schema: Anthropic.Beta.BetaTool.InputSchema }).input_schema,
    );
    return { spec, tool, schema };
  });
  const bySpec = new Map(made.map((m) => [m.spec.name, m.schema]));
  const strict = strictToolNames(specs, (s) => strictSchema(bySpec.get(s.name)!));
  const built: BetaRunnableTool[] = made.map(({ spec, tool, schema }) => ({
    ...tool,
    input_schema: strict.has(spec.name) ? strictSchema(schema) : schema,
    ...(EAGER(spec) ? { eager_input_streaming: true } : {}),
    ...(strict.has(spec.name) ? { strict: true } : {}),
    ...(search && !CORE_TOOLS.has(spec.name) ? { defer_loading: true } : {}),
  }));
  // a cache breakpoint after the last loaded tool as well as on the frozen system block: both are the same for every
  // conversation of every student, so one warm entry serves them all (a deferred tool cannot carry one)
  for (let i = built.length - 1; i >= 0; i--)
    if (!built[i]!.defer_loading) {
      built[i] = { ...built[i]!, cache_control: { type: 'ephemeral' } };
      break;
    }
  return built;
}

/**
 * The client tools, the tool search tool when any are deferred, then web search, the cache breakpoint moved onto the
 * last one so the whole loaded list stays cached.
 */
export function withWebSearch(tools: BetaRunnableTool[]): BetaToolRunnerParams['tools'] {
  const plain = tools.map(({ cache_control: _c, ...t }) => t as BetaRunnableTool);
  const search = plain.some((t) => t.defer_loading) ? [TOOL_SEARCH_TOOL] : [];
  return [...plain, ...search, { ...WEB_SEARCH_TOOL, cache_control: { type: 'ephemeral' } }];
}

/**
 * The request params, built once per turn. Everything but `messages` is byte-identical across a conversation;
 * `knowledge` is the student's playbook block (agent/knowledge.ts), which changes only when their goals do.
 */
export function turnParams(
  deps: Pick<TurnDeps, 'conversation' | 'quick' | 'prefixMismatch'>,
  tools: BetaRunnableTool[],
  messages: Anthropic.Beta.BetaMessageParam[],
  knowledge?: string,
): BetaToolRunnerParams & { stream: true } {
  const nonce = conversationNonce(deps.conversation.id);
  return {
    model: deps.conversation.model,
    max_tokens: MAX_TOKENS,
    betas: [...CHAT_BETAS],
    thinking: {
      type: 'adaptive',
      display: 'updates',
      block_binding: { prefix_mismatch_behavior: deps.prefixMismatch ?? 'drop_block' },
    },
    output_config: { effort: deps.quick ? 'low' : 'medium' },
    fallbacks: FALLBACK_MODELS,
    context_management: { edits: [{ type: 'compact_20260112', instructions: COMPACTION_INSTRUCTIONS }] },
    cache_control: { type: 'ephemeral' },
    system: systemBlocks(nonce, knowledge),
    tools: withWebSearch(tools),
    messages,
    stream: true,
    max_iterations: MAX_ITERATIONS,
  };
}

type StoredUsage = NonNullable<import('../types').ChatMessage['usage']>;

function storedUsage(u: Anthropic.Beta.BetaUsage): StoredUsage {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? undefined,
    cacheWrite: u.cache_creation_input_tokens ?? undefined,
  };
}

export async function runTurn(
  deps: TurnDeps,
  userBlocks: Anthropic.Beta.BetaContentBlockParam[],
  onEvent: (e: TurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { store, conversation, user, registry } = deps;
  const clock = deps.now ?? (() => new Date());
  const nonce = conversationNonce(conversation.id);
  const { wrap } = makeWrap(nonce);

  const fail = async (e: LlmError): Promise<void> => {
    recordFailure(e);
    const message = failureMessage(e);
    // a note for the thread only: `history()` leaves meta 'error' rows out of the next request
    await store.append(
      conversation.id,
      { role: 'system', content: [{ type: 'text', text: message }], meta: 'error' },
      clock(),
    );
    onEvent({ type: 'error', message, kind: eventKind(e) });
  };

  // one request is reserved per turn before anything is sent; the cap error means nothing happened
  try {
    reserveRequest();
  } catch (e) {
    const err = toLlmError(e);
    recordFailure(err);
    onEvent({ type: 'error', message: failureMessage(err), kind: eventKind(err) });
    return;
  }

  // the history, the student's turn and, when stale, a fresh snapshot: all appended, nothing edited
  const history = await store.history(conversation.id);
  const userMsg: Anthropic.Beta.BetaMessageParam = { role: 'user', content: userBlocks };
  await store.append(conversation.id, userMsg, clock());
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, userMsg];
  // the student's words of this turn pick what "Remembered" holds
  const lastUserText = userBlocks
    .map((b) => (b.type === 'text' && !isOrbitText(b.text) ? b.text : ''))
    .join(' ')
    .trim();
  const snapshot = await buildSnapshot(user.id, clock(), { lastUserText });
  // the playbook for this student's goals, after the frozen block (plan 28); a failure here is never a failed turn
  const knowledge = await knowledgeTextFor(user.id).catch(() => undefined);
  const previous = await store.lastContextTexts(conversation.id);
  const snapshotStale = snapshotIsStale(
    previous.snapshot ? snapshotKeyOf(previous.snapshot) : undefined,
    snapshot,
  );
  // the Remembered line changes with nearly every message: on its own it goes out as one short row, so the full
  // snapshot is appended only when the student's state changed
  const memoryStale =
    !!snapshot.memory && snapshot.memory !== (previous.memory ? memoryLineOf(previous.memory) : undefined);
  if (snapshotStale || memoryStale) {
    const sys: Anthropic.Beta.BetaMessageParam = {
      role: 'system',
      content: [{ type: 'text', text: snapshotStale ? snapshotText(snapshot) : snapshot.memory! }],
    };
    await store.append(conversation.id, { ...sys, meta: snapshotStale ? 'snapshot' : 'memory' }, clock());
    messages.push(sys);
  }

  // tool executions of this turn, by tool_use id, so stopped turns can still be answered in the stored history
  const results = new Map<string, { content: string; isError: boolean }>();
  let pending: { message: Anthropic.Beta.BetaMessage; rowId: string } | undefined;
  // every word streamed this turn: a turn that ends without one gets a follow-up asking for the answer in words
  let spoken = '';
  // the words said before a presentation tool (pills, a setup card) closed the turn: the prompt makes those tools
  // the last thing in a turn, and a line the model adds after them reads as a doubled reply, so when words came
  // before them the words after are neither shown nor stored
  let closedAfter: string | undefined;
  let muted = '';
  // a lookup or a web search ran this turn, and the words said since the last one: work with none after it has no
  // answer (the model may have left it in a thinking note)
  let worked = false;
  let spokenAfterWork = '';

  // Claude's web searches this turn: each request may run WEB_SEARCH_MAX_USES, and once the turn has run its share
  // the tool results say so. Taking the tool away instead would change the tool list and miss the prompt cache for
  // the rest of the turn, which costs more than the searches it saves
  let webSearches = 0;
  const budgetNote = () => (webSearches >= WEB_SEARCH_TURN_BUDGET ? WEB_BUDGET_NOTE : undefined);
  // which request of the turn this is, sent to Orbit's shared access only (a student's own key goes straight to
  // Anthropic, where an unknown header would fail the browser's CORS check)
  const metered = usesSharedAccess();
  let iteration = 1;
  const requestOptions = () => ({
    signal,
    ...(metered ? { headers: { [ITERATION_HEADER]: String(iteration) } } : {}),
  });

  // the stored assistant row whose tools asked a question back (plan 37): later rounds of this turn run nothing
  let askedIn: string | undefined;
  const toolHooks: ToolHooks = {
    signal,
    note: budgetNote,
    wrap,
    onRun: async (toolUseId, spec, input) => {
      const cancelled = (reason: string): ResultEnvelope => ({
        kind: 'error',
        data: undefined,
        summary: `Cancelled: ${reason}.`,
      });
      let env: ResultEnvelope;
      if (!CLOSING_TOOLS.has(spec.name)) {
        worked = true;
        spokenAfterWork = '';
      }
      if (signal?.aborted) env = cancelled('user stopped');
      else if (askedIn !== undefined && pending?.rowId !== askedIn)
        // plan 37 R7: a question back ends the work of the turn; whatever comes next waits for the student's pick
        env = { kind: 'error', data: undefined, summary: NOT_RUN_ASKED };
      else if (
        CLOSING_TOOLS.has(spec.name) &&
        pending &&
        toolUsesOf(pending.message.content).some((u) => u.id !== toolUseId && !CLOSING_TOOLS.has(u.name))
      )
        // pills put up in the same round as a lookup come before the answer, and the model then talks about the
        // buttons instead of answering ("The buttons are below."): they are not shown, a failed step the thread
        // hides, and the model writes the answer and calls them on their own after it
        env = {
          kind: 'error',
          data: undefined,
          summary:
            'Not shown yet: the answer comes first. Write the answer from the other results now, in your own words, then call this on its own as the last thing. Never mention buttons or options in your words.',
        };
      else {
        // third-party text is neutralized field by field and the result wrapped once (projectEnvelope)
        const once = deferredWrap();
        try {
          env = await deps.execute(spec.name, input, {
            user,
            now: clock(),
            conversationId: conversation.id,
            nonce,
            wrap: once.wrap,
            toolUseId,
            signal,
            caller: 'llm',
          });
          if (once.used()) markUntrusted(env);
        } catch (e) {
          env = signal?.aborted ? cancelled('user stopped') : thrownEnvelope(e);
        }
      }
      if (env.kind === 'clarify' && askedIn === undefined) askedIn = pending?.rowId ?? '';
      await recordToolAction(store, {
        conversationId: conversation.id,
        userId: user.id,
        toolUseId,
        toolName: spec.name,
        input,
        env,
        messageId: pending?.rowId,
        now: clock(),
      });
      results.set(toolUseId, {
        content: toolResultText(spec, env, budgetNote(), wrap),
        isError: env.kind === 'error',
      });
      // the pills close the turn only when they were the whole round: next to a read tool, the answer is still to come
      if (
        CLOSING_TOOLS.has(spec.name) &&
        closedAfter === undefined &&
        pending &&
        toolUsesOf(pending.message.content).every((u) => CLOSING_TOOLS.has(u.name))
      )
        closedAfter = spoken;
      onEvent({ type: 'tool_result', toolUseId, envelope: env });
      // the last tool of the turn to finish writes the tool_result message at once, so a crash right after the
      // tools ran still leaves every stored tool_use answered
      if (pending && toolUsesOf(pending.message.content).every((u) => results.has(u.id)))
        await flushResults();
      return env;
    },
  };
  let tools = buildRunnerTools(registry, toolHooks);

  const params = turnParams(deps, tools, messages, knowledge);
  let runner = deps.client.beta.messages.toolRunner(params, requestOptions());

  /**
   * Answer every tool_use of the last stored assistant message. The runner's own tool_result message is preferred
   * (byte-identical with what went to the API); when the runner never produced one (the turn stopped first) the
   * recorded results fill in and anything else is an is_error "cancelled" result.
   */
  const flushResults = async (reason = 'user stopped'): Promise<void> => {
    if (!pending) return;
    const uses = toolUsesOf(pending.message.content);
    pending = undefined;
    if (!uses.length) return;
    const last = runner.params.messages.at(-1);
    const fromRunner = last?.role === 'user' ? toolResultsOf(last.content) : [];
    const content: Anthropic.Beta.BetaContentBlockParam[] =
      fromRunner.length && uses.every((u) => fromRunner.some((r) => r.tool_use_id === u.id))
        ? (last!.content as Anthropic.Beta.BetaContentBlockParam[])
        : uses.map((u) => {
            const r = results.get(u.id);
            return r
              ? r.isError
                ? { type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: true }
                : { type: 'tool_result', tool_use_id: u.id, content: r.content }
              : { type: 'tool_result', tool_use_id: u.id, content: cancelledContent(reason), is_error: true };
          });
    await store.append(conversation.id, { role: 'user', content }, clock());
  };

  const persistAssistant = async (message: Anthropic.Beta.BetaMessage) => {
    const row = await store.append(
      conversation.id,
      {
        role: 'assistant',
        content: message.content,
        model: message.model,
        usage: storedUsage(message.usage),
        stopReason: message.stop_reason ?? undefined,
      },
      clock(),
    );
    pending = { message, rowId: row.id };
    return row;
  };

  let lastRowId = '';
  let lastStop = 'end_turn';

  for (let attempt = 0; ; attempt++) {
    try {
      for await (const stream of runner) {
        // listeners go on before anything is awaited: the stream does not replay events emitted before they attach
        // the words go out a sentence at a time, without the ones about the buttons ("The options are below.")
        const gate = sentenceGate((text) => {
          spoken += text;
          spokenAfterWork += text;
          onEvent({ type: 'text', delta: text });
        });
        stream.on('text', (delta) => {
          if (closedAfter?.trim()) {
            muted += delta;
            return;
          }
          gate.push(delta);
        });
        stream.on('streamEvent', (ev, snapshot) => {
          // a text block's last words go out when it ends, before the tool or card that follows it
          if (ev.type === 'content_block_stop' && snapshot.content[ev.index]?.type === 'text') gate.flush();
          if (ev.type === 'content_block_stop') {
            // display 'updates': a thinking block with text is a progress note before the tool_use it introduces;
            // one line per block, nothing for an empty block
            const block = snapshot.content[ev.index];
            if (block?.type === 'thinking' && block.thinking.trim())
              onEvent({ type: 'progress', text: block.thinking.trim() });
          }
          // Claude's web search runs on Anthropic's side: the query when its block is complete, the sources when the
          // result block arrives (it comes whole)
          if (ev.type === 'content_block_stop') {
            const block = snapshot.content[ev.index];
            if (block?.type === 'server_tool_use' && block.name === 'web_search') {
              worked = true;
              spokenAfterWork = '';
              const q = (block.input as { query?: unknown } | undefined)?.query;
              onEvent({ type: 'web_search', id: block.id, query: typeof q === 'string' ? q : undefined });
            }
          }
          if (ev.type === 'content_block_start' && ev.content_block.type === 'web_search_tool_result') {
            const r = ev.content_block;
            onEvent({
              type: 'web_results',
              id: r.tool_use_id,
              sources: webSources(r.content),
              failed: !Array.isArray(r.content),
            });
          }
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            onEvent({
              type: 'tool_start',
              toolUseId: ev.content_block.id,
              toolName: ev.content_block.name,
              progress: registry.get(ev.content_block.name)?.progress,
            });
          }
        });
        // results the tools did not write themselves (a tool_use whose input failed validation never ran)
        await flushResults();
        const message = await stream.finalMessage();
        gate.flush();
        recordTokens(message.usage);
        webSearches += message.usage.server_tool_use?.web_search_requests ?? 0;
        // the next request the runner sends is the next of the turn
        iteration++;
        if (metered) runner.setRequestOptions(requestOptions());
        for (const t of message.input_transformations ?? [])
          if (t.type === 'thinking_dropped') console.warn('[orbit chat] thinking block dropped', t);
        if (message.usage.iterations?.some((i) => i.type === 'fallback_message'))
          onEvent({
            type: 'progress',
            text: `Answered by ${message.model} after Claude declined part of this.`,
          });
        // a long web search pauses the turn: the runner sends it back as it is and the answer carries on

        const hasToolUse = message.content.some((b) => b.type === 'tool_use');
        // a truncated tool input often parses as a valid partial object: never run it, and keep it out of history
        if (message.stop_reason === 'max_tokens' && hasToolUse) throw new TruncatedToolInput();
        if (closedAfter?.trim() && muted) {
          if (hasToolUse) {
            // the turn went on to another tool after the pills: the words were not a doubled reply after all
            muted = withoutButtonTalk(muted);
            spoken += muted;
            if (muted) onEvent({ type: 'text', delta: muted });
            muted = '';
          } else if (closedAfter.trim().split(/\s+/).length < CLAUSE_WORDS) {
            // the words before the pills were only a clause of intent ("One sec, checking."): what came after
            // them is the answer itself, not a doubled reply, so it is shown and kept
            muted = withoutButtonTalk(muted);
            spoken += muted;
            spokenAfterWork += muted;
            if (muted) onEvent({ type: 'text', delta: muted });
            muted = '';
          } else {
            // the line after the pills: not shown, and not stored, so a reload does not bring it back
            muted = '';
            lastStop = message.stop_reason ?? 'end_turn';
            continue;
          }
        }
        const row = await persistAssistant(message);
        lastRowId = row.id;
        lastStop = message.stop_reason ?? 'end_turn';
        if (message.stop_reason === 'refusal') {
          await flushResults('Claude declined this request');
          return fail(new LlmError('refusal', 'Claude declined this request.'));
        }
        if (hasToolUse) {
          const cap = overDailyCap();
          if (cap) {
            await flushResults('daily limit reached');
            return fail(cap);
          }
        }
        // the runner now validates and runs this turn's tools and appends their results itself
      }
      break;
    } catch (err) {
      // the API refused tool search before anything was said or run: load every tool and send the request again
      if (
        isToolSearchRejection(err) &&
        tools.some((t) => t.defer_loading) &&
        !pending &&
        !spoken &&
        !signal?.aborted
      ) {
        toolSearchRejected = true;
        console.warn('[orbit chat] tool search was refused, sending the turn with every tool loaded', err);
        tools = buildRunnerTools(registry, toolHooks, { toolSearch: false });
        runner = deps.client.beta.messages.toolRunner(
          { ...runner.params, tools: withWebSearch(tools) },
          requestOptions(),
        );
        continue;
      }
      if (
        err instanceof Anthropic.APIError ||
        err instanceof TruncatedToolInput ||
        err instanceof LlmError ||
        signal?.aborted ||
        attempt >= MAX_PARSE_RETRIES
      ) {
        await flushResults(signal?.aborted ? 'user stopped' : 'the turn failed');
        const e =
          err instanceof TruncatedToolInput
            ? new LlmError('other', 'Orbit ran out of room while working on this. Try again.', err.message)
            : signal?.aborted
              ? new LlmError('aborted', 'Stopped.', err instanceof Error ? err.message : String(err))
              : toLlmError(err);
        return fail(e);
      }
      // tool JSON the SDK could not parse at all: the failed turn was never appended, so re-issue it
      console.warn('[orbit chat] tool input was not parseable JSON, re-issuing the turn', err);
      iteration++;
      runner = deps.client.beta.messages.toolRunner(
        { ...runner.params, stream: true, max_iterations: RETRY_MAX_ITERATIONS },
        requestOptions(),
      );
    }
  }
  await flushResults();
  // no words at all, or only a clause of intent ("Let me check the news.") before the work and the pills: the
  // answer never reached the student (the model may have left it in a thinking note), so it is asked for
  const onlyClause = worked && !spokenAfterWork.trim() && spoken.trim().split(/\s+/).length < CLAUSE_WORDS;
  if ((!spoken.trim() || onlyClause) && lastStop === 'end_turn' && !signal?.aborted) {
    const said = await speakUp(
      deps,
      runner.params,
      conversation.id,
      clock,
      onEvent,
      persistAssistant,
      signal,
      metered ? { [ITERATION_HEADER]: String(iteration) } : undefined,
      askedIn !== undefined ? ASK_UP : SPEAK_UP,
    );
    if (said) lastRowId = said;
  }
  onEvent({ type: 'done', stopReason: lastStop, messageId: lastRowId });
}

/** A tool call after a question back in the same turn: not run, and the model is told why. */
export const NOT_RUN_ASKED =
  'Not run: you asked the student which one they meant. Write the one short question naming the choices and stop; this runs after they pick.';

/** The tools that end a turn: words come before them, and a line after them would read as a doubled reply. */
const CLOSING_TOOLS = new Set(['offer_choices', 'show_setup']);

export const SPEAK_UP =
  "[Orbit] Your reply had no answer in words, only a lookup, cards or buttons. Answer the student's last message now in one to three plain, warm sentences from what the tools and searches returned, naming a source in words when it came from the web. Do not call any tools, and do not repeat what a card already lists.";

/** The backstop's words after a question back: the question, never an answer around it. */
export const ASK_UP =
  "[Orbit] Your reply had no words. A tool found that the student's ask fits several things. Ask them which one in one short question that names the choices, and nothing else. Do not call any tools.";

const NOT_RUN = JSON.stringify({ kind: 'error', summary: 'Not run: answer in words now.' });

/**
 * A turn must never end on cards alone: the prompt asks for words, and this is the backstop when the model still
 * gives none. One more request over the same params, the nudge appended and nothing else changed (the same tools and
 * tool_choice, so the cached history is read, not written again; plan 35 A3), stopping after that one request. The
 * nudge says not to call tools; a tool the model calls anyway is never run, and is answered "not run" so the stored
 * history stays valid. Its text streams as the end of this turn, and the nudge and the answer are stored so the
 * history replays exactly. Best effort: a failure leaves the turn as it was.
 */
async function speakUp(
  deps: TurnDeps,
  params: BetaToolRunnerParams,
  conversationId: string,
  clock: () => Date,
  onEvent: (e: TurnEvent) => void,
  persistAssistant: (m: Anthropic.Beta.BetaMessage) => Promise<{ id: string }>,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  say = SPEAK_UP,
): Promise<string | undefined> {
  try {
    // an empty final assistant message cannot be replayed; the nudge stands between the turn and the answer
    const messages = params.messages.filter(
      (m) => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0),
    );
    // a system message may only follow a user message (or a server tool result): after an assistant message that
    // ended on a thinking note the nudge goes in as Orbit's own user message, which the prompt reads the same way
    const last = messages.at(-1);
    const nudge: Anthropic.Beta.BetaMessageParam = {
      role: last?.role === 'assistant' ? 'user' : 'system',
      content: [{ type: 'text', text: say }],
    };
    // the same tool definitions (what is sent is byte-identical); only what runs locally is swapped for "not run"
    const tools = params.tools.map((t) =>
      'run' in t && typeof t.run === 'function'
        ? ({
            ...t,
            run: async () => {
              throw new ToolError(NOT_RUN);
            },
          } as typeof t)
        : t,
    );
    const runner = deps.client.beta.messages.toolRunner(
      { ...params, tools, messages: [...messages, nudge], max_iterations: 1, stream: true },
      { signal, ...(headers ? { headers } : {}) },
    );
    let said: string | undefined;
    for await (const stream of runner) {
      let text = '';
      stream.on('text', (delta) => {
        text += delta;
        onEvent({ type: 'text', delta });
      });
      const message = await stream.finalMessage();
      recordTokens(message.usage);
      if (!text.trim()) return undefined;
      await deps.store.append(conversationId, nudge, clock());
      said = (await persistAssistant(message)).id;
      const uses = toolUsesOf(message.content);
      if (uses.length)
        await deps.store.append(
          conversationId,
          {
            role: 'user',
            content: uses.map((u) => ({
              type: 'tool_result' as const,
              tool_use_id: u.id,
              content: NOT_RUN,
              is_error: true,
            })),
          },
          clock(),
        );
    }
    return said;
  } catch (e) {
    console.warn('[orbit chat] the follow-up for a reply with no words failed', e);
    return undefined;
  }
}
