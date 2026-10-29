/**
 * sync.linkedin {mode: 'backfill' | 'sync' | 'relation', ...} through Unipile (§12.3).
 *
 * Without UNIPILE_API_KEY / UNIPILE_BASE_URL, or without a connected account, the job ends `skipped`.
 * `relation` (a new_relation the webhook could not store) adds that one person. Otherwise the job walks, resuming
 * from sync_state.linkedin:
 *   1. the account's own member id (users/me), attached to the self person so the user's own messages are known;
 *   2. relations, 200 a page until the cursor is null (people, identities, current employer);
 *   3. chats of the last 2 years, 250 a page; for chats with at most 3 attendees, the latest 100 messages, stored
 *      as a linkedin thread with the user's own messages outbound.
 * Paging stays at one request a second per account, and one job makes at most 60 requests, or works for a minute,
 * before it saves {stage, cursor, chatsCursor, chatIndex} and queues the next one 5 s later (the time budget matters
 * more than the count: filing a page of relations is a minute or more, and a worker run that overstays is killed
 * without a trace, so a job that only counted requests was killed on every attempt and dead-lettered). A pass that
 * ended in the last 20 hours is not walked again: a sync asked for then reads one page of the newest relations.
 * New inbound messages of the last 180 days are classified; the people touched are re-scored, and score.user runs
 * when a full pass ends.
 */

import { CLASSIFY_WINDOW_DAYS } from '../../_shared/ingest/gmail.ts';
import {
  CHAT_MAX_ATTENDEES,
  type ChatAttendeeInput,
  ingestRelations,
  relationFromUnipile,
  storeChat,
} from '../../_shared/ingest/linkedin.ts';
import { loadAccount, loadSelf, patchSyncState } from '../../_shared/ingest/util.ts';
import { createUnipileSync, type UnipileSync } from '../../_shared/providers/unipileSync.ts';
import type { JobContext, JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

export const REQUESTS_PER_JOB = 60;
/** a job saves its place and queues the next one after this long */
export const JOB_BUDGET_MS = 60_000;
/** a full pass that ended this recently is not walked again */
export const FRESH_FOR_MS = 20 * 3_600_000;
const DAY = 86_400_000;

interface LinkedinState {
  stage?: 'relations' | 'chats' | 'done';
  cursor?: string | null;
  chatsCursor?: string | null;
  chatIndex?: number;
  selfMemberId?: string;
  /** when the last full pass ended */
  syncedAt?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function linkedinHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const unipile: UnipileSync = createUnipileSync({
    fetch: deps.fetch ?? fetch,
    apiKey: deps.unipile?.apiKey,
    baseUrl: deps.unipile?.baseUrl,
    clock: deps.clock,
    sleep: deps.sleep,
    random: deps.random,
  });

  return {
    'sync.linkedin': async (job, ctx) => {
      if (!unipile.configured) throw new JobSkipped('unconfigured');
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const acct = await loadAccount(ctx.db, userId, 'linkedin');
      if (!acct?.externalAccountId) throw new JobSkipped('not_connected');
      if (acct.status !== 'active') throw new JobSkipped(acct.status);
      const accountId = acct.externalAccountId;
      const now = ctx.now();
      const touched = new Set<string>();

      if (job.payload.mode === 'relation') {
        const memberId = str(job.payload.providerId);
        if (!memberId) return;
        const r = await ingestRelations(
          ctx.db,
          userId,
          [
            {
              memberId,
              publicIdentifier: str(job.payload.publicIdentifier),
              profileUrl: str(job.payload.profileUrl),
              fullName: str(job.payload.name),
              headline: str(job.payload.headline),
              connectedAt: now.toISOString(),
            },
          ],
          now,
        );
        await scorePeople(ctx, userId, [...r.byMember.values()], `${job.msgId}`);
        return;
      }

      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const clock = deps.clock ?? Date.now;
      const started = clock();
      const budgetMs = deps.jobBudgetMs ?? JOB_BUDGET_MS;
      const overBudget = () => clock() - started >= budgetMs;
      let state = (acct.syncState.linkedin ?? {}) as LinkedinState;
      // a pass that ended recently: the newest relations only (a new connection since), nothing walked again
      const fresh =
        state.stage === 'done' &&
        !!state.syncedAt &&
        now.getTime() - Date.parse(state.syncedAt) < FRESH_FOR_MS;
      if (state.stage === 'done' || !state.stage) state = { ...state, stage: 'relations', cursor: null };
      let requests = 0;
      const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        // at most one request a second per account (§12.3 rate limits)
        if (requests > 0) await sleep(1000);
        requests++;
        return fn();
      };
      const save = (patch: LinkedinState & Record<string, unknown>) =>
        patchSyncState(ctx.db, userId, 'linkedin', 'linkedin', patch, { lastSyncedAt: now, lastError: null });

      const self = await loadSelf(ctx.db, userId);
      if (!state.selfMemberId) {
        const me = await call(() => unipile.me(accountId));
        if (me.ok && me.value.provider_id) {
          state.selfMemberId = me.value.provider_id;
          const slug = me.value.public_identifier?.toLowerCase();
          for (const [kind, value] of [
            ['linkedin_member', me.value.provider_id],
            ...(slug ? [['linkedin_slug', slug]] : []),
          ] as [string, string][])
            await ctx.db.sql`
              insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
              values (${userId}::uuid, ${self.selfId}::uuid, ${kind}, ${value}, ${value}, 'linkedin_me')
              on conflict (user_id, kind, value_norm) do nothing`;
          await ctx.db.sql`
            update orbit.people set linkedin_member_id = coalesce(linkedin_member_id, ${me.value.provider_id}),
                   linkedin_slug = coalesce(linkedin_slug, ${slug ?? null})
             where id = ${self.selfId}::uuid`;
          await save({ selfMemberId: state.selfMemberId });
        } else if (!me.ok && me.kind !== 'http') throw new Error(`unipile ${me.kind}`);
      }
      const ownIds = new Set([...self.memberIds, ...(state.selfMemberId ? [state.selfMemberId] : [])]);

      let finished = false;
      let outOfBudget = false;
      while (!outOfBudget && !finished) {
        if (requests >= REQUESTS_PER_JOB || overBudget()) {
          outOfBudget = true;
          break;
        }
        if (state.stage === 'relations') {
          const page = await call(() => unipile.relations(accountId, state.cursor));
          if (!page.ok) throw new Error(`unipile relations ${page.status ?? page.kind}`);
          const rels = page.value.items.map(relationFromUnipile).filter((r) => !!r);
          const r = await ingestRelations(ctx.db, userId, rels, now);
          for (const pid of r.byMember.values()) touched.add(pid);
          if (fresh) {
            // the last pass stands: its end time keeps the next sync short too
            state = { ...state, stage: 'done', cursor: null };
            await save({ stage: 'done', cursor: null });
            finished = true;
            break;
          }
          state = page.value.cursor
            ? { ...state, cursor: page.value.cursor }
            : { ...state, stage: 'chats', cursor: null, chatsCursor: null, chatIndex: 0 };
          await save({
            stage: state.stage,
            cursor: state.cursor ?? null,
            chatsCursor: state.chatsCursor ?? null,
            chatIndex: state.chatIndex ?? 0,
          });
          continue;
        }
        // chats
        const after = new Date(now.getTime() - 730 * DAY).toISOString();
        const page = await call(() => unipile.chats(accountId, { after, cursor: state.chatsCursor }));
        if (!page.ok) throw new Error(`unipile chats ${page.status ?? page.kind}`);
        const chats = page.value.items;
        let i = state.chatIndex ?? 0;
        for (; i < chats.length; i++) {
          if (requests + 2 > REQUESTS_PER_JOB || overBudget()) {
            outOfBudget = true;
            break;
          }
          const chat = chats[i]!;
          const att = await call(() => unipile.attendees(chat.id));
          if (!att.ok) throw new Error(`unipile attendees ${att.status ?? att.kind}`);
          const attendees: ChatAttendeeInput[] = att.value.map((a) => ({
            providerId: a.provider_id,
            attendeeId: a.id,
            name: a.name,
            profileUrl: a.profile_url,
            headline: a.specifics?.occupation,
            isSelf: a.is_self === 1 || a.is_self === true || (!!a.provider_id && ownIds.has(a.provider_id)),
          }));
          // group conversations are not relationships; 1:1 and three-way chats are (§12.3)
          const count = Math.max(
            attendees.length,
            attendees.some((a) => a.isSelf) ? 0 : attendees.length + 1,
          );
          if (count > CHAT_MAX_ATTENDEES) continue;
          const msgs = await call(() => unipile.messages(chat.id));
          if (!msgs.ok) throw new Error(`unipile messages ${msgs.status ?? msgs.kind}`);
          const stored = await storeChat(
            ctx.db,
            userId,
            self,
            { id: chat.id, attendees },
            msgs.value.map((m) => ({
              id: m.id,
              text: m.text,
              senderId: m.sender_id,
              timestamp: m.timestamp,
              isSender: m.is_sender,
              skip: !!m.is_event || !!m.hidden || !!m.deleted,
            })),
            now,
            ownIds,
          );
          if (stored.inserted) for (const p of stored.personIds) touched.add(p);
          for (const m of stored.inbound)
            if (now.getTime() - new Date(m.sentAt).getTime() < CLASSIFY_WINDOW_DAYS * DAY)
              await ctx.queue.enqueue({
                kind: 'classify.message',
                userId,
                payload: { messageId: m.id },
                dedupeKey: `classify:linkedin:${userId}:${m.externalId}`,
              });
        }
        if (outOfBudget) {
          state = { ...state, chatIndex: i };
          await save({ chatIndex: i, chatsCursor: state.chatsCursor ?? null });
          break;
        }
        if (page.value.cursor) {
          state = { ...state, chatsCursor: page.value.cursor, chatIndex: 0 };
          await save({ chatsCursor: page.value.cursor, chatIndex: 0 });
        } else {
          state = { ...state, stage: 'done', chatsCursor: null, chatIndex: 0 };
          await save({ stage: 'done', chatsCursor: null, chatIndex: 0, syncedAt: now.toISOString() });
          finished = true;
        }
      }

      await scorePeople(ctx, userId, [...touched], `${job.msgId}`);
      if (finished)
        await ctx.queue.enqueue({
          kind: 'score.user',
          userId,
          payload: { reason: 'linkedin' },
          dedupeKey: `score.user:${userId}:linkedin:${now.toISOString().slice(0, 13)}`,
        });
      else
        await ctx.queue.enqueue(
          {
            kind: 'sync.linkedin',
            userId,
            payload: { mode: 'sync' },
            dedupeKey: `linkedin-more:${userId}:${job.msgId}`,
          },
          { delaySec: 5 },
        );
    },
  };
}

async function scorePeople(ctx: JobContext, userId: string, personIds: string[], key: string) {
  if (!personIds.length) return;
  await ctx.queue.enqueue({
    kind: 'score.person',
    userId,
    payload: { personIds },
    dedupeKey: `score.person:${userId}:linkedin:${key}`,
  });
}
