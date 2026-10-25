/**
 * Company logos straight from LinkedIn (the student's rule: never a guessed one). A company tile that has no LinkedIn
 * logo yet asks for one (`wantCompanyLogo`); while the app is open, this queue looks each company up on LinkedIn by its
 * name, a few a minute and a bounded number a day, most recently shown first. LinkedIn's company search answers only
 * when exactly one company there has that name (two "Nova"s are two companies, so neither is taken); the company's
 * LinkedIn id, public name and logo are then kept on the organisation (enrichment/logos `adoptCompany`), and every
 * tile of that name shows it. A company LinkedIn cannot pin down is asked about again after two weeks; until then its
 * tile shows its initials. The sample student's companies come from the mock connector.
 */
import { normalizeCompany, type User } from '@orbit/core';
import { db } from '../db/schema';
import { mockCompanyByName, usesMockConnectors } from '../integrations/connectorsMock';
import {
  type EnrichOutcome,
  type LinkedInCompany,
  linkedInCompanyByName,
} from '../integrations/enrichmentProxy';
import { isServerUser } from '../integrations/orbitApi';
import { unipileConfigured } from '../integrations/unipile';
import { endActivity, startActivity } from './activity';
import { adoptCompany } from './enrichment/logos';
import { linkedInPaused, pauseLinkedIn, readBudget } from './enrichment/store';
import { liveLinkedInAccount } from './linkedinLive';
import { upsertOrganization } from './people';

/** Calls a minute, evenly spaced (each is a LinkedIn search and a company page). */
export const LOGOS_PER_MINUTE = 3;
export const LOGOS_PER_DAY = 30;
/** A company LinkedIn could not pin down is asked about again after this long. */
export const LOGO_RETRY_MS = 14 * 86_400_000;
const GAP_MS = 60_000 / LOGOS_PER_MINUTE;

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

/** Where company pages come from: LinkedIn through the proxy, or the demo's mock connector. */
export interface CompanySource {
  byName(name: string): Promise<EnrichOutcome<LinkedInCompany>>;
}

export async function companySourceFor(user: Pick<User, 'id'>): Promise<CompanySource | undefined> {
  if (isServerUser(user.id)) return undefined;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  if (usesMockConnectors(user.id))
    return {
      byName: async (name) => {
        const c = await mockCompanyByName(name);
        return c ? { ok: true, value: c } : { ok: false, reason: 'not_found', message: 'Not in the demo.' };
      },
    };
  if (!unipileConfigured() || !row.accessToken) return undefined;
  const accountId = row.externalAccountId;
  const token = row.accessToken;
  return { byName: (name) => linkedInCompanyByName(accountId, name, { token }) };
}

type Tried = Record<string, string>;
const triedKey = (userId: string) => `logos:tried:${userId}`;
const dayKey = (userId: string) => `logos:day:${userId}`;
const lastCall = new Map<string, number>();

export type LogoStep = 'asked' | 'idle' | 'wait' | 'paused' | 'off';

/** One tick: the most recently shown company still without a LinkedIn logo, when pace and allowance let it. */
export async function fetchOneLogo(
  user: Pick<User, 'id'>,
  opts: { now?: Date; source?: CompanySource } = {},
): Promise<{ step: LogoStep; name?: string }> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? (await companySourceFor(user));
  if (!source) return { step: 'off' };
  if (now.getTime() - (lastCall.get(user.id) ?? 0) < GAP_MS) return { step: 'wait' };
  if (linkedInPaused(await readBudget(user.id, now), now)) return { step: 'paused' };
  const day = now.toISOString().slice(0, 10);
  const v = (await db.kv.get(dayKey(user.id)))?.value as { day?: string; used?: number } | undefined;
  const used = v?.day === day ? (v.used ?? 0) : 0;
  if (used >= LOGOS_PER_DAY) return { step: 'paused' };
  const tried = ((await db.kv.get(triedKey(user.id)))?.value as Tried | undefined) ?? {};
  const orgs = await db.organizations.toArray();
  const hasLogo = new Set(
    orgs
      .filter((o) => o.logoUrl && o.linkedinCompanyId)
      .map((o) => o.nameNormalized || normalizeCompany(o.name)),
  );
  const next = [...wanted.entries()]
    .filter(
      ([key]) => !hasLogo.has(key) && now.getTime() - Date.parse(tried[key] ?? '1970-01-01') > LOGO_RETRY_MS,
    )
    .sort((a, b) => b[1].at - a[1].at)[0];
  if (!next) return { step: 'idle' };
  const [key, { name }] = next;
  wanted.delete(key);
  lastCall.set(user.id, now.getTime());
  tried[key] = now.toISOString();
  await db.kv.put({ key: triedKey(user.id), value: tried });
  await db.kv.put({ key: dayKey(user.id), value: { day, used: used + 1 } });
  const r = await source.byName(name);
  if (!r.ok) {
    if (r.reason === 'throttled') {
      await pauseLinkedIn(user.id, now, 'LinkedIn asked Orbit to slow down. It carries on tomorrow.');
      return { step: 'paused', name };
    }
    if (r.reason === 'limit') {
      await db.kv.put({ key: dayKey(user.id), value: { day, used: LOGOS_PER_DAY } });
      return { step: 'paused', name };
    }
    return { step: 'asked', name };
  }
  const org = await upsertOrganization(name);
  if (org)
    await adoptCompany(
      org,
      { companyId: r.value.id, companySlug: r.value.publicIdentifier, logoUrl: r.value.logoUrl },
      now,
    );
  return { step: 'asked', name };
}

let autoRun = import.meta.env.MODE !== 'test';
/** Unit-test hook: the background loop is off under vitest unless a test turns it on. */
export function setLogoQueueAutoRunForTests(on: boolean): void {
  autoRun = on;
}

export function resetLogoQueueForTests(): void {
  wanted.clear();
  lastCall.clear();
}

/** Run the queue while the app is open (a tick when a tile asks, every few seconds while names wait). */
export function startLogoQueue(user: Pick<User, 'id'>): () => void {
  if (!autoRun || isServerUser(user.id)) return () => undefined;
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
      const r = await fetchOneLogo(user).catch(() => ({ step: 'off' as const }));
      busy = false;
      if (r.step === 'asked') startActivity('logos', 'Fetching company logos', { quiet: true });
      else if (r.step !== 'wait') endActivity('logos');
      wait = r.step === 'asked' || r.step === 'wait' ? GAP_MS : r.step === 'idle' ? 60_000 : 10 * 60_000;
    }
    if (!stopped) schedule(wait);
  };
  const onWant = () => {
    if (stopped || busy) return;
    schedule(Math.max(500, (lastCall.get(user.id) ?? 0) + GAP_MS - Date.now()));
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
