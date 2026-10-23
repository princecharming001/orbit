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
  overDailyCap,
  recordFailure,
  recordTokens,
  reserveRequest,
  toLlmError,
} from '../../integrations/anthropic';
import type { ChatConversation, ResultEnvelope, ToolContext, ToolSpec, TurnEvent } from '../types';
import { recordToolAction } from './actions';
import type { ChatClient } from './client';
import { buildSnapshot, memoryLineOf, snapshotIsStale, snapshotKeyOf, snapshotText } from './snapshot';
import { type ChatStore, conversationNonce, toolResultsOf, toolUsesOf } from './store';
import { systemBlocks } from './system';

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

export const MAX_TOKENS = 16_000;
export const MAX_ITERATIONS = 12;
export const FALLBACK_MODELS = [{ model: 'claude-opus-5' }];
/** Consecutive unparseable-tool-JSON failures of one turn before giving up. */
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

/** What the model reads as the tool_result: the envelope with `data` projected by the tool. */
export function projectEnvelope(spec: ToolSpec | undefined, env: ResultEnvelope): string {
  return JSON.stringify({
    kind: env.kind,
    summary: env.summary,
    data: spec?.toModel ? spec.toModel(env.data as never) : env.data,
    href: env.href,
    confirmationId: env.confirmationId,
    continues: env.continues,
  });
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
}

/**
 * The runner tools over the registry: `betaZodTool` (the runner validates the input against the Zod schema before
 * `run`), `eager_input_streaming` so long inputs stream, `strict` on the risky tools so their input is exact. An error envelope is
 * thrown as a `ToolError` so the runner marks the result `is_error` and the model knows to recover.
 */
/** The API accepts at most this many strict tools in one request. */
export const MAX_STRICT_TOOLS = 20;

/**
 * Which tools are strict. The API caps strict tools at twenty, so strict goes where an exact input matters most: the
 * risky tools, whose input the Approve token is bound to. Every tool's input is still validated against its full
 * Zod schema before it runs, strict or not.
 */
export function strictToolNames(specs: ToolSpec[]): Set<string> {
  return new Set(
    specs
      .filter((s) => s.kind === 'risky')
      .map((s) => s.name)
      .slice(0, MAX_STRICT_TOOLS),
  );
}

export function buildRunnerTools(
  registry: ReadonlyMap<string, ToolSpec>,
  hooks: ToolHooks,
): BetaRunnableTool[] {
  const specs = sortedSpecs(registry).filter(modelCallable);
  const strict = strictToolNames(specs);
  const built = specs.map((spec) => {
    const tool = betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input,
      run: async (input, context) => {
        const id = context?.toolUse.id ?? newId('toolu');
        const env = await hooks.onRun(id, spec, input);
        const content = projectEnvelope(spec, env);
        if (env.kind === 'error') throw new ToolError(content);
        return content;
      },
    });
    return {
      ...tool,
      input_schema: strictSchema(
        (tool as { input_schema: Anthropic.Beta.BetaTool.InputSchema }).input_schema,
      ),
      eager_input_streaming: true,
      strict: strict.has(spec.name),
    };
  });
  // a cache breakpoint after the last tool: the tool list is the same in every conversation, while the system block
  // carries the conversation's nonce, so without it every new conversation would write the tools to the cache again
  const last = built.at(-1);
  if (last) built[built.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  return built;
}

/** The request params, built once per turn. Everything but `messages` is byte-identical across a conversation. */
export function turnParams(
  deps: Pick<TurnDeps, 'conversation' | 'quick' | 'prefixMismatch'>,
  tools: BetaRunnableTool[],
  messages: Anthropic.Beta.BetaMessageParam[],
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
    system: systemBlocks(nonce),
    tools,
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
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join(' ')
    .trim();
  const snapshot = await buildSnapshot(user.id, clock(), { lastUserText });
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

  const tools = buildRunnerTools(registry, {
    signal,
    onRun: async (toolUseId, spec, input) => {
      const cancelled = (reason: string): ResultEnvelope => ({
        kind: 'error',
        data: undefined,
        summary: `Cancelled: ${reason}.`,
      });
      let env: ResultEnvelope;
      if (signal?.aborted) env = cancelled('user stopped');
      else {
        try {
          env = await deps.execute(spec.name, input, {
            user,
            now: clock(),
            conversationId: conversation.id,
            nonce,
            wrap,
            toolUseId,
            signal,
            caller: 'llm',
          });
        } catch (e) {
          env = signal?.aborted ? cancelled('user stopped') : thrownEnvelope(e);
        }
      }
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
      results.set(toolUseId, { content: projectEnvelope(spec, env), isError: env.kind === 'error' });
      onEvent({ type: 'tool_result', toolUseId, envelope: env });
      // the last tool of the turn to finish writes the tool_result message at once, so a crash right after the
      // tools ran still leaves every stored tool_use answered
      if (pending && toolUsesOf(pending.message.content).every((u) => results.has(u.id)))
        await flushResults();
      return env;
    },
  });

  const params = turnParams(deps, tools, messages);
  let runner = deps.client.beta.messages.toolRunner(params, { signal });

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
  // every word streamed this turn: a turn that ends without one gets a follow-up asking for the answer in words
  let spoken = '';

  for (let attempt = 0; ; attempt++) {
    try {
      for await (const stream of runner) {
        // listeners go on before anything is awaited: the stream does not replay events emitted before they attach
        stream.on('text', (delta) => {
          spoken += delta;
          onEvent({ type: 'text', delta });
        });
        stream.on('streamEvent', (ev, snapshot) => {
          if (ev.type === 'content_block_stop') {
            // display 'updates': a thinking block with text is a progress note before the tool_use it introduces;
            // one line per block, nothing for an empty block
            const block = snapshot.content[ev.index];
            if (block?.type === 'thinking' && block.thinking.trim())
              onEvent({ type: 'progress', text: block.thinking.trim() });
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
        attempt = 0;
        recordTokens(message.usage);
        for (const t of message.input_transformations ?? [])
          if (t.type === 'thinking_dropped') console.warn('[orbit chat] thinking block dropped', t);
        if (message.usage.iterations?.some((i) => i.type === 'fallback_message'))
          onEvent({
            type: 'progress',
            text: `Answered by ${message.model} after Claude declined part of this.`,
          });
        if (message.stop_reason === 'pause_turn') console.warn('[orbit chat] unexpected pause_turn');

        const hasToolUse = message.content.some((b) => b.type === 'tool_use');
        // a truncated tool input often parses as a valid partial object: never run it, and keep it out of history
        if (message.stop_reason === 'max_tokens' && hasToolUse) throw new TruncatedToolInput();
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
      runner = deps.client.beta.messages.toolRunner({ ...runner.params, stream: true }, { signal });
    }
  }
  await flushResults();
  if (!spoken.trim() && lastStop === 'end_turn' && !signal?.aborted) {
    const said = await speakUp(
      deps,
      runner.params,
      conversation.id,
      clock,
      onEvent,
      persistAssistant,
      signal,
    );
    if (said) lastRowId = said;
  }
  onEvent({ type: 'done', stopReason: lastStop, messageId: lastRowId });
}

const SPEAK_UP =
  "[Orbit] Your reply had no words, only cards or buttons. Answer the student's last message now in one to three plain, warm sentences from what the tools returned. Do not call any tools, and do not repeat what a card already lists.";

/**
 * A turn must never end on cards alone: the prompt asks for words, and this is the backstop when the model still
 * gives none. One more request over the same params with tools off; its text streams as the end of this turn, and
 * the nudge and the answer are stored so the history replays exactly. Best effort: a failure leaves the turn as it was.
 */
async function speakUp(
  deps: TurnDeps,
  params: BetaToolRunnerParams,
  conversationId: string,
  clock: () => Date,
  onEvent: (e: TurnEvent) => void,
  persistAssistant: (m: Anthropic.Beta.BetaMessage) => Promise<{ id: string }>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    // an empty final assistant message cannot be replayed; the nudge stands between the turn and the answer
    const messages = params.messages.filter(
      (m) => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0),
    );
    const nudge: Anthropic.Beta.BetaMessageParam = {
      role: 'system',
      content: [{ type: 'text', text: SPEAK_UP }],
    };
    const runner = deps.client.beta.messages.toolRunner(
      {
        ...params,
        messages: [...messages, nudge],
        tool_choice: { type: 'none' },
        max_iterations: 1,
        stream: true,
      },
      { signal },
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
    }
    return said;
  } catch (e) {
    console.warn('[orbit chat] the follow-up for a reply with no words failed', e);
    return undefined;
  }
}
