/**
 * Intro outcomes for the learning loop (plan 21 §8): when an intro is asked for, the path's hops are frozen on the
 * orbit.intro_requests row (`hop_features`: P and each hop's p, evidence kind and band); the outcome (agreed, declined,
 * intro_made, meeting, no_response) lands on the same row later from reply and calendar detection. `introOutcomes` is
 * the read-only export a fit over hop features will start from once there are enough of them. No fit here.
 */
import { hopBand } from '@orbit/core/graph/route';
import { TIE_KINDS } from '@orbit/core/graph/ties';
import type { IntroHopFeatures } from '@orbit/core/server/api';
import type { Db } from '../db.ts';
import { iso } from '../rows.ts';

const KINDS = new Set<string>([...TIE_KINDS, 'strength']);
const MAX_HOPS = 6;
const clamp01 = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

/**
 * The hop features of a path the app sends with an ask, cleaned: ids as strings, p in [0, 1], a known kind, and the
 * band recomputed from p for every hop after the student's own (never trusted from the client).
 */
export function introHopFeatures(path: unknown, pathScore: number): IntroHopFeatures {
  const hops = (path as { hops?: unknown } | null)?.hops;
  const out: IntroHopFeatures = { p: clamp01(pathScore), hops: [] };
  if (!Array.isArray(hops)) return out;
  for (const [i, h] of hops.slice(0, MAX_HOPS).entries()) {
    if (!h || typeof h !== 'object') continue;
    const o = h as Record<string, unknown>;
    if (typeof o.fromId !== 'string' || typeof o.toId !== 'string') continue;
    const p = clamp01(o.p);
    const kind = typeof o.kind === 'string' && KINDS.has(o.kind) ? o.kind : 'unknown';
    out.hops.push({
      fromId: o.fromId.slice(0, 64),
      toId: o.toId.slice(0, 64),
      p: Math.round(p * 10_000) / 10_000,
      kind,
      ...(i > 0 && kind !== 'strength' ? { band: hopBand(p) } : {}),
    });
  }
  return out;
}

export interface IntroOutcome {
  id: string;
  status: 'asked' | 'agreed' | 'declined' | 'intro_made' | 'meeting' | 'no_response';
  goalKind: string | null;
  askedAt: string;
  outcomeAt: string | null;
  /** P at ask time */
  p: number;
  /** null for asks made before hop features were logged */
  hops: IntroHopFeatures['hops'] | null;
}

/** Every intro the user asked for, with its frozen hop features and what came of it (oldest first). Read-only. */
export async function introOutcomes(db: Db, userId: string): Promise<IntroOutcome[]> {
  const rows = await db.sql<{
    id: string;
    status: IntroOutcome['status'];
    goal_kind: string | null;
    asked_at: Date;
    outcome_at: Date | null;
    path_score: number;
    hop_features: IntroHopFeatures | null;
  }>`
    select r.id, r.status, g.kind as goal_kind, r.asked_at, r.outcome_at, r.path_score, r.hop_features
      from orbit.intro_requests r left join orbit.goals g on g.id = r.goal_id
     where r.user_id = ${userId}::uuid
     order by r.asked_at, r.id`;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    goalKind: r.goal_kind,
    askedAt: iso(r.asked_at)!,
    outcomeAt: iso(r.outcome_at) ?? null,
    p: typeof r.hop_features?.p === 'number' ? r.hop_features.p : Number(r.path_score),
    hops: Array.isArray(r.hop_features?.hops) ? r.hop_features.hops : null,
  }));
}
