/**
 * The tool registry: what the assistant can do, and the one function every path (the model, the no-key router, a
 * chip, an Approve click) goes through to do it.
 */

import { audit } from '../db/repo';
import { db } from '../db/schema';
import { z } from '../zod';
import { bindingKey, CONFIRM_FAILURE_TEXT, checkConfirmation, createConfirmation } from './confirm';
import { type AnyTool, err, plain, reasonOf, toModel } from './tools/_shared';
import { accountTools } from './tools/account';
import { draftTools } from './tools/drafts';
import { noteTools } from './tools/notes';
import { peopleTools } from './tools/people';
import { pipelineTools } from './tools/pipeline';
import { readTools } from './tools/read';
import { settingsTools } from './tools/settings';
import { todayTools } from './tools/today';
import { widgetTools } from './tools/widgets';
import type { ChatAction, ResultEnvelope, ToolContext, ToolKind } from './types';

const all: AnyTool[] = [
  ...readTools,
  ...todayTools,
  ...pipelineTools,
  ...peopleTools,
  ...draftTools,
  ...noteTools,
  ...settingsTools,
  ...accountTools,
  ...widgetTools,
].sort((a, b) => a.name.localeCompare(b.name));

for (let i = 1; i < all.length; i++)
  if (all[i]!.name === all[i - 1]!.name) throw new Error(`duplicate tool name ${all[i]!.name}`);

/** Every tool, sorted by name and frozen for the life of the app. */
export const tools: readonly AnyTool[] = Object.freeze(all);
export const registry: ReadonlyMap<string, AnyTool> = new Map(all.map((t) => [t.name, t]));

export function toolCountByKind(): Record<ToolKind, number> {
  const out: Record<ToolKind, number> = { read: 0, write: 0, risky: 0 };
  for (const t of tools) out[t.kind]++;
  return out;
}

/** The JSON Schema the API gets for a tool's input (strict: no extra properties). */
export function inputJsonSchema(tool: AnyTool): Record<string, unknown> {
  return z.toJSONSchema(tool.input) as Record<string, unknown>;
}

/** What the model reads for a result: the summary plus the compact projection, never the whole UI object. */
export function modelResult(name: string, env: ResultEnvelope): Record<string, unknown> {
  const spec = registry.get(name);
  const project = spec?.toModel ?? toModel;
  const out: Record<string, unknown> = {
    kind: env.kind,
    summary: env.summary,
    data: env.kind === 'error' || env.kind === 'needs_confirmation' ? env.data : project(env.data),
  };
  if (env.href) out.href = env.href;
  if (env.confirmationId) out.confirmationId = env.confirmationId;
  if (env.continues) out.continues = true;
  return out;
}

// ---------- the choke point ----------

/** Strict-mode schemas send null for a field left out; the tools treat it as absent. */
function stripNulls(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) if (v !== null) out[k] = v;
  return out;
}

function issuesText(e: z.ZodError): string {
  return plain(
    e.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; '),
  );
}

// one write at a time per conversation: parallel tool calls never race on the same rows
const locks = new Map<string, Promise<unknown>>();
function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(conversationId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(conversationId, settled);
  settled.then(() => {
    if (locks.get(conversationId) === settled) locks.delete(conversationId);
  });
  return run;
}

// the execution a key is waiting on in this tab, so a retry joins it instead of running twice
const inflight = new Map<string, Promise<ResultEnvelope>>();

/**
 * Claim an idempotency key. Returns the stored envelope when the key already ran, the promise to wait on when it is
 * running in this tab, or `claimed` when this call owns it (the row is `running` now).
 */
async function claim(
  key: string,
  ctx: ToolContext,
  toolName: string,
  input: unknown,
): Promise<
  | { state: 'claimed' }
  | { state: 'done'; envelope: ResultEnvelope }
  | { state: 'wait'; promise: Promise<ResultEnvelope> }
> {
  return db.transaction('rw', db.chatActions, async () => {
    const row = await db.chatActions.get(key);
    const now = ctx.now.toISOString();
    if (row && (row.status === 'done' || row.status === 'error') && row.envelope)
      return { state: 'done', envelope: row.envelope };
    if (row?.status === 'running') {
      const p = inflight.get(key);
      if (p) return { state: 'wait', promise: p };
      return {
        state: 'done',
        envelope: err('This action is still running. Give it a moment and look at the result above.'),
      };
    }
    if (row) await db.chatActions.update(key, { status: 'running', updatedAt: now });
    else {
      const fresh: ChatAction = {
        id: key,
        conversationId: ctx.conversationId,
        userId: ctx.user.id,
        toolName,
        input,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      await db.chatActions.add(fresh);
    }
    return { state: 'claimed' };
  });
}

async function finish(key: string, env: ResultEnvelope, ctx: ToolContext): Promise<void> {
  await db.chatActions.update(key, {
    status: env.kind === 'error' ? 'error' : 'done',
    envelope: env,
    updatedAt: ctx.now.toISOString(),
  });
}

/** Run once per key: a retried turn (or a double Approve) gets the stored envelope, never a second execution. */
async function once(
  key: string | undefined,
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  run: () => Promise<ResultEnvelope>,
): Promise<ResultEnvelope> {
  if (!key) return run();
  let resolve!: (e: ResultEnvelope) => void;
  const mine = new Promise<ResultEnvelope>((r) => {
    resolve = r;
  });
  const c = await claim(key, ctx, toolName, input);
  if (c.state === 'done') return c.envelope;
  if (c.state === 'wait') return c.promise;
  inflight.set(key, mine);
  try {
    const env = await run();
    await finish(key, env, ctx);
    resolve(env);
    return env;
  } catch (e) {
    const env = err(reasonOf(e));
    await finish(key, env, ctx).catch(() => undefined);
    resolve(env);
    return env;
  } finally {
    inflight.delete(key);
  }
}

async function runTool(
  spec: AnyTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ResultEnvelope> {
  try {
    const env = await spec.execute(input, ctx);
    env.summary = plain(env.summary);
    if (spec.kind !== 'read' && env.kind !== 'error')
      await audit(ctx.user.id, `chat.${spec.name}`, {
        metadata: {
          conversationId: ctx.conversationId,
          toolUseId: ctx.toolUseId,
          caller: ctx.caller,
          input: compactInput(input),
          result: env.kind,
        },
      }).catch(() => undefined);
    return env;
  } catch (e) {
    return err(reasonOf(e));
  }
}

/** What the audit row keeps of an input: ids and short values, never a whole file or message body. */
function compactInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > 80 ? `${v.slice(0, 77)}… (${v.length} chars)` : v;
    else if (Array.isArray(v)) out[k] = `${v.length} items`;
    else if (v && typeof v === 'object') out[k] = Object.keys(v).join(',');
    else out[k] = v;
  }
  return out;
}

async function needsConfirmation(
  spec: AnyTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ResultEnvelope> {
  let text = `Approve to run ${spec.name.replace(/_/g, ' ')}.`;
  let blockedReason: string | undefined;
  if (spec.summarizeIntent) {
    try {
      const r = await spec.summarizeIntent(input, ctx);
      text = plain(r.text);
      blockedReason = r.blockedReason ? plain(r.blockedReason) : undefined;
    } catch (e) {
      blockedReason = reasonOf(e);
    }
  }
  const row = await createConfirmation(ctx, spec.name, input, text, blockedReason);
  return {
    kind: 'needs_confirmation',
    data: { toolName: spec.name, input, summary: text, blockedReason, expiresAt: row.expiresAt },
    summary: blockedReason
      ? `${text} This is blocked right now: ${blockedReason}`
      : `${text} Nothing happens until you approve it.`,
    confirmationId: row.id,
  };
}

/**
 * Run a tool. Every path goes through here: the input is parsed, a risky tool without a valid token returns
 * needs_confirmation, keys are idempotent, writes are serialised per conversation and audited, and an engine error
 * comes back as an error envelope with the engine's own words.
 */
export async function execute(name: string, input: unknown, ctx: ToolContext): Promise<ResultEnvelope> {
  const spec = registry.get(name);
  if (!spec) return err(`Orbit has no tool named ${name}.`);
  const parsed = spec.input.safeParse(stripNulls(input));
  if (!parsed.success) return err(`The request to ${name} is missing something. ${issuesText(parsed.error)}`);
  const data = parsed.data as Record<string, unknown>;
  if (spec.kind === 'read') return runTool(spec, data, ctx);
  if (spec.kind === 'risky') {
    const check = await checkConfirmation(ctx, name, data);
    if (!check.ok) {
      // a token presented again after it ran gets the stored result, never a second run or a scolding
      if (
        check.reason === 'used' &&
        check.action?.envelope &&
        check.action.toolName === name &&
        bindingKey(name, check.action.input) === bindingKey(name, data)
      )
        return check.action.envelope;
      if (check.reason !== 'no_token') return err(CONFIRM_FAILURE_TEXT[check.reason]);
      // a retried turn with the same tool_use id gets the same token back, never a second one
      return once(ctx.toolUseId, ctx, name, data, () => needsConfirmation(spec, data, ctx));
    }
    const approved = { ...ctx, toolUseId: check.action.id };
    return once(check.action.id, approved, name, data, () =>
      withConversationLock(ctx.conversationId, () => runTool(spec, data, approved)),
    );
  }
  return once(ctx.toolUseId, ctx, name, data, () =>
    withConversationLock(ctx.conversationId, () => runTool(spec, data, ctx)),
  );
}
