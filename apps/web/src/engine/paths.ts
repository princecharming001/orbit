/**
 * Warm paths from orbit-api (plan 16 §4, account mode): /paths/find ranks routes by the chance the introduction
 * actually happens and says why in plain words; /intros/ask drafts the intro request and a note the introducer can
 * forward (it never sends). Paths found in this tab are kept by id, so "ask Maya for that intro" names one.
 */
import type { PathsFindResponse, PathTarget, User, WarmPath } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { pullNow } from './serverSync';

export type ServerPath = WarmPath & { id: string; names: Record<string, string> };

/** The bands as the student reads them: how likely the intro is to happen. */
export const PATH_BAND_LABELS: Record<WarmPath['band'], string> = {
  high: 'Likely',
  medium: 'Possible',
  low: 'Long shot',
};

interface Cached {
  path: ServerPath;
  targetPersonId?: string;
  goalId?: string;
  at: number;
}
const found = new Map<string, Cached>();
const KEEP_MS = 60 * 60_000;

export function cachedPath(id: string, now = Date.now()): Cached | undefined {
  const c = found.get(id);
  return c && now - c.at < KEEP_MS ? c : undefined;
}

type Fail = { ok: false; message: string; reason?: string };
const notHere = (): Fail => ({ ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER });

/** Routes to a person or a company from the server, kept by id for ask_for_intro. */
export async function findPathsOnServer(
  user: Pick<User, 'id'>,
  target: PathTarget,
  goalId?: string,
): Promise<{ ok: true; value: PathsFindResponse } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/paths/find', { target, goalId });
  if (!r.ok) return { ok: false, message: r.message, reason: r.reason };
  const targetPersonId = 'personId' in target ? target.personId : undefined;
  for (const p of r.value.paths ?? [])
    found.set(p.id, { path: p, targetPersonId: targetPersonId ?? p.nodes.at(-1), goalId, at: Date.now() });
  return { ok: true, value: r.value };
}

/** A path as the chat and the routes card show it: the names in order, the band in words, the reason. */
export function serverPathView(p: ServerPath) {
  const name = (id: string) => (id === 'user' ? 'You' : (p.names?.[id] ?? 'someone'));
  const names = p.nodes.map(name);
  return {
    id: p.id,
    band: p.band,
    bandLabel: PATH_BAND_LABELS[p.band] ?? p.band,
    score: Math.round(p.p * 100) / 100,
    chance: `${Math.round(p.p * 100)}%`,
    firstHopId: p.firstHopId,
    firstHop: name(p.firstHopId),
    names,
    reason: p.reasonText,
    otherWays: p.otherWays,
    // the shape the routes card reads: one hop per person after "You", the reason on the first
    hops: p.nodes.slice(1).map((id, i) => ({
      to: name(id),
      toId: id,
      ...(i === 0 && p.reasonText ? { how: p.reasonText } : {}),
    })),
  };
}

export type IntroOutcome =
  | { ok: true; introRequestId: string; draftIds: string[]; introducer: string; target: string }
  | Fail;

/** Draft the intro request (and the forwardable note) for a path found earlier. Never sends. */
export async function askForIntro(
  user: Pick<User, 'id'>,
  pathId: string,
  targetPersonId?: string,
): Promise<IntroOutcome> {
  if (!isServerUser(user.id)) return notHere();
  let c = cachedPath(pathId);
  if (!c && targetPersonId) {
    const again = await findPathsOnServer(user, { personId: targetPersonId });
    if (!again.ok) return again;
    c = cachedPath(pathId);
  }
  if (!c)
    return {
      ok: false,
      message: 'That route is no longer on hand. Find the routes to them again, then ask for the intro.',
    };
  const p = c.path;
  const target = c.targetPersonId ?? p.nodes.at(-1)!;
  const r = await callApi('/intros/ask', {
    introducerPersonId: p.firstHopId,
    targetPersonId: target,
    goalId: c.goalId,
    pathScore: p.p,
    path: p,
  });
  if (!r.ok) return { ok: false, message: r.message, reason: r.reason };
  // the drafts come down with the next pull; fetch them now so Drafts shows them
  await pullNow(user.id).catch(() => undefined);
  return {
    ok: true,
    introRequestId: r.value.introRequestId,
    draftIds: r.value.draftIds,
    introducer: p.names?.[p.firstHopId] ?? 'them',
    target: p.names?.[target] ?? 'them',
  };
}

/** Test hook. */
export function clearPathCacheForTests(): void {
  found.clear();
}

/** Routes found in this tab in the last hour, newest first, for the no-key router's "ask Sam for that intro". */
export function recentPaths(now = Date.now()): { id: string; firstHopName: string; targetId?: string }[] {
  return [...found.values()]
    .filter((c) => now - c.at < KEEP_MS)
    .sort((a, b) => b.at - a.at)
    .map((c) => ({
      id: c.path.id,
      firstHopName: c.path.names?.[c.path.firstHopId] ?? '',
      targetId: c.targetPersonId,
    }));
}
