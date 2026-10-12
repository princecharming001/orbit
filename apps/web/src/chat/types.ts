/**
 * Shared contract for the chat-first home. Three parts are built against this file: the tool registry (what the
 * assistant can do), the agent loop (how it talks to Claude and the no-key router), and the UI (how results render).
 * Keep this file small and stable; add to it, do not rename.
 */
import type { User } from '@orbit/core';
import type { z } from 'zod/v4';

/** read: never changes data. write: local bookkeeping, runs at once, idempotent. risky: needs an explicit Approve. */
export type ToolKind = 'read' | 'write' | 'risky';

/** How the UI renders a result; the model reads `summary` plus a compact projection of `data`. */
export type ResultKind =
  | 'text'
  | 'person'
  | 'people'
  | 'draft'
  | 'drafts'
  | 'pipeline'
  | 'routes'
  | 'brief'
  | 'suggestion'
  | 'note'
  | 'facts'
  | 'company'
  | 'settings'
  | 'import'
  | 'prep'
  | 'needs_confirmation'
  | 'error';

export interface ResultEnvelope<D = unknown> {
  kind: ResultKind;
  /** full object for the UI; the model gets `toModel(data)` when the tool defines it */
  data: D;
  /** one or two plain sentences: what happened or what was found (no em dashes, no exclamation marks) */
  summary: string;
  /** in-app route for "Open in app" ("/people/p12", "/map?reach=1&to=p12", "/inbox?draft=out_1") */
  href?: string;
  /** only on needs_confirmation: the single-use token the Approve button presents */
  confirmationId?: string;
  /** on needs_confirmation: the assistant had further planned steps after this action */
  continues?: boolean;
}

/** Third-party text (emails, notes, LinkedIn fields) is wrapped before it reaches the model. */
export type Wrap = (label: string, text: string) => string;

export interface ToolContext {
  user: User;
  now: Date;
  conversationId: string;
  /** per-conversation nonce used by `wrap` so content cannot forge the delimiters */
  nonce: string;
  wrap: Wrap;
  /** idempotency key: the model's tool_use id, or the confirmation id on Approve */
  toolUseId?: string;
  /** confirmation token presented by the UI on Approve (risky tools) */
  confirmation?: string;
  /** on Approve of send_draft: the text as edited in the card */
  edited?: { body: string; subject?: string };
  signal?: AbortSignal;
  /** 'llm' when called by the model, 'router' from the no-key router, 'ui' from a chip or an Approve click */
  caller: 'llm' | 'router' | 'ui';
}

export interface ToolSpec<I extends z.ZodObject = z.ZodObject, D = unknown> {
  /** verb_noun, snake_case, unique */
  name: string;
  kind: ToolKind;
  /** when to call it, not only what it does */
  description: string;
  /** zod v4 object; every field has .describe(); fixed sets are enums; only truly required fields are required */
  input: I;
  /** capability ids from capabilities.ts this tool satisfies (the coverage test checks every id has a tool) */
  capabilities: string[];
  execute: (input: z.infer<I>, ctx: ToolContext) => Promise<ResultEnvelope<D>>;
  /** compact projection of `data` for the model; default: the whole data */
  toModel?: (data: D) => unknown;
  /** risky tools: the sentence the Approve card shows (what will happen, and any engine reason it is blocked) */
  summarizeIntent?: (input: z.infer<I>, ctx: ToolContext) => Promise<{ text: string; blockedReason?: string }>;
  /** short labels the UI shows while the tool runs ("Looking at your pipeline") */
  progress?: string;
}

/** One capability a user has in Orbit today (ids come from the inventory); the registry must cover all of them. */
export interface Capability {
  id: string;
  area: string;
  title: string;
  kind: ToolKind;
  /** three ways a student would ask for it */
  utterances: string[];
}

// ---- Persistence (Dexie, append-only) -------------------------------------------------------------------

export interface ChatConversation {
  id: string;
  userId: string;
  title: string;
  /** model the conversation was started on; a model change starts a new conversation */
  model: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** A stored turn. `content` holds the whole API content block array for assistant turns (thinking, tool_use,
 * compaction and fallback blocks included) and the user's blocks for user turns, so the history replays exactly. */
export interface ChatMessage {
  id: string;
  conversationId: string;
  userId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: unknown;
  /** 'decision' = an Approve/Cancel line; 'snapshot' = an appended context block; 'error' = a failed turn note */
  meta?: 'decision' | 'snapshot' | 'error';
  model?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  createdAt: string;
}

/** One tool execution or pending confirmation, keyed by tool_use id or confirmation id (idempotency). */
export interface ChatAction {
  id: string;
  conversationId: string;
  userId: string;
  messageId?: string;
  toolName: string;
  input: unknown;
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'expired' | 'error';
  /** the full envelope for the UI (status done or error) */
  envelope?: ResultEnvelope;
  /** for pending confirmations */
  summary?: string;
  blockedReason?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Rendering events the loop emits to the UI -----------------------------------------------------------

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'progress'; text: string }
  | { type: 'tool_start'; toolUseId: string; toolName: string; progress?: string }
  | { type: 'tool_result'; toolUseId: string; envelope: ResultEnvelope }
  | { type: 'done'; stopReason: string; messageId: string }
  | { type: 'error'; message: string; kind: 'no_key' | 'cap' | 'refusal' | 'network' | 'aborted' | 'other' };
