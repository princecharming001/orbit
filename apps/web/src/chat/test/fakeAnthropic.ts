/**
 * A scripted Anthropic Messages API over `fetch`, so tests run the real SDK client: the real beta tool runner, the
 * real Zod validation, the real SSE parsing and the real error classes. Each `POST /v1/messages` is answered from the
 * next turn of the script, encoded as server-sent events exactly as the API streams them. Every request body and
 * header is recorded so tests can assert the cached prefix is byte-identical across turns, that all tool results of a
 * parallel turn travel in one user message, and that the beta params are present.
 */

export interface ScriptedToolCall {
  id?: string;
  name: string;
  input?: unknown;
  /** raw JSON for the input instead of `input` (truncated or unparseable JSON exercises the eager-streaming paths) */
  rawJson?: string;
  /** how many `input_json_delta` chunks to split the JSON into (default 3) */
  chunks?: number;
}

export interface ScriptTurn {
  /** progress notes streamed as thinking blocks before the text (display 'updates') */
  thinking?: string[];
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** a server-side compaction block at the front of the content */
  compaction?: { content: string; encrypted_content?: string };
  /** a fallback block: the requested model declined and `to` continued */
  fallback?: { from: string; to: string };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';
  stopDetails?: { category: string | null; explanation?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model?: string;
  /** answer with an HTTP error instead of a stream */
  error?: { status: number; type: string; message: string };
  /** stream the content, then hold the connection open until the request is aborted */
  hang?: boolean;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: tests dig into the raw request body
  body: any;
}

export interface FakeAnthropic {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** turns not yet served */
  remaining(): number;
  /** add turns while a test runs */
  push(...turns: ScriptTurn[]): void;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(6, '0')}`;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function split(s: string, n: number): string[] {
  if (n <= 1 || s.length <= 1) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** The SSE frames of one scripted turn. */
export function encodeTurn(turn: ScriptTurn, requestedModel: string): string[] {
  const model = turn.model ?? (turn.fallback ? turn.fallback.to : requestedModel);
  const usage = {
    input_tokens: turn.usage?.input_tokens ?? 1000,
    output_tokens: 0,
    cache_creation_input_tokens: turn.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
    server_tool_use: null,
    service_tier: 'standard',
    iterations: turn.fallback
      ? [
          { type: 'message', model: turn.fallback.from, input_tokens: 0, output_tokens: 0 },
          { type: 'fallback_message', model: turn.fallback.to, input_tokens: 0, output_tokens: 0 },
        ]
      : null,
  };
  const frames: string[] = [];
  frames.push(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: nextId('msg'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        usage,
      },
    }),
  );
  let index = 0;
  const block = (start: unknown, deltas: unknown[] = []) => {
    const i = index++;
    frames.push(sse('content_block_start', { type: 'content_block_start', index: i, content_block: start }));
    for (const d of deltas)
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index: i, delta: d }));
    frames.push(sse('content_block_stop', { type: 'content_block_stop', index: i }));
  };
  if (turn.compaction)
    block(
      {
        type: 'compaction',
        content: turn.compaction.content,
        encrypted_content: turn.compaction.encrypted_content ?? 'enc_' + nextId('c'),
        signature: 'sig_' + nextId('c'),
      },
      [
        {
          type: 'compaction_delta',
          content: turn.compaction.content,
          encrypted_content: turn.compaction.encrypted_content ?? 'enc',
        },
      ],
    );
  if (turn.fallback)
    block({
      type: 'fallback',
      from: { model: turn.fallback.from },
      to: { model: turn.fallback.to },
      trigger: { type: 'refusal', category: 'general_harms' },
    });
  for (const note of turn.thinking ?? [])
    block({ type: 'thinking', thinking: '', signature: '' }, [
      ...split(note, 2).map((t) => ({ type: 'thinking_delta', thinking: t })),
      { type: 'signature_delta', signature: 'sig_' + nextId('t') },
    ]);
  if (turn.text !== undefined)
    block(
      { type: 'text', text: '', citations: null },
      split(turn.text, 3).map((t) => ({ type: 'text_delta', text: t })),
    );
  for (const call of turn.toolCalls ?? []) {
    const json = call.rawJson ?? JSON.stringify(call.input ?? {});
    block(
      { type: 'tool_use', id: call.id ?? nextId('toolu'), name: call.name, input: {} },
      split(json, call.chunks ?? 3).map((partial_json) => ({ type: 'input_json_delta', partial_json })),
    );
  }
  const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn');
  frames.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details:
          stopReason === 'refusal' ? (turn.stopDetails ?? { category: null, explanation: null }) : null,
      },
      usage: { ...usage, output_tokens: turn.usage?.output_tokens ?? 50 },
    }),
  );
  frames.push(sse('message_stop', { type: 'message_stop' }));
  return frames;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export function scriptedFetch(script: ScriptTurn[] = []): FakeAnthropic {
  const queue = [...script];
  const requests: RecordedRequest[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init?.method ?? 'GET', headers: headersOf(init), body });
    if (!/\/v1\/messages(\?|$)/.test(url))
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: url } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      );
    const turn = queue.shift();
    if (!turn)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'fake: script exhausted' },
        }),
        { status: 400, headers: { 'content-type': 'application/json', 'request-id': nextId('req') } },
      );
    if (turn.error)
      return new Response(
        JSON.stringify({ type: 'error', error: { type: turn.error.type, message: turn.error.message } }),
        {
          status: turn.error.status,
          headers: { 'content-type': 'application/json', 'request-id': nextId('req') },
        },
      );
    const frames = encodeTurn(turn, body?.model ?? 'unknown');
    const enc = new TextEncoder();
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames.slice(0, turn.hang ? -2 : frames.length)) controller.enqueue(enc.encode(f));
        if (!turn.hang) {
          controller.close();
          return;
        }
        const abort = () => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          } catch {}
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': nextId('req') },
    });
  };
  return {
    fetch: fake,
    requests,
    remaining: () => queue.length,
    push: (...turns) => {
      queue.push(...turns);
    },
  };
}

/** The request bodies of the Messages calls, in order. */
export function messageRequests(fake: FakeAnthropic): RecordedRequest[] {
  return fake.requests.filter((r) => /\/v1\/messages/.test(r.url));
}
