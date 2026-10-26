/**
 * The enrichment routes of Orbit's connector proxy (plan 17 E; supabase/functions/orbit-connectors, the block at the
 * end of connectors.ts): a person's full LinkedIn profile, a company's LinkedIn page, a web lookup (Exa, when its key
 * is set up) and which providers are set up. Same transport and typed outcomes as integrations/unipile.ts; the sample
 * student never reaches this file (engine/enrichment answers it from integrations/connectorsMock.ts).
 */
import { type ConnectorOutcome, connectorFailure } from './connectorOutcome';
import { type CallOpts, unipileProxyCall } from './unipile';

/** One position on a LinkedIn profile. Dates are as LinkedIn wrote them ("2021-06", "6/2021"). */
export interface LinkedInPosition {
  title?: string;
  company?: string;
  /** LinkedIn's id for the company */
  companyId?: string;
  /** the company's public LinkedIn name ("enactus-berkeley"), when the profile links it */
  companySlug?: string;
  /** the company's logo (a LinkedIn link that expires) */
  logoUrl?: string;
  location?: string;
  current: boolean;
  start?: string;
  end?: string;
}

export interface LinkedInSchool {
  school: string;
  schoolId?: string;
  logoUrl?: string;
  degree?: string;
  field?: string;
  start?: string;
  end?: string;
}

/** A person's LinkedIn profile, as Orbit keeps it. */
export interface LinkedInProfile {
  providerId?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  location?: string;
  about?: string;
  pictureUrl?: string;
  /** 1 = connected to the student, 2 and 3 further out */
  distance?: number;
  experience: LinkedInPosition[];
  education: LinkedInSchool[];
  /** what a 1st-degree connection shares with the student: kept only to join the same person's mail and texts */
  contact?: { emails: string[]; phones: string[] };
  /** sections LinkedIn held back this time (they came back empty, not because the person has none) */
  throttled: string[];
  /** how many people follow them on LinkedIn (to discount engagement with popular people) */
  followerCount?: number;
  /** how many connections they have, as LinkedIn states it (500 for "500+") */
  connectionsCount?: number;
  /** who recommended them and whom they recommended, when asked for: never the recommendation's text */
  recommendations?: LinkedInRecommendation[];
}

/** One LinkedIn recommendation on a profile: who and when, never what was written. */
export interface LinkedInRecommendation {
  /** received: the other person recommended them; given: they recommended the other person */
  direction: 'received' | 'given';
  /** the other person's LinkedIn member id */
  actorId: string;
  actorName?: string;
  year?: number;
  /** LinkedIn's one-line caption ("June 2023, Ana managed Omar directly"), at most 80 characters */
  caption?: string;
}

export interface LinkedInCompany {
  id?: string;
  name?: string;
  publicIdentifier?: string;
  logoUrl?: string;
  website?: string;
  industry?: string;
}

export interface WebResult {
  url: string;
  title?: string;
  snippet?: string;
}

/** Which providers the server has keys for. */
export interface ProviderStatus {
  linkedin: boolean;
  exa: boolean;
  firecrawl: boolean;
  apollo: boolean;
  peopleDataLabs: boolean;
}

/** Why an enrichment call brought nothing back. */
export type EnrichFailure =
  | 'not_found'
  /** LinkedIn asked to slow down */
  | 'throttled'
  /** Orbit's own daily budget on the server */
  | 'limit'
  | 'refused'
  | 'bad_request'
  | 'unconfigured'
  | 'timeout'
  | 'error';

export type EnrichOutcome<T> = { ok: true; value: T } | { ok: false; reason: EnrichFailure; message: string };

type Answer<K extends string, T> = { ok?: boolean; reason?: string; message?: string } & Partial<
  Record<K, T>
>;

function unwrap<K extends string, T>(r: ConnectorOutcome<Answer<K, T>>, key: K): EnrichOutcome<T> {
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
  if (r.value.ok === false || !r.value[key]) {
    const reason = r.value.reason;
    const known: EnrichFailure[] = ['not_found', 'throttled', 'limit', 'refused', 'bad_request'];
    return {
      ok: false,
      reason: known.includes(reason as EnrichFailure) ? (reason as EnrichFailure) : 'error',
      message: r.value.message ?? 'LinkedIn did not answer.',
    };
  }
  return { ok: true, value: r.value[key] as T };
}

/** The sections Orbit reads: the full ones for people who matter now, previews for everyone else. */
export const FULL_SECTIONS = ['experience', 'education', 'about'];
export const PREVIEW_SECTIONS = ['experience_preview', 'education_preview'];

/**
 * A person's LinkedIn profile, by their member id or public profile name. `recommendations` also reads who
 * recommended them and whom they recommended; `purpose: 'route'` marks a read for a route the student is looking at,
 * which may use the whole day's profile reads (enrichment stops at 70% of them). `shared` says only what anyone on
 * LinkedIn would see is needed, so a copy another student's account read today will do (no contact, no distance).
 */
export async function linkedInProfile(
  accountId: string,
  identifier: string,
  sections: string[],
  opts: CallOpts & { recommendations?: boolean; purpose?: 'route'; shared?: boolean } = {},
): Promise<EnrichOutcome<LinkedInProfile>> {
  const r = await unipileProxyCall<Answer<'profile', LinkedInProfile>>(
    '/profile',
    {
      accountId,
      token: opts.token,
      identifier,
      sections,
      ...(opts.recommendations ? { recommendations: true } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      // only what anyone would see is needed: the proxy may answer with another student's read from today, so
      // LinkedIn never sees many accounts open the same person (never for contact details or distance)
      ...(opts.shared ? { public: true } : {}),
    },
    { timeoutMs: 30_000, ...opts },
  );
  const out = unwrap(r, 'profile');
  if (!out.ok) return out;
  const p = out.value;
  return {
    ok: true,
    value: {
      ...p,
      experience: p.experience ?? [],
      education: p.education ?? [],
      throttled: p.throttled ?? [],
    },
  };
}

/** Someone's LinkedIn photo link and who they are on LinkedIn, from the plain profile (engine/photoQueue.ts). */
export interface LinkedInPhoto {
  /** a LinkedIn link that expires after a few weeks; none when they have no photo or LinkedIn shows none */
  pictureUrl?: string;
  providerId?: string;
  publicIdentifier?: string;
}

/** A person's LinkedIn photo link, by their member id or public profile name: the lightest profile read. */
export async function linkedInPhoto(
  accountId: string,
  identifier: string,
  opts: CallOpts = {},
): Promise<EnrichOutcome<LinkedInPhoto>> {
  const r = await unipileProxyCall<Answer<'photo', LinkedInPhoto>>(
    '/photo',
    { accountId, token: opts.token, identifier },
    opts,
  );
  return unwrap(r, 'photo');
}

/** A company's LinkedIn page (its logo, public name and website), by LinkedIn's id or its public name. */
export async function linkedInCompany(
  accountId: string,
  identifier: string,
  opts: CallOpts = {},
): Promise<EnrichOutcome<LinkedInCompany>> {
  const r = await unipileProxyCall<Answer<'company', LinkedInCompany>>(
    '/company',
    { accountId, token: opts.token, identifier },
    opts,
  );
  return unwrap(r, 'company');
}

/**
 * A company's LinkedIn page found by its name: LinkedIn's company search, answered only when exactly one company there
 * has that name (`ambiguous` when several do, so a namesake's logo is never taken).
 */
export async function linkedInCompanyByName(
  accountId: string,
  name: string,
  opts: CallOpts = {},
): Promise<EnrichOutcome<LinkedInCompany>> {
  const r = await unipileProxyCall<Answer<'company', LinkedInCompany>>(
    '/company',
    { accountId, token: opts.token, name },
    opts,
  );
  return unwrap(r, 'company');
}

/** Web pages about a person (Exa), when Orbit's server has a key for it; `unconfigured` otherwise. */
export async function webLookup(
  q: { name: string; company?: string; school?: string },
  opts: CallOpts = {},
): Promise<EnrichOutcome<WebResult[]>> {
  const r = await unipileProxyCall<Answer<'results', WebResult[]>>('/web', q, { timeoutMs: 30_000, ...opts });
  return unwrap(r, 'results');
}

/** Which enrichment providers Orbit's server is set up for. */
export async function enrichmentProviders(opts: CallOpts = {}): Promise<ConnectorOutcome<ProviderStatus>> {
  const r = await unipileProxyCall<Partial<ProviderStatus>>('/providers', {}, opts);
  if (!r.ok) return r;
  if (typeof r.value !== 'object' || !r.value) return connectorFailure('error', 'No answer.');
  return {
    ok: true,
    value: {
      linkedin: !!r.value.linkedin,
      exa: !!r.value.exa,
      firecrawl: !!r.value.firecrawl,
      apollo: !!r.value.apollo,
      peopleDataLabs: !!r.value.peopleDataLabs,
    },
  };
}
