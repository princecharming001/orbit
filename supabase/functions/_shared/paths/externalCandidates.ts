/**
 * Outside evidence for warm paths (§4.2 steps 3–4, company step 3): Unipile mutual connections and Village v2 intro
 * paths for one target, normalized into candidate introducers plus the `orbit.ties` rows they justify (§4.1:
 * `linkedin_mutual` w 0.3 c 0.95; `village_path` w = warmth c 0.7). No ranking here: core turns these into hop
 * probabilities and routes. Each upstream answer is cached 30 days, so a repeat lookup makes no call.
 */
import { cacheKey } from '../providers/request';
import {
  cleanLinkedInUrl,
  linkedInPerson,
  type UnipileResearch,
  type UnipileSearchItem,
} from '../providers/unipileResearch';
import {
  companyIntros,
  personIntros,
  VILLAGE_COMPANY_CREDITS,
  VILLAGE_PERSON_CREDITS,
  VILLAGE_USD_PER_CREDIT,
  type Village,
  type VillageCompanyPaths,
  type VillageIntro,
  type VillagePersonPaths,
  type VillageUser,
} from '../providers/village';
import type { BudgetDep, CacheDep, Clock } from '../research/deps';

export const EXTERNAL_CACHE_MS = 30 * 86_400_000;
export const MUTUAL_WEIGHT = 0.3;
export const MUTUAL_CONFIDENCE = 0.95;
export const VILLAGE_CONFIDENCE = 0.7;

export type ExternalTarget =
  | {
      kind: 'person';
      personId?: string;
      /** LinkedIn member (provider) id, needed for mutuals */
      memberId?: string;
      /** needed for Village person paths (its API takes no name/company form) */
      linkedinUrl?: string;
      name?: string;
      company?: string;
    }
  | { kind: 'company'; domain?: string; linkedinUrl?: string; name?: string };

export interface PersonRef {
  name: string;
  linkedinUrl?: string;
  memberId?: string;
  headline?: string;
}

export interface IntroducerCandidate {
  name: string;
  linkedinUrl?: string;
  memberId?: string;
  headline?: string;
  /** the hop weight w for introducer → target (0.3 for a mutual, Village warmth 0..1) */
  warmth: number;
  source: 'linkedin_mutual' | 'village_path';
  evidence: Record<string, unknown>;
  /** the local person, when resolved */
  personId: string | null;
  target: { name?: string; linkedinUrl?: string; personId: string | null };
}

export interface TieRow {
  user_id: string;
  a_person_id: string;
  b_person_id: string;
  kind: 'linkedin_mutual' | 'village_path';
  weight: number;
  confidence: number;
  evidence: Record<string, unknown>;
  last_seen_at: string;
}

export interface ExternalDeps {
  unipile: UnipileResearch;
  village: Village;
  cache: CacheDep;
  budget?: BudgetDep;
  clock: Clock;
  /** resolve someone to a local person id (entity resolution §2); null when unknown */
  resolvePerson?: (p: PersonRef) => Promise<string | null>;
}

export interface ExternalInput {
  userId: string;
  target: ExternalTarget;
  unipileAccountId?: string;
  /** the user as Village knows them; without it Village is skipped */
  villageUser?: VillageUser;
}

export interface ExternalResult {
  candidates: IntroducerCandidate[];
  ties: TieRow[];
  unconfigured: string[];
  /** why a source was not asked, e.g. "mutuals: no member id" */
  skipped: string[];
  /** which sources answered from the 30-day cache */
  fromCache: { mutuals: boolean; village: boolean };
}

/** Gather mutuals and Village introducers for a target, and the ties to upsert. */
export async function gatherExternalCandidates(
  deps: ExternalDeps,
  input: ExternalInput,
): Promise<ExternalResult> {
  const out: ExternalResult = {
    candidates: [],
    ties: [],
    unconfigured: [],
    skipped: [],
    fromCache: { mutuals: false, village: false },
  };
  const t = input.target;
  const targetPersonId = t.kind === 'person' ? (t.personId ?? null) : null;

  const [mutuals, village] = await Promise.all([mutualsFor(deps, input, out), villageFor(deps, input, out)]);
  const resolve = async (p: PersonRef) => (deps.resolvePerson ? deps.resolvePerson(p) : null);
  const seenAt = new Date(deps.clock()).toISOString();

  if (t.kind === 'person') {
    for (const m of mutuals) {
      const p = linkedInPerson(m);
      if (!p.name) continue;
      const ref = { name: p.name, linkedinUrl: p.linkedinUrl, memberId: p.memberId, headline: p.headline };
      const personId = await resolve(ref);
      const evidence = {
        source: 'unipile',
        via: 'connections_of',
        introducer_member_id: p.memberId ?? null,
        target_member_id: t.memberId ?? null,
      };
      out.candidates.push({
        ...ref,
        warmth: MUTUAL_WEIGHT,
        source: 'linkedin_mutual',
        evidence,
        personId,
        target: { name: t.name, linkedinUrl: cleanLinkedInUrl(t.linkedinUrl), personId: targetPersonId },
      });
      pushTie(
        out,
        input.userId,
        personId,
        targetPersonId,
        'linkedin_mutual',
        MUTUAL_WEIGHT,
        MUTUAL_CONFIDENCE,
        evidence,
        seenAt,
      );
    }
  }

  for (const v of village) {
    const ref = {
      name: v.introducer.name,
      linkedinUrl: cleanLinkedInUrl(v.introducer.linkedinUrl),
      headline: v.introducer.headline,
    };
    const personId = await resolve(ref);
    const vTargetId =
      t.kind === 'person'
        ? targetPersonId
        : v.target.name
          ? await resolve({ name: v.target.name, linkedinUrl: cleanLinkedInUrl(v.target.linkedinUrl) })
          : null;
    const evidence = {
      source: 'village',
      degree: v.degree,
      score_label: v.scoreLabel ?? null,
      reasons: v.reasons,
    };
    out.candidates.push({
      ...ref,
      warmth: v.warmth,
      source: 'village_path',
      evidence,
      personId,
      target: {
        name: v.target.name ?? (t.kind === 'person' ? t.name : undefined),
        linkedinUrl: cleanLinkedInUrl(
          v.target.linkedinUrl ?? (t.kind === 'person' ? t.linkedinUrl : undefined),
        ),
        personId: vTargetId,
      },
    });
    pushTie(
      out,
      input.userId,
      personId,
      vTargetId,
      'village_path',
      v.warmth,
      VILLAGE_CONFIDENCE,
      evidence,
      seenAt,
    );
  }
  return out;
}

function pushTie(
  out: ExternalResult,
  userId: string,
  a: string | null,
  b: string | null,
  kind: TieRow['kind'],
  weight: number,
  confidence: number,
  evidence: Record<string, unknown>,
  seenAt: string,
): void {
  if (!a || !b || a === b) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const dup = out.ties.find((x) => x.a_person_id === lo && x.b_person_id === hi && x.kind === kind);
  if (dup) {
    dup.weight = Math.max(dup.weight, weight);
    return;
  }
  out.ties.push({
    user_id: userId,
    a_person_id: lo,
    b_person_id: hi,
    kind,
    weight: Math.max(0, Math.min(1, weight)),
    confidence,
    evidence,
    last_seen_at: seenAt,
  });
}

async function mutualsFor(
  deps: ExternalDeps,
  input: ExternalInput,
  out: ExternalResult,
): Promise<UnipileSearchItem[]> {
  const t = input.target;
  if (t.kind !== 'person') return [];
  if (!deps.unipile.configured) {
    out.unconfigured.push('unipile');
    return [];
  }
  if (!input.unipileAccountId) {
    out.skipped.push('mutuals: LinkedIn not connected');
    return [];
  }
  if (!t.memberId) {
    out.skipped.push("mutuals: the target's LinkedIn member id is unknown");
    return [];
  }
  const key = await cacheKey('unipile', {
    // v2: lists saved before 2026-10-25 came from a search LinkedIn did not filter
    op: 'mutuals2',
    accountId: input.unipileAccountId,
    memberId: t.memberId,
  });
  const hit = (await deps.cache.get(input.userId, key)) as { items: UnipileSearchItem[] } | undefined;
  if (hit) {
    out.fromCache.mutuals = true;
    return hit.items;
  }
  const r = await deps.unipile.mutuals(input.unipileAccountId, t.memberId);
  if (!r.ok) {
    out.skipped.push(`mutuals: ${r.message}`);
    return [];
  }
  await deps.cache.put(input.userId, {
    key,
    provider: 'unipile',
    response: { items: r.value },
    expiresAt: new Date(deps.clock() + EXTERNAL_CACHE_MS),
  });
  return r.value;
}

async function villageFor(
  deps: ExternalDeps,
  input: ExternalInput,
  out: ExternalResult,
): Promise<VillageIntro[]> {
  const t = input.target;
  if (!deps.village.configured) {
    out.unconfigured.push('village');
    return [];
  }
  if (!input.villageUser) {
    out.skipped.push('village: no Village user');
    return [];
  }
  let op: 'people/paths' | 'companies/paths';
  let q: Record<string, string>;
  if (t.kind === 'person') {
    const url = cleanLinkedInUrl(t.linkedinUrl);
    if (!url) {
      out.skipped.push('village: needs the LinkedIn URL');
      return [];
    }
    op = 'people/paths';
    q = { linkedin_url: url };
  } else {
    if (t.domain) q = { domain: t.domain.replace(/^www\./i, '').toLowerCase() };
    else if (t.linkedinUrl) q = { linkedin_url: t.linkedinUrl };
    else {
      out.skipped.push('village: needs the company domain');
      return [];
    }
    op = 'companies/paths';
  }
  const key = await cacheKey('village', { op, user: input.villageUser.externalUserId, q });
  const hit = (await deps.cache.get(input.userId, key)) as
    | { kind: 'person'; data: VillagePersonPaths }
    | { kind: 'company'; data: VillageCompanyPaths }
    | undefined;
  if (hit) {
    out.fromCache.village = true;
    return hit.kind === 'person' ? personIntros(hit.data) : companyIntros(hit.data);
  }
  const credits = op === 'people/paths' ? VILLAGE_PERSON_CREDITS : VILLAGE_COMPANY_CREDITS;
  if (deps.budget) {
    const v = await deps.budget.check(input.userId, 'village', credits);
    if (!v.ok) {
      out.skipped.push('village: budget_exceeded');
      return [];
    }
  }
  let entry: { kind: 'person'; data: VillagePersonPaths } | { kind: 'company'; data: VillageCompanyPaths };
  if (op === 'people/paths') {
    const r = await deps.village.personPaths(input.villageUser, q as { linkedin_url: string });
    if (!r.ok) {
      out.skipped.push(`village: ${r.message}`);
      return [];
    }
    entry = { kind: 'person', data: r.value };
  } else {
    const r = await deps.village.companyPaths(
      input.villageUser,
      'domain' in q ? { domain: q.domain!, limit: 25 } : { linkedin_url: q.linkedin_url!, limit: 25 },
    );
    if (!r.ok) {
      out.skipped.push(`village: ${r.message}`);
      return [];
    }
    entry = { kind: 'company', data: r.value };
  }
  await deps.budget?.record(input.userId, {
    provider: 'village',
    operation: op,
    units: credits,
    costUsd: credits * VILLAGE_USD_PER_CREDIT,
  });
  await deps.cache.put(input.userId, {
    key,
    provider: 'village',
    response: entry,
    expiresAt: new Date(deps.clock() + EXTERNAL_CACHE_MS),
  });
  return entry.kind === 'person' ? personIntros(entry.data) : companyIntros(entry.data);
}
