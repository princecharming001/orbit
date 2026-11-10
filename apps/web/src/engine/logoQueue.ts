/**
 * Company logos straight from LinkedIn (the student's rule: never a guessed one), for the companies the student sees.
 * Orbit keeps one shared list of LinkedIn companies for every student (orbit-connectors /companies): a company any
 * student's account has found before answers at once and costs no LinkedIn read, with its logo copied into Orbit's
 * storage so it never expires. While the app is open this queue sends, in batches, the names of companies a tile
 * showed without a LinkedIn logo (`wantCompanyLogo`, also `seenCompany`: the Map, People, Pipeline and Discover rows
 * all draw their logos through CompanyLogo, which calls it once a tile is near the screen), this visit first, then
 * those shown in the last two weeks (kept in this browser). Plan 35 B4: the rest of the network is never looked up
 * from the browser; the server fills the shared list (orbit-worker logos.sweep weekly for companies 3 or more people
 * work at across all students, and logos.user daily for every company in each student's own network), and
 * `pullKnownLogos` brings its answers to this browser for every company without a logo, for free. A LinkedIn logo link
 * that has expired counts as no logo, so it is asked for again (the answer is Orbit's own copy, which never expires). A few new companies are looked up per call,
 * from the account's own company allowance (a company page is not a profile view, so it never takes reads from
 * people). LinkedIn's company search answers only when exactly one company has the name (two "Nova"s are two
 * companies, so neither is taken); the company's LinkedIn id, public name and logo are then kept on the organisation
 * (enrichment/logos `adoptCompany`). Schools too: LinkedIn lists them like companies. The sample student's companies
 * come from the mock connector.
 */
import { normalizeCompany, type User } from '@orbit/core';
import { db } from '../db/schema';
import { mockCompanyByName } from '../integrations/connectorsMock';
import {
  type CompaniesAnswer,
  type CompanyAnswer,
  type EnrichOutcome,
  linkedInCompanies,
} from '../integrations/enrichmentProxy';
import { endActivity, startActivity } from './activity';
import { adoptCompany, dropNameMatch, logosAskedAt, markLogosAsked } from './enrichment/logos';
import { liveAccountFor } from './enrichment/sources';
import { linkedInPaused, pauseLinkedIn, readBudget } from './enrichment/store';
import { upsertOrganization } from './people';
import { isLinkedInPhoto, linkedInImageExpired } from './photos';

/** A logo that shows: Orbit's own copy, or LinkedIn's link while it lasts. */
const showsLogo = (o: { logoUrl?: string }, now: Date) =>
  !!o.logoUrl && !(isLinkedInPhoto(o.logoUrl) && linkedInImageExpired(o.logoUrl, now));

/** Names sent in one call (the shared list answers all of them; only new ones cost LinkedIn reads). */
export const LOGO_BATCH = 60;
/** The pause between calls while companies are still to be looked up: this, plus up to as much again at random. */
export const LOGO_GAP_MS = 20_000;
/** A company LinkedIn could not pin down is sent again after this long (the shared list keeps the answer meanwhile). */
export const LOGO_RETRY_MS = 14 * 86_400_000;
/** A company a tile showed stays wanted this long across visits; one never shown is never sent. */
export const LOGO_SEEN_KEEP_MS = 14 * 86_400_000;
/** The most companies kept as shown, the latest first. */
export const LOGO_SEEN_MAX = 300;
/**
 * Every company of the student's without a LinkedIn logo is asked of the shared list (free, no LinkedIn read) this
 * often: the server's daily pass (orbit-worker logos.user) fills it for their whole network, and this brings what it
 * found to this browser, not only to the tiles on screen.
 */
export const LOGO_PULL_EVERY_MS = 6 * 3_600_000;
/** A miss kept before the lookup rules changed (orbit-connectors LOOKUP_RULES_SINCE) is asked again. */
export const LOGO_RULES_SINCE = Date.parse('2026-11-10T00:00:00Z');

let jitter = () => Math.random();
/** Unit-test hook: the random share of each gap (0 to 1). */
export function setLogoJitterForTests(fn: (() => number) | undefined): void {
  jitter = fn ?? (() => Math.random());
}

/** Company names shown without a LinkedIn logo, with when they were last shown. */
const wanted = new Map<string, { name: string; at: number }>();
const listeners = new Set<() => void>();

/** A tile shows this company and has no LinkedIn logo for it: ask LinkedIn when the queue next runs. */
export function wantCompanyLogo(name: string | undefined): void {
  const key = normalizeCompany(name);
  if (!key || !name) return;
  const had = wanted.has(key);
  wanted.set(key, { name: name.trim(), at: Date.now() });
  if (!had) for (const fn of listeners) fn();
}

/** A row shows this company's logo tile (plan 35 B4's name for wantCompanyLogo). */
export const seenCompany = wantCompanyLogo;

/** Where company answers come from: Orbit's shared list through the proxy, or the demo's mock connector. */
export interface CompanySource {
  byNames(
    names: string[],
    opts?: { ids?: Record<string, string>; resolve?: number },
  ): Promise<EnrichOutcome<CompaniesAnswer>>;
}

export async function companySourceFor(user: Pick<User, 'id'>): Promise<CompanySource | undefined> {
  const live = await liveAccountFor(user);
  if (!live) return undefined;
  if (live === 'mock')
    return {
      byNames: async (names) => {
        const companies: Record<string, CompanyAnswer> = {};
        for (const n of names) {
          const c = await mockCompanyByName(n);
          companies[n] = c
            ? {
                status: 'found',
                companyId: c.id,
                publicIdentifier: c.publicIdentifier,
                name: c.name,
                logoUrl: c.logoUrl,
              }
            : { status: 'not_found' };
        }
        return { ok: true, value: { companies, pending: 0 } };
      },
    };
  const { accountId, token } = live;
  return { byNames: (names, o) => linkedInCompanies(accountId, names, { token, ...o }) };
}

type Tried = Record<string, string>;
const triedKey = (userId: string) => `logos:tried:${userId}`;
type Shown = Record<string, { name: string; at: number }>;
const seenKey = (userId: string) => `logos:seen:${userId}`;

/** The companies tiles showed, this visit merged into those kept from the last two weeks (the latest first). */
async function shownCompanies(userId: string, now: Date): Promise<[string, { name: string; at: number }][]> {
  const stored = ((await db.kv.get(seenKey(userId)))?.value as Shown | undefined) ?? {};
  const merged = new Map(Object.entries(stored));
  let changed = false;
  for (const [key, w] of wanted)
    if ((merged.get(key)?.at ?? 0) < w.at) {
      merged.set(key, w);
      changed = true;
    }
  const kept = [...merged]
    .filter(([, w]) => now.getTime() - w.at < LOGO_SEEN_KEEP_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, LOGO_SEEN_MAX);
  if (changed || kept.length !== merged.size)
    await db.kv.put({ key: seenKey(userId), value: Object.fromEntries(kept) });
  return kept;
}
const nextCall = new Map<string, number>();

export type LogoStep = 'asked' | 'idle' | 'wait' | 'paused' | 'off';

/**
 * The names to send next: those tiles asked for this visit (most recent first), then those shown in the last two
 * weeks. Never one that already has a LinkedIn logo or one LinkedIn could not pin down in the last two weeks, and
 * never a company no tile showed (plan 35 B4).
 */
async function namesToSend(
  userId: string,
  tried: Tried,
  now: Date,
): Promise<{ key: string; name: string }[]> {
  const orgs = await db.organizations.toArray();
  const asked = await logosAskedAt();
  // a LinkedIn link that has expired shows nothing: the company is asked for again (the answer is Orbit's own copy)
  const done = new Set(
    orgs
      .filter((o) => showsLogo(o, now) && o.linkedinCompanyId)
      .map((o) => o.nameNormalized || normalizeCompany(o.name)),
  );
  // a company LinkedIn answered for without a logo (by name here, or by id in the logo refresh) waits like a miss
  const since = (at: string | undefined) => Math.max(Date.parse(at ?? '1970-01-01'), 0);
  const recent = (at: string | undefined) =>
    since(at) >= LOGO_RULES_SINCE && now.getTime() - since(at) <= LOGO_RETRY_MS;
  const fresh = (key: string) => !done.has(key) && !recent(tried[key]) && !recent(asked[key]);
  const out: { key: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, name: string) => {
    if (seen.has(key) || !fresh(key)) return;
    seen.add(key);
    out.push({ key, name });
  };
  const shown = await shownCompanies(userId, now);
  for (const [key, { name }] of [...wanted.entries()].sort((a, b) => b[1].at - a[1].at)) add(key, name);
  for (const [key, { name }] of shown) add(key, name);
  return out.slice(0, LOGO_BATCH);
}

/**
 * One call: the next batch of companies without a LinkedIn logo, answered from Orbit's shared list (free) and a few
 * looked up on LinkedIn. Every found company's id, public name and logo go onto its organisation.
 */
export async function fetchLogos(
  user: Pick<User, 'id'>,
  opts: { now?: Date; source?: CompanySource } = {},
): Promise<{ step: LogoStep; found?: number; pending?: number }> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? (await companySourceFor(user));
  if (!source) return { step: 'off' };
  if (now.getTime() < (nextCall.get(user.id) ?? 0)) return { step: 'wait' };
  if (linkedInPaused(await readBudget(user.id, now), now)) return { step: 'paused' };
  const tried = ((await db.kv.get(triedKey(user.id)))?.value as Tried | undefined) ?? {};
  const batch = await namesToSend(user.id, tried, now);
  if (!batch.length) return { step: 'idle' };
  nextCall.set(user.id, now.getTime() + LOGO_GAP_MS * (1 + jitter()));
  const r = await source.byNames(
    batch.map((b) => b.name),
    { ids: await linkedInIds(batch) },
  );
  if (!r.ok) {
    if (r.reason === 'throttled') {
      await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
      return { step: 'paused' };
    }
    return { step: 'asked', found: 0 };
  }
  let found = 0;
  const answered: string[] = [];
  for (const { key, name } of batch) {
    const a = r.value.companies[name];
    if (!a) continue;
    wanted.delete(key);
    if (a.status === 'found' && a.companyId) answered.push(key);
    if (a.status !== 'found' || !a.companyId) {
      tried[key] = now.toISOString();
      // LinkedIn no longer stands by a company a name search gave this organisation: its logo goes
      await dropNameMatchesFor(key);
      continue;
    }
    const org = await upsertOrganization(name);
    if (!org) continue;
    await adoptCompany(org, factsOf(a), now);
    if (a.logoUrl) found++;
  }
  await db.kv.put({ key: triedKey(user.id), value: tried });
  await markLogosAsked(answered, now);
  // today's company reads are used: the shared list still answers, so the queue keeps going, only slower
  if (r.value.stopped === 'limit') nextCall.set(user.id, now.getTime() + 30 * 60_000);
  if (r.value.stopped === 'throttled')
    await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
  return { step: 'asked', found, pending: r.value.pending };
}

/** LinkedIn's ids for these companies, where a read profile's position named one (kept on the organisation). */
async function linkedInIds(batch: { key: string; name: string }[]): Promise<Record<string, string>> {
  const keys = new Set(batch.map((b) => b.key));
  const ids: Record<string, string> = {};
  const orgs = await db.organizations
    .where('nameNormalized')
    .anyOf([...keys])
    .toArray();
  for (const b of batch) {
    const id = orgs.find(
      (o) => o.nameNormalized === b.key && /^\d+$/.test(o.linkedinCompanyId ?? ''),
    )?.linkedinCompanyId;
    if (id) ids[b.name] = id;
  }
  return ids;
}

const pulledKey = (userId: string) => `logos:pulled:${userId}`;

/** A shared-list answer as facts for adoptCompany. */
const factsOf = (a: CompanyAnswer) => ({
  companyId: a.companyId,
  companySlug: a.publicIdentifier,
  logoUrl: a.logoUrl,
  exact: a.exact,
});

/** Every organisation of this name whose company came from a name search loses it (enrichment/logos dropNameMatch). */
async function dropNameMatchesFor(key: string): Promise<void> {
  const orgs = await db.organizations.where('nameNormalized').equals(key).toArray();
  for (const o of orgs) await dropNameMatch(o);
}

/**
 * Bring what the shared list knows to this browser for every company of the student's without a LinkedIn logo (not
 * only those a tile showed): free, no LinkedIn read, in batches of LOGO_BATCH, each company at most every
 * LOGO_PULL_EVERY_MS. Answers how many logos it put on organisations.
 */
export async function pullKnownLogos(
  user: Pick<User, 'id'>,
  opts: { now?: Date; source?: CompanySource; maxCalls?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? (await companySourceFor(user));
  if (!source) return 0;
  const pulled = ((await db.kv.get(pulledKey(user.id)))?.value as Record<string, number> | undefined) ?? {};
  const orgs = await db.organizations.toArray();
  const byKey = new Map<string, string>();
  for (const o of orgs) {
    const key = o.nameNormalized || normalizeCompany(o.name);
    if (!key || !o.name || byKey.has(key)) continue;
    // settled exactly, with Orbit's own copy of its logo (which never expires): nothing to ask. Anything a name
    // search gave is asked again, so a position that settles it later, or a name found to be shared, reaches here
    if (o.logoUrl && o.linkedinCompanyExact && !isLinkedInPhoto(o.logoUrl)) continue;
    if (now.getTime() - (pulled[key] ?? 0) < LOGO_PULL_EVERY_MS) continue;
    byKey.set(key, o.name);
  }
  // the companies the most people work at first, so a short visit still fills the rows seen most
  const keyOf = new Map(orgs.map((o) => [o.id, o.nameNormalized || normalizeCompany(o.name)] as const));
  const count = new Map<string, number>();
  await db.people.each((p) => {
    const k = p.currentOrganizationId ? keyOf.get(p.currentOrganizationId) : undefined;
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  });
  const todo = [...byKey].sort((a, b) => (count.get(b[0]) ?? 0) - (count.get(a[0]) ?? 0));
  let put = 0;
  let calls = 0;
  for (let i = 0; i < todo.length && calls < (opts.maxCalls ?? 60); i += LOGO_BATCH, calls++) {
    const batch = todo.slice(i, i + LOGO_BATCH);
    const r = await source.byNames(
      batch.map(([, name]) => name),
      { resolve: 0 },
    );
    if (!r.ok) break;
    for (const [key, name] of batch) {
      pulled[key] = now.getTime();
      const a = r.value.companies[name];
      if (!a) continue;
      if (a.status !== 'found' || !a.companyId) {
        // the shared list no longer stands by the company a name search gave: no other company's logo stays
        if (a.status === 'ambiguous' || a.status === 'not_found') await dropNameMatchesFor(key);
        continue;
      }
      const org = await upsertOrganization(name);
      if (!org) continue;
      const patch = await adoptCompany(org, factsOf(a), now);
      if (patch?.logoUrl) put++;
      wanted.delete(key);
    }
  }
  await db.kv.put({ key: pulledKey(user.id), value: pulled });
  return put;
}

let autoRun = import.meta.env.MODE !== 'test';
/** Unit-test hook: the background loop is off under vitest unless a test turns it on. */
export function setLogoQueueAutoRunForTests(on: boolean): void {
  autoRun = on;
}

export function resetLogoQueueForTests(): void {
  wanted.clear();
  nextCall.clear();
}

/** Run the queue while the app is open (a call when a tile asks, then every few seconds while names wait). */
export function startLogoQueue(user: Pick<User, 'id'>): () => void {
  if (!autoRun) return () => undefined;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    let wait = 60_000;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      busy = true;
      await pull();
      const r = await fetchLogos(user).catch(() => ({ step: 'off' as const }));
      busy = false;
      if (r.step === 'asked') startActivity('logos', 'Fetching company logos', { quiet: true });
      else if (r.step !== 'wait') endActivity('logos');
      const gap = Math.max(500, (nextCall.get(user.id) ?? 0) - Date.now());
      wait = r.step === 'asked' || r.step === 'wait' ? gap : r.step === 'idle' ? 60_000 : 10 * 60_000;
    }
    if (!stopped) schedule(wait);
  };
  // what the shared list knows, for every company without a logo: soon after the app opens, then every few hours
  let lastPull = 0;
  const pull = async () => {
    if (stopped || Date.now() - lastPull < LOGO_PULL_EVERY_MS / 6) return;
    lastPull = Date.now();
    await pullKnownLogos(user).catch(() => 0);
  };
  const onWant = () => {
    if (stopped || busy) return;
    schedule(Math.max(500, (nextCall.get(user.id) ?? 0) - Date.now()));
  };
  listeners.add(onWant);
  schedule(4000);
  return () => {
    stopped = true;
    endActivity('logos');
    listeners.delete(onWant);
    if (timer) clearTimeout(timer);
  };
}
