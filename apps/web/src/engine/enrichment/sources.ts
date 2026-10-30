/**
 * Where enrichment reads LinkedIn and the web from: the student's own LinkedIn through Orbit's proxy (live), or the
 * demo's mock connector for the sample student, behind one small interface so the waterfall does not care which.
 */
import type { User } from '@orbit/core';
import { db } from '../../db/schema';
import {
  mockLinkedInCompany,
  mockLinkedInProfile,
  mockLinkedInSearch,
  usesMockConnectors,
} from '../../integrations/connectorsMock';
import {
  type EnrichOutcome,
  enrichmentProviders,
  type LinkedInCompany,
  type LinkedInProfile,
  linkedInCompany,
  linkedInProfile,
  type ProviderStatus,
} from '../../integrations/enrichmentProxy';
import { callApi, isServerUser } from '../../integrations/orbitApi';
import { type LinkedInFound, unipileConfigured, unipileProxyCall } from '../../integrations/unipile';

export interface LinkedInSource {
  kind: 'live' | 'mock';
  /** `shared`: only what anyone would see is needed, so a copy another student's account read today will do;
   * `recommendations`: also who recommended them, in the same read */
  profile(
    identifier: string,
    sections: string[],
    opts?: { shared?: boolean; recommendations?: boolean },
  ): Promise<EnrichOutcome<LinkedInProfile>>;
  company(identifier: string): Promise<EnrichOutcome<LinkedInCompany>>;
  /** a people search by keywords across 1st, 2nd and 3rd degree */
  search(keywords: string): Promise<EnrichOutcome<LinkedInFound[]>>;
}

/** Why there is no LinkedIn to read from: not connected, or Orbit's server could not say. */
export type NoLinkedIn = 'not_connected' | 'unavailable';

let readerCache:
  | { userId: string; at: number; value?: { accountId: string; token: string }; why?: NoLinkedIn }
  | undefined;
const READER_TTL_MS = 30 * 60_000;

/**
 * An Orbit account's LinkedIn, as its browser reads it: the server hands over the student's own account id and the
 * token orbit-connectors checks (POST /linkedin/reader), so a page they open reads that person's work history and the
 * logo queue looks companies up, through the same proxy as an account kept in a browser. Asked again every half hour.
 */
export async function accountLinkedInReader(
  userId: string,
): Promise<{ accountId: string; token: string } | NoLinkedIn> {
  const now = Date.now();
  if (readerCache?.userId === userId && now - readerCache.at < READER_TTL_MS)
    return readerCache.value ?? readerCache.why ?? 'unavailable';
  const r = await callApi('/linkedin/reader', {}).catch(() => undefined);
  if (r?.ok && r.value.ok) {
    readerCache = { userId, at: now, value: { accountId: r.value.accountId, token: r.value.token } };
    return readerCache.value!;
  }
  const why: NoLinkedIn =
    r?.ok && !r.value.ok && r.value.reason === 'not_connected' ? 'not_connected' : 'unavailable';
  // an answer that it is not connected is kept; a failed call is asked again on the next page opened
  readerCache = why === 'not_connected' ? { userId, at: now, why } : undefined;
  return why;
}

/** Unit-test hook: forget the account's reader. */
export function forgetAccountLinkedInReader(): void {
  readerCache = undefined;
}

/** The student's LinkedIn for enrichment, or undefined when it is not connected live. */
export async function linkedInSourceFor(user: Pick<User, 'id'>): Promise<LinkedInSource | undefined> {
  const live = await liveAccountFor(user);
  if (!live) return undefined;
  if (live === 'mock') return mockSource(user.id);
  const { accountId, token } = live;
  return {
    kind: 'live',
    profile: (identifier, sections, opts) =>
      linkedInProfile(accountId, identifier, sections, {
        token,
        shared: opts?.shared,
        recommendations: opts?.recommendations,
      }),
    company: (identifier) => linkedInCompany(accountId, identifier, { token }),
    search: async (keywords) => {
      const r = await unipileProxyCall<{
        ok?: boolean;
        reason?: string;
        message?: string;
        people?: LinkedInFound[];
      }>('/search', { accountId, token, keywords, distance: [1, 2, 3] }, { token, timeoutMs: 30_000 });
      if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
      if (r.value.ok === false)
        return {
          ok: false,
          reason: r.value.reason === 'limit' ? 'limit' : r.value.reason === 'refused' ? 'refused' : 'error',
          message: r.value.message ?? 'LinkedIn did not search.',
        };
      return { ok: true, value: r.value.people ?? [] };
    },
  };
}

/**
 * The account id and token to read LinkedIn with: the server's answer for an Orbit account, this browser's otherwise.
 * `anyToken`: a browser account without a stored token still answers (the older callers sent none and let the proxy
 * say so); an Orbit account always has one, from its server.
 */
export async function liveAccountFor(
  user: Pick<User, 'id'>,
  opts: { anyToken?: boolean } = {},
): Promise<{ accountId: string; token: string | undefined } | 'mock' | undefined> {
  if (isServerUser(user.id)) {
    if (!unipileConfigured()) return undefined;
    const r = await accountLinkedInReader(user.id);
    return typeof r === 'string' ? undefined : r;
  }
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  if (usesMockConnectors(user.id)) return 'mock';
  if (!unipileConfigured() || (!row.accessToken && !opts.anyToken)) return undefined;
  return { accountId: row.externalAccountId, token: row.accessToken };
}

/** This browser's live LinkedIn row (read here rather than from linkedinLive, which reads LinkedIn through this file). */
function liveLinkedInAccount(userId: string) {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'linkedin_live')
    .first();
}

function mockSource(userId: string): LinkedInSource {
  const notFound = { ok: false as const, reason: 'not_found' as const, message: 'Not in the demo.' };
  return {
    kind: 'mock',
    profile: async (identifier) => {
      const p = await mockLinkedInProfile(userId, identifier);
      return p ? { ok: true, value: p } : notFound;
    },
    company: async (identifier) => {
      const c = await mockLinkedInCompany(identifier);
      return c ? { ok: true, value: c } : notFound;
    },
    search: async (keywords) => ({ ok: true, value: mockLinkedInSearch(keywords) }),
  };
}

const PROVIDERS_KEY = 'enrich:providers';
const PROVIDERS_TTL_MS = 12 * 3_600_000;

/**
 * Which enrichment providers Orbit's server has keys for (asked at most twice a day). Undefined when it cannot say
 * (no proxy, the demo, or no answer).
 */
export async function serverProviders(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<ProviderStatus | undefined> {
  if (usesMockConnectors(user.id) || isServerUser(user.id) || !unipileConfigured()) return undefined;
  const cached = (await db.kv.get(PROVIDERS_KEY))?.value as { at: string; value: ProviderStatus } | undefined;
  if (cached && now.getTime() - Date.parse(cached.at) < PROVIDERS_TTL_MS) return cached.value;
  const r = await enrichmentProviders();
  if (!r.ok) return cached?.value;
  await db.kv.put({ key: PROVIDERS_KEY, value: { at: now.toISOString(), value: r.value } });
  return r.value;
}

/** The providers as last seen, without asking. */
export async function cachedProviders(): Promise<ProviderStatus | undefined> {
  return ((await db.kv.get(PROVIDERS_KEY))?.value as { value: ProviderStatus } | undefined)?.value;
}
