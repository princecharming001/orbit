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
import { isServerUser } from '../../integrations/orbitApi';
import { type LinkedInFound, unipileConfigured, unipileProxyCall } from '../../integrations/unipile';
import { liveLinkedInAccount } from '../linkedinLive';

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

/** The student's LinkedIn for enrichment, or undefined when it is not connected live (or this is account mode). */
export async function linkedInSourceFor(user: Pick<User, 'id'>): Promise<LinkedInSource | undefined> {
  if (isServerUser(user.id)) return undefined;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  if (usesMockConnectors(user.id)) return mockSource(user.id);
  if (!unipileConfigured() || !row.accessToken) return undefined;
  const accountId = row.externalAccountId;
  const token = row.accessToken;
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
