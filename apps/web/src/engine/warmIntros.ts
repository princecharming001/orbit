/**
 * Warm intros: real intro paths to a person or a company from Village (integrations/village.ts), with how warm each
 * is and the hops in words, matched to the people Orbit knows so the app can act on them ("Ask Mia for an intro").
 * The sample student's paths come from the demo graph (integrations/connectorsMock.ts). When Village is off (not in
 * the build, or the student has not turned it on), not set up on Orbit's server, or has nothing, this returns an
 * empty list and Orbit's own routes stand alone; Settings reads `villageHealth` to say which.
 *
 * One lookup per target is shared for a few minutes, so the Map's warm intros and its routes (engine/graph.ts
 * `reachPerson`, which adds Village introducers as candidates) ask Village once.
 */
import type { Person, User } from '@orbit/core';
import { linkedInSlug, normalizeCompany, normalizeLinkedInUrl } from '@orbit/core';
import { db } from '../db/schema';
import { mockVillagePaths, usesMockConnectors } from '../integrations/connectorsMock';
import { readPrefs, writePrefs } from '../integrations/prefs';
import { type VillagePath, villageConfigured, villageLookup } from '../integrations/village';

export type WarmthWord = 'warm' | 'good' | 'a stretch';

/** How warm a path is, in a word rather than a number. */
export function warmthWord(warmth: number): WarmthWord {
  if (warmth >= 0.7) return 'warm';
  if (warmth >= 0.45) return 'good';
  return 'a stretch';
}

export interface WarmIntro {
  introducer: { name: string; headline?: string; linkedinUrl?: string; personId?: string };
  /** 0 to 1, higher is warmer (kept for sorting; say `warmthWord` to people) */
  warmth: number;
  warmthWord: WarmthWord;
  /** the chain in words, starting with "You" */
  hops: string[];
  note?: string;
  /** the Orbit person the intro would be to, when known (a company path names someone there) */
  targetPersonId?: string;
  source: 'village' | 'demo';
}

/**
 * Warm intros are on: the student turned them on and Village is in the build, or this is the sample student. A
 * route lookup sends the target's name and company to Village, so it is the student's choice (Settings,
 * Integrations).
 */
export function villageAvailable(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || (villageConfigured() && readPrefs().warmIntros === true);
}

/** Warm intros can be turned on here: Village is in the build, or this is the sample student (always on). */
export function villageOffered(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || villageConfigured();
}

/** Turn warm intros on or off for this browser. */
export function setWarmIntros(on: boolean): void {
  writePrefs({ warmIntros: on });
}

const SHARE_MS = 5 * 60_000;
const shared = new Map<string, { at: number; p: Promise<VillagePath[] | undefined> }>();

/** tests only */
export function resetWarmIntrosCache(): void {
  shared.clear();
}

/** Village's paths to a target, one request shared by every caller for a few minutes; undefined when it failed. */
function sharedLookup(
  key: string,
  target: { name?: string; company?: string; linkedinUrl?: string },
): Promise<VillagePath[] | undefined> {
  const now = Date.now();
  const hit = shared.get(key);
  if (hit && now - hit.at < SHARE_MS) return hit.p;
  const p = villageLookup(target).then((r) => {
    // a failure is not kept: the next look asks again
    if (!r.ok) shared.delete(key);
    return r.ok ? r.value : undefined;
  });
  shared.set(key, { at: now, p });
  return p;
}

/** Warm intro paths to a person or a company, warmest first. Never throws; empty when there are none. */
export async function warmIntrosFor(
  user: Pick<User, 'id'>,
  target: { person?: Person; company?: string },
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<WarmIntro[]> {
  const limit = opts.limit ?? 4;
  try {
    if (usesMockConnectors(user.id)) {
      const paths = await mockVillagePaths(
        user.id,
        target.person ? { personId: target.person.id } : { company: target.company },
        limit,
      );
      return paths.map((p) => ({
        introducer: { ...p.introducer, personId: p.introducerId },
        warmth: p.warmth,
        warmthWord: warmthWord(p.warmth),
        hops: p.hops,
        note: p.note,
        targetPersonId: p.targetPersonId,
        source: 'demo' as const,
      }));
    }
    if (!villageAvailable(user)) return [];
    const company = target.person?.currentOrganizationRaw ?? target.company;
    const paths =
      (await sharedLookup(
        target.person ? `${user.id}|p:${target.person.id}` : `${user.id}|c:${normalizeCompany(company)}`,
        target.person
          ? { name: target.person.displayName, company, linkedinUrl: target.person.linkedinUrl }
          : { company },
      )) ?? [];
    if (opts.signal?.aborted || !paths.length) return [];
    const people = await db.people.where('userId').equals(user.id).toArray();
    const find = (name: string | undefined, url?: string): Person | undefined => {
      const slug = linkedInSlug(normalizeLinkedInUrl(url));
      if (slug) {
        const p = people.find((x) => x.linkedinSlug === slug);
        if (p) return p;
      }
      const n = name?.trim().toLowerCase();
      const same = n ? people.filter((x) => x.nameNormalized === n && !x.hiddenAt) : [];
      return same.length === 1 ? same[0] : undefined;
    };
    const norm = normalizeCompany(company);
    return paths.slice(0, limit).map((p) => {
      const intro = find(p.introducer.name, p.introducer.linkedinUrl);
      // a company path's last named hop is the person there, when Orbit knows them
      const named = p.hops.filter((h) => h && h !== 'You');
      const last = target.person ? undefined : find(named[named.length - 1]);
      const there =
        last && (!norm || normalizeCompany(last.currentOrganizationRaw) === norm) ? last : undefined;
      return {
        introducer: { ...p.introducer, personId: intro?.id },
        warmth: p.warmth,
        warmthWord: warmthWord(p.warmth),
        hops: p.hops.length
          ? p.hops
          : ['You', p.introducer.name, target.person?.displayName ?? company ?? ''],
        note: p.note,
        targetPersonId: target.person?.id ?? (there && there.id !== intro?.id ? there.id : undefined),
        source: 'village' as const,
      };
    });
  } catch {
    return [];
  }
}
