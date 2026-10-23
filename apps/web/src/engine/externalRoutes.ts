/**
 * Ways in from outside Orbit's own records, for route finding in the browser (plan 17 §C): the target's LinkedIn
 * mutuals (the student's first-degree connections LinkedIn says are connected to them) and Village's introducers,
 * each matched to a person Orbit has and handed to core's rankWarmPaths as an ExternalCandidate (engine/graph.ts
 * `reachPerson`). A mutual's first hop is scored by the student's own tie to that mutual; core keeps every mutual,
 * labelled a weaker route when it is one.
 *
 * LinkedIn is asked once per target per day (engine/linkedinLive.ts `mutualsFor` keeps the answer in db.kv), and a
 * lookup in flight is shared, so the Map's routes and its "People who know them" panel make one request. A target
 * Orbit knows by LinkedIn profile name (from the export) but not by member id is looked up by name once a day; the
 * member id found is kept, so the next lookups go straight to the mutuals.
 *
 * The sample student's mutuals come from the demo (integrations/connectorsMock.ts). Its mock Village paths are built
 * from these routes, so they are not fed back in as candidates.
 */
import type { ExternalCandidate, Person, User } from '@orbit/core';
import { hasRealName, linkedInSlug, normalizeLinkedInUrl } from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { searchLinkedIn, unipileConfigured } from '../integrations/unipile';
import { updateEdgesFor } from './graph';
import { liveLinkedInAccount, type MutualsResult, mutualsFor } from './linkedinLive';
import { freshPhoto } from './photos';
import { villageAvailable, warmIntrosFor } from './warmIntros';

/** How long route finding waits for LinkedIn's mutuals before answering with what Orbit has. */
export const MUTUALS_WAIT_MS = 12_000;

/** db.kv key prefix: the day a target's member id was last looked up by name (once a day at most). */
const MEMBER_LOOKUP_KV = 'memberid:tried:';

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The target with their LinkedIn member id, which mutual lookups need. Someone imported from the LinkedIn export
 * has only their profile name (slug): LinkedIn is searched by their name and the result with the same profile is
 * theirs, never a namesake. The id is kept on the person, and their edges are brought up to date.
 */
export async function withMemberId(
  user: Pick<User, 'id'>,
  person: Person,
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<Person> {
  if (person.linkedinMemberId || usesMockConnectors(user.id) || !unipileConfigured()) return person;
  const slug = person.linkedinSlug ?? linkedInSlug(normalizeLinkedInUrl(person.linkedinUrl));
  if (!slug || !hasRealName(person)) return person;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId || !row.accessToken) return person;
  const key = `${MEMBER_LOOKUP_KV}${user.id}:${person.id}`;
  const day = dayOf(opts.now ?? new Date());
  if ((await db.kv.get(key))?.value === day) return person;
  await db.kv.put({ key, value: day });
  const r = await searchLinkedIn(
    row.externalAccountId,
    { keywords: `${person.firstName} ${person.lastName}`.trim(), distance: [1, 2, 3] },
    { token: row.accessToken, signal: opts.signal },
  );
  if (!r.ok) return person;
  const hit = r.value.people.find((f) => linkedInSlug(normalizeLinkedInUrl(f.profileUrl)) === slug);
  if (!hit?.memberId) return person;
  const photoUrl = freshPhoto(person.photoUrl, hit.pictureUrl);
  await db.people.update(person.id, { linkedinMemberId: hit.memberId, photoUrl });
  await updateEdgesFor(user.id, [person.id]);
  return { ...person, linkedinMemberId: hit.memberId, photoUrl };
}

const inflight = new Map<string, Promise<MutualsResult>>();

/** tests only */
export function resetTargetMutualsForTests(): void {
  inflight.clear();
}

/**
 * The target's LinkedIn mutuals, each matched to the Orbit person it is when Orbit has them. One lookup at a time per
 * target, shared by every caller; LinkedIn is given MUTUALS_WAIT_MS before this answers with an error.
 */
export function targetMutuals(user: User, person: Person, opts: { now?: Date } = {}): Promise<MutualsResult> {
  const key = `${user.id}:${person.id}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async (): Promise<MutualsResult> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MUTUALS_WAIT_MS);
    try {
      const target = await withMemberId(user, person, { now: opts.now, signal: ctrl.signal });
      const r = await mutualsFor(user, target, { signal: ctrl.signal, now: opts.now });
      if (!r.ok && ctrl.signal.aborted)
        return { ...r, reason: 'error', message: 'LinkedIn took too long to answer. Try again.' };
      return r;
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        message: e instanceof Error ? e.message : 'Could not reach LinkedIn.',
        mutuals: [],
      };
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Route candidates for one target: every LinkedIn mutual Orbit has as a person, and every Village introducer Orbit
 * has, with Village's warmth. Never throws.
 */
export async function externalCandidates(
  user: User,
  target: Person,
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<ExternalCandidate[]> {
  const seenAt = (opts.now ?? new Date()).toISOString();
  const [mutuals, intros] = await Promise.all([
    targetMutuals(user, target, opts).catch(() => undefined),
    // the demo's Village paths are made from reachPerson's own routes: nothing new, and it would loop
    !usesMockConnectors(user.id) && villageAvailable(user)
      ? warmIntrosFor(user, { person: target }, { limit: 10, signal: opts.signal }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const out: ExternalCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: ExternalCandidate) => {
    const key = `${c.kind}:${c.introducerId}`;
    if (c.introducerId === target.id || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  if (mutuals?.ok)
    for (const m of mutuals.mutuals)
      if (m.personId) add({ introducerId: m.personId, kind: 'linkedin_mutual', seenAt });
  for (const w of intros)
    if (w.introducer.personId)
      add({ introducerId: w.introducer.personId, kind: 'village_path', warmth: w.warmth, seenAt });
  return out;
}
