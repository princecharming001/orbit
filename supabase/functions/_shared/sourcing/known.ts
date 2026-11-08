/**
 * Is a candidate found outside the network someone the student already knows (warmth tier 1)? Decided in one pass
 * over the student's own people, which run.ts loads in a single query for the whole batch: by LinkedIn slug or member
 * id, by email, else by name together with where they work. A name on its own is never enough, two people can share
 * one; and a shared university is too big to tell them apart.
 */
import type { Candidate } from './search';
import { headlineOrgs, isSchoolOrg, orgNames, orgsOf, sameOrg, siteDomain, workDomain } from './warmth';

/** One of the student's people, as the batch query returns them. */
export type KnownRow = {
  id: string;
  display_name: string;
  org_raw: string | null;
  headline: string | null;
  primary_email: string | null;
  linkedin_slug: string | null;
  linkedin_member_id: string | null;
  /** every email identity, normalized */
  emails: string[];
  /** linkedin_slug and linkedin_member identities */
  linkedin_ids: string[];
};

export interface KnownIndex {
  bySlug: Map<string, KnownRow>;
  byMember: Map<string, KnownRow>;
  byEmail: Map<string, KnownRow>;
  byName: Map<string, KnownRow[]>;
}

/** The rows by every way a candidate could name them. */
export function indexKnown(rows: KnownRow[]): KnownIndex {
  const idx: KnownIndex = { bySlug: new Map(), byMember: new Map(), byEmail: new Map(), byName: new Map() };
  const set = (m: Map<string, KnownRow>, k: string | null | undefined, r: KnownRow) => {
    if (k && !m.has(k)) m.set(k, r);
  };
  for (const r of rows) {
    set(idx.bySlug, r.linkedin_slug?.toLowerCase(), r);
    set(idx.byMember, r.linkedin_member_id, r);
    for (const id of r.linkedin_ids ?? []) {
      set(idx.bySlug, id.toLowerCase(), r);
      set(idx.byMember, id, r);
    }
    set(idx.byEmail, r.primary_email?.toLowerCase(), r);
    for (const e of r.emails ?? []) set(idx.byEmail, e.toLowerCase(), r);
    const n = r.display_name.trim().toLowerCase();
    if (n) idx.byName.set(n, [...(idx.byName.get(n) ?? []), r]);
  }
  return idx;
}

/**
 * The student's person the candidate is, or undefined. `slug` is the candidate's LinkedIn slug when it has one,
 * `email` their address normalized, `orgDomain` the domain their org is known by.
 */
export function matchKnown(
  idx: KnownIndex,
  c: Candidate,
  o: { slug?: string; email?: string; orgDomain?: string },
): KnownRow | undefined {
  const hit =
    (o.slug ? idx.bySlug.get(o.slug.toLowerCase()) : undefined) ??
    (c.memberId ? idx.byMember.get(c.memberId) : undefined) ??
    (o.email ? idx.byEmail.get(o.email.toLowerCase()) : undefined);
  if (hit) return hit;
  const same = idx.byName.get(c.name.trim().toLowerCase()) ?? [];
  if (!same.length) return undefined;
  const theirs = orgsOf(c);
  const domains = new Set(
    [workDomain(c.email), o.orgDomain, siteDomain(c.url)].filter((d): d is string => !!d),
  );
  return same.find((r) => {
    const mine = [...orgNames(r.org_raw ?? undefined), ...headlineOrgs(r.headline ?? undefined)];
    if (mine.some((m) => !isSchoolOrg(m) && theirs.some((t) => sameOrg(m, t)))) return true;
    const d =
      workDomain(r.primary_email ?? undefined) ??
      (r.emails ?? []).map((e) => workDomain(e)).find((x): x is string => !!x);
    return !!d && domains.has(d);
  });
}
