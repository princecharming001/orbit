/**
 * The Claude work that goes through Message Batches (plan 35 C2) and the job `claude.batch.poll` runs for it.
 *
 * A caller that nobody waits on (cadence drafts, autopilot first messages, auto replies, the nightly voice distill,
 * the background search_reading pass) asks `claude.structuredBatch` instead of `claude.structured`; the request waits
 * in orbit.claude_batch_requests with the name of the continuation below and what it needs. Every five minutes while a
 * request waits, pg_cron queues `claude.batch.poll` (orbit.enqueue_claude_batch_poll), which submits the queued
 * requests as one batch, reads the batches that ended, and runs each request's continuation on its answer: the same
 * post-processing the synchronous path runs (drafts written, checks, the ladder, readings stored), recorded in the
 * ledger as `<task>:batch` at half price.
 *
 * A request the batch could not answer (expired after 24 hours, errored, canceled, or batching was turned off while it
 * waited) is answered by a synchronous call with the same request instead (claude.ts `resolveBatch`), so nothing is
 * lost. A continuation that finds the answer is no longer wanted (a newer message came, the goal was paused, the
 * person was read in the meantime) skips; a successful answer is recorded in the ledger either way, since it was
 * paid for.
 */

import type { ReplyClass } from '@orbit/core/email/replyClass';
import type { z } from 'zod/v4';
import { afterFirstTouch, firstTouchStillWanted } from './autopilot/plan.ts';
import { cadenceLadder, loadCadence } from './cadence/cadence.ts';
import type { BatchOutcome, BatchRow, ClaudeResult } from './claude.ts';
import { type ComposeFrozen, type ComposeRequest, composeFromBatch } from './compose/compose.ts';
import { loadUserRow } from './compose/context.ts';
import { composeSchema } from './compose/prompts.ts';
import { HttpError } from './http.ts';
import { autoReplyFromBatch } from './replies/replies.ts';
import { readCompaniesFromBatch, readPeopleFromBatch } from './search/reading.ts';
import type { Services } from './services.ts';
import { offeredOf, sourcesFor } from './sources/states.ts';
import { distillFromBatch } from './voice/voice.ts';
import { validZone } from './zones.ts';

/** The answer, read lazily: a continuation that skips never pays for a synchronous fallback. */
export type Answer = <S extends z.ZodType>(schema: S) => Promise<ClaudeResult<z.infer<S>>>;

export type Continuation = (s: Services, row: BatchRow, answer: Answer) => Promise<string>;

type ComposePayload = { req: ComposeRequest; frozen?: ComposeFrozen };

const composeAnswer = (answer: Answer) => answer(composeSchema);

/** The continuations by handler name. Each returns a short word for the log. */
export const BATCH_CONTINUATIONS: Record<string, Continuation> = {
  'compose.auto_reply': async (s, row, answer) => {
    const p = row.payload as ComposePayload & { messageId: string; cls: ReplyClass };
    if (!row.user_id) return 'no_user';
    const out = await autoReplyFromBatch(s, row.user_id, p, () => composeAnswer(answer));
    return out ? out.action : 'skipped';
  },

  'compose.cadence': async (s, row, answer) => {
    const p = row.payload as ComposePayload;
    const userId = row.user_id;
    if (!userId) return 'no_user';
    try {
      const draft = (await composeFromBatch(s, p.req, p.frozen, await composeAnswer(answer))).draft;
      const st = await loadCadence(s.db, userId, s.now(), await sourcesFor(s.db, userId, offeredOf(s.env)));
      return cadenceLadder(
        s,
        userId,
        st,
        { draftKind: p.req.kind, goalId: p.req.goalId ?? null, personId: p.req.personId },
        p.req.channel === 'linkedin' ? 'linkedin' : 'gmail',
        draft,
      );
    } catch (e) {
      if (e instanceof HttpError) return e.code;
      throw e;
    }
  },

  'compose.first_touch': async (s, row, answer) => {
    const p = row.payload as ComposePayload & { goalId: string; goalTitle: string };
    const userId = row.user_id;
    if (!userId) return 'no_user';
    // the goal was paused or taken off autopilot while the answer was on its way: no message
    if (!(await firstTouchStillWanted(s, userId, p.goalId))) return 'not_wanted';
    try {
      const draft = (await composeFromBatch(s, p.req, p.frozen, await composeAnswer(answer))).draft;
      const user = await loadUserRow(s.db, userId);
      return afterFirstTouch(s, userId, { id: p.goalId, title: p.goalTitle }, p.req.personId, draft, {
        user,
        now: s.now(),
        tz: validZone(user.timezone) ?? 'America/New_York',
      });
    } catch (e) {
      if (e instanceof HttpError) return e.code;
      throw e;
    }
  },

  'voice.distill': async (s, row, answer) => {
    const p = row.payload as { editIds?: string[] };
    if (!row.user_id) return 'no_user';
    const r = await distillFromBatch(s, row.user_id, p.editIds ?? [], (schema) => answer(schema));
    return r.by ?? 'done';
  },

  'reading.people': async (s, row, answer) => {
    const p = row.payload as { personIds?: string[] };
    if (!row.user_id) return 'no_user';
    const n = await readPeopleFromBatch(s.db, row.user_id, p.personIds ?? [], (schema) => answer(schema));
    return `read ${n}`;
  },

  'reading.companies': async (s, row, answer) => {
    const p = row.payload as { linkedinIds?: string[] };
    const n = await readCompaniesFromBatch(s.db, p.linkedinIds ?? [], (schema) => answer(schema), s.now());
    return `read ${n}`;
  },
};

/** Answers one poll carries on from at most: a continuation writes a draft and may retry it synchronously. */
export const POLL_MAX = 40;

export interface BatchPollSummary {
  submitted: number;
  collected: number;
  done: number;
  expired: number;
  failed: number;
  submitError?: string;
}

/**
 * One `claude.batch.poll`: answers what can be answered first (the batches that ended, the requests past their
 * window), then submits what is queued. Each answered request is marked done (its job ran on a batch answer),
 * expired (it ran synchronously instead) or failed (its continuation threw; the error is kept on the row).
 */
export async function pollClaudeBatches(
  s: Services,
  opts: { continuations?: Record<string, Continuation>; max?: number } = {},
): Promise<BatchPollSummary> {
  const continuations = opts.continuations ?? BATCH_CONTINUATIONS;
  const out: BatchPollSummary = { submitted: 0, collected: 0, done: 0, expired: 0, failed: 0 };
  const claude = s.claude;
  if (!claude.batches || !claude.resolveBatch) return out;
  const resolve = claude.resolveBatch;
  // the rest wait for the next poll: their batch's answers are kept for 29 days
  const answered = (await claude.batches.collect()).slice(0, opts.max ?? POLL_MAX);
  out.collected = answered.length;
  for (const { row, outcome } of answered) {
    let used = false;
    const answer: Answer = (schema) => {
      used = true;
      return resolve(row, outcome, schema);
    };
    const run = continuations[row.handler];
    try {
      if (!run) throw new Error(`no continuation for ${row.handler}`);
      await run(s, row, answer);
      // a successful answer the continuation did not need is still recorded: it was paid for
      if (!used) await claude.batches.record(row, outcome);
      await claude.batches.finish(row.id, outcome.ok ? 'done' : 'expired', reasonOf(outcome));
      if (outcome.ok) out.done++;
      else out.expired++;
    } catch (e) {
      out.failed++;
      await claude.batches.finish(row.id, 'failed', e instanceof Error ? e.message.slice(0, 200) : 'error');
    }
  }
  const sub = await claude.batches.submit();
  out.submitted = sub.submitted;
  if (sub.error) out.submitError = sub.error;
  return out;
}

const reasonOf = (o: BatchOutcome) => (o.ok ? undefined : `${o.reason}${o.detail ? `: ${o.detail}` : ''}`);
