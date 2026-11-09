/**
 * classify.message {messageId, history?} — or {provider, messageId: <provider's id>} from older webhook payloads — runs
 * the reply classifier of ingest/classify.ts on one stored inbound message (§8.3), then, unless the message was read
 * from the user's history (`history`: a backfill, from before Orbit, where only an unsubscribe still counts), the
 * reply's next step
 * (replies.ts `maybeAutoReply`, §8.4): unsubscribe closes the person's chats and cancels their drafts, a class that
 * needs an answer gets a draft, and at autonomy level 2 a scheduling answer that meets every condition is approved and
 * queued to send. A message that is not stored (yet) or not an inbound human message ends the job quietly. Then how
 * warm the reply reads (plan 27, ingest/rapport.ts), and the sender rescored with it: after the reading, so the score
 * never runs ahead of the reply it should count.
 *
 * rapport.backfill {} — a year of the user's stored replies without a reading get one, then everyone is rescored.
 */
import { isUuid } from '../../_shared/crypto.ts';
import type { Db } from '../../_shared/db.ts';
import { classifyMessage } from '../../_shared/ingest/classify.ts';
import { backfillRapport, readRapport } from '../../_shared/ingest/rapport.ts';
import { tripBreaker } from '../../_shared/replies/breaker.ts';
import { maybeAutoReply } from '../../_shared/replies/replies.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';
import { type HandlerDeps, JobSkipped } from './deps.ts';

const BOUNCE_SENDER = /^(?:mailer-daemon|postmaster|mail delivery (?:subsystem|system)|noreply@.*bounce)/i;
const BOUNCE_SUBJECT =
  /\b(?:undeliverable|delivery (?:status notification|failure|has failed)|returned mail|address not found|mail delivery failed)\b/i;

/**
 * A bounce (plan 29 §B2.7): an automated message from the mail system about a thread Orbit sent in trips the breaker
 * for that draft's goal. Nothing else about automated mail is read.
 */
async function maybeBounce(db: Db, userId: string, messageId: string, now: Date): Promise<void> {
  const [m] = await db.sql<{
    from_addr: string | null;
    subject: string | null;
    thread_external_id: string;
  }>`
    select m.from_addr, m.subject, t.external_id as thread_external_id
      from orbit.messages m join orbit.threads t on t.id = m.thread_id
     where m.id = ${messageId}::uuid and m.user_id = ${userId}::uuid`;
  if (!m) return;
  const from = (m.from_addr ?? '').toLowerCase();
  if (!BOUNCE_SENDER.test(from) && !BOUNCE_SUBJECT.test(m.subject ?? '')) return;
  const [d] = await db.sql<{ id: string; goal_id: string | null; person_id: string; display_name: string }>`
    select d.id, d.goal_id, d.person_id, p.display_name
      from orbit.drafts d join orbit.people p on p.id = d.person_id
     where d.user_id = ${userId}::uuid and d.status = 'sent' and d.thread_external_id = ${m.thread_external_id}
     order by d.sent_at desc limit 1`;
  if (!d) return;
  await tripBreaker(db, userId, {
    goalId: d.goal_id,
    reason: 'bounce',
    personId: d.person_id,
    personName: d.display_name,
    messageId,
    now,
  });
}

export function classifyHandlers(
  deps: HandlerDeps,
  agents: AgentConfig = { env: {} },
): Record<string, JobHandler> {
  return {
    'classify.message': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const p = job.payload;
      let id = isUuid(p.messageRowId) ? p.messageRowId : isUuid(p.messageId) ? p.messageId : undefined;
      if (!id && typeof p.messageId === 'string' && (p.provider === 'linkedin' || p.provider === 'gmail')) {
        const [row] = await ctx.db.sql<{ id: string }>`
          select id from orbit.messages
           where user_id = ${userId}::uuid and provider = ${p.provider} and external_id = ${p.messageId}`;
        id = row?.id;
      }
      if (!id) return;
      const r = await classifyMessage(ctx.db, userId, id, { now: ctx.now(), claude: deps.claude });
      if (r.skipped === 'automated' && p.history !== true) await maybeBounce(ctx.db, userId, id, ctx.now());
      if (!r.replyClass) return;
      const { personId } = await readRapport(ctx.db, userId, id, { claude: deps.claude, llm: r.rapport });
      if (personId)
        await ctx.queue.enqueue({
          kind: 'score.person',
          userId,
          payload: { personIds: [personId] },
          dedupeKey: `score.person:${userId}:rapport:${id}`,
        });
      // idempotent per message, so a retry after a failure here classifies again and picks up where it stopped. A
      // reply read from the user's history came before Orbit: an unsubscribe still counts, but nothing is drafted.
      // The two classes that can end in a call run the funnel (plan 29 §B2.3): slots offered, a named slot booked
      if ((r.replyClass === 'interested' || r.replyClass === 'scheduling') && p.history !== true) {
        await ctx.queue.enqueue({
          kind: 'funnel.reply',
          userId,
          payload: { messageId: id },
          dedupeKey: `funnel:${id}`,
        });
        return;
      }
      await maybeAutoReply(ctx.db, userId, id, {
        services: makeServices(agents, { db: ctx.db, now: ctx.now, queue: ctx.queue }),
        history: p.history === true,
      });
    },
    'rapport.backfill': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      await ctx.queue.setVt(job.queue, job.msgId, 600);
      const n = await backfillRapport(ctx.db, userId, { claude: deps.claude, now: ctx.now() });
      if (n)
        await ctx.queue.enqueue({
          kind: 'score.user',
          userId,
          payload: { reason: 'rapport_backfill' },
          // one rescore per backfill run: a later run (new readings) must not be taken for this one
          dedupeKey: `score.user:${userId}:rapport_backfill:${job.msgId}`,
        });
    },
  };
}
