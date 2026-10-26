/**
 * Orbit's job queues (§9.1) over pgmq. `enqueue` goes through orbit.enqueue, which drops a message whose dedupeKey
 * is still queued or ran successfully in the last 24 hours; the raw pgmq calls are for the worker.
 */
import type { Db } from './db.ts';

/** In priority order: the worker drains them top to bottom. */
export const QUEUES = [
  'orbit_send',
  'orbit_classify',
  'orbit_sync',
  'orbit_cadence',
  'orbit_score',
  'orbit_enrich',
] as const;
export type QueueName = (typeof QUEUES)[number];

/** Which queue each job kind runs on. */
export const KIND_QUEUE: Record<string, QueueName> = {
  'send.draft': 'orbit_send',
  'classify.message': 'orbit_classify',
  'rapport.backfill': 'orbit_classify',
  'sync.gmail.backfill': 'orbit_sync',
  'sync.gmail.incremental': 'orbit_sync',
  'sync.calendar': 'orbit_sync',
  'sync.contacts': 'orbit_sync',
  'sync.linkedin': 'orbit_sync',
  'cadence.user': 'orbit_cadence',
  'health.snapshot': 'orbit_cadence',
  'score.user': 'orbit_score',
  'score.person': 'orbit_score',
  'enrich.dossier': 'orbit_enrich',
  'source.search': 'orbit_enrich',
  hop_evidence: 'orbit_enrich',
  noop: 'orbit_enrich',
};

export interface JobMessage {
  kind: string;
  userId: string | null;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

export interface QueuedMessage {
  msgId: number;
  readCt: number;
  enqueuedAt: Date;
  message: unknown;
}

export interface Queue {
  /** Through orbit.enqueue: null when the dedupe key dropped it. The queue follows the kind unless given. */
  enqueue(msg: JobMessage, opts?: { delaySec?: number; queue?: QueueName }): Promise<number | null>;
  read(queue: QueueName, vtSec: number, qty: number): Promise<QueuedMessage[]>;
  delete(queue: QueueName, msgId: number): Promise<void>;
  archive(queue: QueueName, msgId: number): Promise<void>;
  setVt(queue: QueueName, msgId: number, vtSec: number): Promise<void>;
}

export function queueFor(kind: string): QueueName {
  const q = KIND_QUEUE[kind];
  if (!q) throw new Error(`no queue for job kind ${kind}`);
  return q;
}

export function sqlQueue(db: Db): Queue {
  return {
    async enqueue(msg, opts = {}) {
      const queue = opts.queue ?? queueFor(msg.kind);
      const [row] = await db.sql<{ id: number | string | null }>`
        select orbit.enqueue(${queue}, ${msg}::jsonb, ${Math.max(0, Math.floor(opts.delaySec ?? 0))}::int) as id`;
      return row?.id == null ? null : Number(row.id);
    },
    async read(queue, vtSec, qty) {
      const rows = await db.sql<{
        msg_id: number | string;
        read_ct: number;
        enqueued_at: Date;
        message: unknown;
      }>`
        select msg_id, read_ct, enqueued_at, message from pgmq.read(${queue}, ${vtSec}::int, ${qty}::int)`;
      return rows.map((r) => ({
        msgId: Number(r.msg_id),
        readCt: Number(r.read_ct),
        enqueuedAt: new Date(r.enqueued_at),
        message: r.message,
      }));
    },
    async delete(queue, msgId) {
      await db.sql`select pgmq.delete(${queue}, ${msgId}::bigint)`;
    },
    async archive(queue, msgId) {
      await db.sql`select pgmq.archive(${queue}, ${msgId}::bigint)`;
    },
    async setVt(queue, msgId, vtSec) {
      await db.sql`select msg_id from pgmq.set_vt(${queue}, ${msgId}::bigint, ${Math.floor(vtSec)}::int)`;
    },
  };
}
