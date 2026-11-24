/**
 * An automated warm-up as the browser receives it (core's `WarmUpRun`): the run with its steps, and nothing of how it
 * is carried out (the Unipile account, the person's LinkedIn ids, the post's id, the draft the comment started as).
 * /sync/pull and the warm-up routes shape a row the same way, through here.
 */
import type { WarmUpRun, WarmUpRunStep } from '@orbit/core/warmup/auto';
import type { Db } from '../db.ts';

/** Columns of orbit.warmups that never leave the server. */
export const WARMUP_PRIVATE_COLUMNS = [
  'linkedin_account',
  'target_member_id',
  'target_slug',
  'connected_at_start',
  'post_id',
  'comment_draft',
  'comment_approved_at',
  'timezone',
  'warm_up_days',
  'notified_at',
  'rev',
];

/** SQL over alias t (orbit.warmups): the run's steps as a jsonb array under `steps`, in order. */
export const WARMUP_STEPS_SQL = `jsonb_build_object('steps', coalesce((
  select jsonb_agg(jsonb_build_object(
           'id', s.id, 'seq', s.seq, 'kind', s.kind, 'dueAt', s.due_at, 'status', s.status,
           'attempts', s.attempts, 'ranAt', s.ran_at, 'note', s.note) order by s.seq)
    from orbit.warmup_steps s where s.warmup_id = t.id), '[]'::jsonb))`;

const isoOf = (v: unknown): string | undefined => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A camelCased orbit.warmups row (with `steps`) as a WarmUpRun. */
export function warmupRunFrom(r: Record<string, unknown>): WarmUpRun {
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s): WarmUpRunStep => {
    const o = s as Record<string, unknown>;
    return {
      id: String(o.id),
      seq: Number(o.seq),
      kind: o.kind as WarmUpRunStep['kind'],
      dueAt: isoOf(o.dueAt) ?? String(o.dueAt),
      status: o.status as WarmUpRunStep['status'],
      attempts: Number(o.attempts ?? 0),
      ...(isoOf(o.ranAt) ? { ranAt: isoOf(o.ranAt) } : {}),
      ...(text(o.note) ? { note: text(o.note) } : {}),
    };
  });
  const post = text(r.postUrl) || text(r.postExcerpt) || text(r.postTopic);
  const started = isoOf(r.startedAt) ?? isoOf(r.createdAt) ?? new Date(0).toISOString();
  return {
    id: String(r.id),
    userId: String(r.userId),
    personId: String(r.personId),
    status: r.status as WarmUpRun['status'],
    ...(text(r.stopReason) ? { stopReason: text(r.stopReason) } : {}),
    ...(post
      ? {
          post: {
            ...(text(r.postUrl) ? { url: text(r.postUrl) } : {}),
            ...(text(r.postExcerpt) ? { excerpt: text(r.postExcerpt) } : {}),
            ...(text(r.postTopic) ? { topic: text(r.postTopic) } : {}),
            ...(isoOf(r.postAt) ? { postedAt: isoOf(r.postAt) } : {}),
          },
        }
      : {}),
    comment: typeof r.comment === 'string' ? r.comment : null,
    steps,
    startedAt: started,
    readyAt: isoOf(r.readyAt) ?? started,
    ...(isoOf(r.finishedAt) ? { finishedAt: isoOf(r.finishedAt) } : {}),
    ...(isoOf(r.toldAt) ? { toldAt: isoOf(r.toldAt) } : {}),
    ...(isoOf(r.updatedAt) ? { updatedAt: isoOf(r.updatedAt) } : {}),
  };
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** One of the student's runs, as the browser shape; undefined when it is not theirs. */
export async function loadWarmupRun(db: Db, userId: string, id: string): Promise<WarmUpRun | undefined> {
  const [row] = await db.query<{ row: Record<string, unknown> }>(
    `select to_jsonb(t) || ${WARMUP_STEPS_SQL} as row from orbit.warmups t
      where t.id = $1::uuid and t.user_id = $2::uuid`,
    [id, userId],
  );
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.row)) if (!WARMUP_PRIVATE_COLUMNS.includes(k)) out[camel(k)] = v;
  return warmupRunFrom(out);
}
