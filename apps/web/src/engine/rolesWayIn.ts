/**
 * Plan 45 §3 and §4.3: the way into a company with an open role, and the next step there, done where the role is
 * open. Who the student knows there and the alumni come from `pathsFor` at once; intros (a person they know who knows
 * someone there) need the reach graph, read here in the background for the companies on screen and kept for the
 * visit. The actions write the message and return it, so the role's pane shows it under the person: a referral ask
 * to someone they know, a first message to an alum, an intro request through a friend.
 */
import { normalizeCompany, type OutboundMessage, type RoleMatch, type User } from '@orbit/core';
import { db } from '../db/schema';
import { composeDraft, requestIntro } from './drafts';
import { reachCompany } from './graph';
import type { RoleIntro } from './roles';
import { addTarget } from './targets';

/** The companies whose intros are read in one visit: past this, the slowest part (one reach per company) waits. */
export const INTRO_COMPANIES = 40;
/** Intros kept per company: the best few routes. */
const PER_COMPANY = 3;

const cache = new Map<string, Promise<RoleIntro[]>>();
const keyOf = (userId: string, company: string) => `${userId}:${normalizeCompany(company)}`;

/** Forget what was read (a test, or the student's network changed a lot). */
export function forgetIntros(): void {
  cache.clear();
}

/** The intros at one company, best first: read once a visit. */
export function introsAt(userId: string, company: string): Promise<RoleIntro[]> {
  const k = keyOf(userId, company);
  let p = cache.get(k);
  if (!p) {
    p = readIntros(userId, company).catch(() => []);
    cache.set(k, p);
  }
  return p;
}

async function readIntros(userId: string, company: string): Promise<RoleIntro[]> {
  const r = await reachCompany(userId, company);
  const warm = r.people
    .filter((c) => c.route.kind === 'warm' && c.route.via)
    .sort((a, b) => b.route.score - a.route.score)
    .slice(0, PER_COMPANY);
  const vias = await db.people.bulkGet(warm.map((c) => c.route.via!.id));
  return warm.map((c, i) => ({
    via: { id: c.route.via!.id, name: c.route.via!.name, photoUrl: vias[i]?.photoUrl },
    to: {
      id: c.person.id,
      name: c.person.displayName,
      photoUrl: c.person.photoUrl,
      title: c.person.currentTitle,
    },
    score: c.route.score,
    hops: c.route.path?.hops,
  }));
}

/**
 * The intros for the companies named, keyed by normalized name: the first INTRO_COMPANIES in the order given (the
 * order the list shows them), one at a time so the page stays quick. `onEach` hears each company as it is read.
 */
export async function introsFor(
  userId: string,
  companies: string[],
  onEach?: (key: string, intros: RoleIntro[]) => void,
): Promise<Map<string, RoleIntro[]>> {
  const out = new Map<string, RoleIntro[]>();
  const seen = new Set<string>();
  for (const c of companies) {
    const k = normalizeCompany(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (seen.size > INTRO_COMPANIES) break;
    const got = await introsAt(userId, c);
    out.set(k, got);
    onEach?.(k, got);
  }
  return out;
}

/** What an action in the pane gives back: the message written, or why there is none. */
export type WayInResult =
  | { kind: 'draft'; draft: OutboundMessage }
  | { kind: 'warmup'; text: string }
  | { kind: 'failed'; text: string };

/** The role becomes the company's target role, so the message names it (the referral ask reads it from there). */
async function holdRole(user: User, m: RoleMatch): Promise<void> {
  const j = m.job;
  await addTarget(user.id, j.companyName, {
    role: j.title,
    team: j.team,
    postingUrl: j.url || undefined,
    postingSeenAt: j.url ? new Date().toISOString() : undefined,
  });
}

/** Someone the student knows there: ask them for a referral for this role. */
export async function askReferral(user: User, m: RoleMatch, personId: string): Promise<WayInResult> {
  await holdRole(user, m);
  const r = await composeDraft(user, personId, 'referral_ask');
  if (r.kind === 'draft') return { kind: 'draft', draft: r.draft };
  return { kind: 'failed', text: 'Orbit could not write that message. Try again from their page.' };
}

/** An alum there, or anyone the student would write to first: a first message. */
export async function writeFirst(user: User, m: RoleMatch, personId: string): Promise<WayInResult> {
  await holdRole(user, m);
  const r = await composeDraft(user, personId, 'outreach', { confirmed: true });
  if (r.kind === 'draft') return { kind: 'draft', draft: r.draft };
  if (r.kind === 'warmup_started')
    return { kind: 'warmup', text: 'Warm-up started. Orbit sends the first message when it is ready.' };
  return { kind: 'failed', text: 'Orbit could not write that message. Try again from their page.' };
}

/** No one there, but a friend knows someone: ask the friend for an intro, naming the role. */
export async function askIntroForRole(user: User, m: RoleMatch, intro: RoleIntro): Promise<WayInResult> {
  await holdRole(user, m);
  const r = await requestIntro(user, intro.via.id, intro.to.id, {
    path: { score: intro.score, hops: intro.hops },
    posting: { role: m.job.title, team: m.job.team },
  });
  if (r?.draft) return { kind: 'draft', draft: r.draft };
  if (r) return { kind: 'failed', text: 'The intro request is in Drafts, still being written.' };
  return { kind: 'failed', text: 'Orbit could not find one of them to write the intro request.' };
}
