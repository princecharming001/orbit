/**
 * Company logos straight from LinkedIn (the student's rule: never a guessed one), for a whole network. Orbit keeps one
 * shared list of LinkedIn companies for every student (orbit-connectors /companies): a company any student's account
 * has found before answers at once and costs no LinkedIn read, with its logo copied into Orbit's storage so it never
 * expires. While the app is open this queue sends the names still without a LinkedIn logo in batches: the companies
 * tiles on screen asked for first (`wantCompanyLogo`, most recent first), then every company in the student's
 * network, the ones most people work at first. A few new companies are looked up per call, from the account's own
 * company allowance (a company page is not a profile view, so it never takes reads from people). LinkedIn's company
 * search answers only when exactly one company has the name (two "Nova"s are two companies, so neither is taken);
 * the company's LinkedIn id, public name and logo are then kept on the organisation (enrichment/logos `adoptCompany`).
 * Schools are left to their own site icons. The sample student's companies come from the mock connector.
 */
import { looksLikeSchool, normalizeCompany, type User } from '@orbit/core';
import { db } from '../db/schema';
import { mockCompanyByName } from '../integrations/connectorsMock';
import {
  type CompaniesAnswer,
  type CompanyAnswer,
  type EnrichOutcome,
  linkedInCompanies,
} from '../integrations/enrichmentProxy';
import { endActivity, startActivity } from './activity';
import { adoptCompany } from './enrichment/logos';
import { liveAccountFor } from './enrichment/sources';
import { linkedInPaused, pauseLinkedIn, readBudget } from './enrichment/store';
import { upsertOrganization } from './people';

/** Names sent in one call (the shared list answers all of them; only new ones cost LinkedIn reads). */
export const LOGO_BATCH = 60;
/** The pause between calls while companies are still to be looked up: this, plus up to as much again at random. */
export const LOGO_GAP_MS = 20_000;
/** A company LinkedIn could not pin down is sent again after this long (the shared list keeps the answer meanwhile). */
export const LOGO_RETRY_MS = 14 * 86_400_000;

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

/** Where company answers come from: Orbit's shared list through the proxy, or the demo's mock connector. */
export interface CompanySource {
  byNames(names: string[]): Promise<EnrichOutcome<CompaniesAnswer>>;
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
  return { byNames: (names) => linkedInCompanies(accountId, names, { token }) };
}

type Tried = Record<string, string>;
const triedKey = (userId: string) => `logos:tried:${userId}`;
const nextCall = new Map<string, number>();

export type LogoStep = 'asked' | 'idle' | 'wait' | 'paused' | 'off';

/**
 * The names to send next: those tiles asked for (most recent first), then the companies people in the network work
 * at, most people first. Never one that already has a LinkedIn logo, a school (its site icon stands in), or one
 * LinkedIn could not pin down in the last two weeks.
 */
async function namesToSend(
  userId: string,
  tried: Tried,
  now: Date,
): Promise<{ key: string; name: string }[]> {
  const orgs = await db.organizations.toArray();
  const done = new Set(
    orgs
      .filter((o) => o.logoUrl && o.linkedinCompanyId)
      .map((o) => o.nameNormalized || normalizeCompany(o.name)),
  );
  const fresh = (key: string) =>
    !done.has(key) && now.getTime() - Date.parse(tried[key] ?? '1970-01-01') > LOGO_RETRY_MS;
  const out: { key: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, name: string) => {
    if (seen.has(key) || !fresh(key) || looksLikeSchool(name)) return;
    seen.add(key);
    out.push({ key, name });
  };
  for (const [key, { name }] of [...wanted.entries()].sort((a, b) => b[1].at - a[1].at)) add(key, name);
  if (out.length < LOGO_BATCH) {
    const count = new Map<string, { name: string; n: number }>();
    await db.people
      .where('userId')
      .equals(userId)
      .each((p) => {
        if (p.hiddenAt || !p.currentOrganizationRaw) return;
        const key = normalizeCompany(p.currentOrganizationRaw);
        if (!key) return;
        const c = count.get(key);
        if (c) c.n++;
        else count.set(key, { name: p.currentOrganizationRaw.trim(), n: 1 });
      });
    for (const [key, { name }] of [...count.entries()].sort((a, b) => b[1].n - a[1].n)) {
      if (out.length >= LOGO_BATCH) break;
      add(key, name);
    }
  }
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
  const r = await source.byNames(batch.map((b) => b.name));
  if (!r.ok) {
    if (r.reason === 'throttled') {
      await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
      return { step: 'paused' };
    }
    return { step: 'asked', found: 0 };
  }
  let found = 0;
  for (const { key, name } of batch) {
    const a = r.value.companies[name];
    if (!a) continue;
    wanted.delete(key);
    if (a.status !== 'found' || !a.companyId) {
      tried[key] = now.toISOString();
      continue;
    }
    const org = await upsertOrganization(name);
    if (!org) continue;
    await adoptCompany(
      org,
      { companyId: a.companyId, companySlug: a.publicIdentifier, logoUrl: a.logoUrl },
      now,
    );
    if (a.logoUrl) found++;
  }
  await db.kv.put({ key: triedKey(user.id), value: tried });
  // today's company reads are used: the shared list still answers, so the queue keeps going, only slower
  if (r.value.stopped === 'limit') nextCall.set(user.id, now.getTime() + 30 * 60_000);
  if (r.value.stopped === 'throttled')
    await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
  return { step: 'asked', found, pending: r.value.pending };
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
      const r = await fetchLogos(user).catch(() => ({ step: 'off' as const }));
      busy = false;
      if (r.step === 'asked') startActivity('logos', 'Fetching company logos', { quiet: true });
      else if (r.step !== 'wait') endActivity('logos');
      const gap = Math.max(500, (nextCall.get(user.id) ?? 0) - Date.now());
      wait = r.step === 'asked' || r.step === 'wait' ? gap : r.step === 'idle' ? 60_000 : 10 * 60_000;
    }
    if (!stopped) schedule(wait);
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
