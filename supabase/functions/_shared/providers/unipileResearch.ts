/**
 * Unipile for research and sourcing (https://developer.unipile.com/reference), through the user's own LinkedIn
 * account. Confirmed from the reference:
 * - `GET /api/v1/users/{identifier}?account_id=&linkedin_sections=&notify=false` (sections such as `*_preview`,
 *   `experience`, `education`, `about`; `about` comes back as `summary`; `work_experience[]`, `education[]`,
 *   `network_distance` FIRST_DEGREE..OUT_OF_NETWORK, `throttled_sections`).
 * - `GET /api/v1/users/{identifier}/posts?account_id=&limit=` → `{object: "PostList", items: [{id, social_id,
 *   share_url, text, date, parsed_datetime, reaction_counter, comment_counter, ...}], cursor}`.
 * - `POST /api/v1/linkedin/search?account_id=&limit=&cursor=`, body by `api` + `category`. Classic people:
 *   `keywords`, `network_distance: number[]` (1|2|3), `connections_of: string[]` (member ids; `config.params` in the answer echoes
 *   what Unipile parsed, not what LinkedIn honoured, so a mutuals search is checked against the target profile's
 *   `shared_connections_count`), and `company` / `past_company` /
 *   `school` / `location` / `industry` as LinkedIn **ids** (from `GET /api/v1/linkedin/search/parameters?type=&
 *   keywords=`). Sales Navigator people take `{include, exclude}` filters, plain-text company/role allowed. Classic
 *   pages hold at most 10 results; Sales Navigator up to 100. Response `{object: "LinkedinSearch", items: [{type:
 *   "PEOPLE", id, name, member_urn, public_identifier?, profile_url, public_profile_url?, network_distance:
 *   "DISTANCE_2", location, headline}], paging, cursor}`.
 * Assumed (not confirmed): `linkedin_sections` is sent comma-joined in one parameter (as in §5.2); `GET /users/me`
 * exposes Sales Navigator access somewhere under a `sales_navigator`-named field (read tolerantly).
 */
import {
  type ProviderOptions,
  type ProviderResult,
  query,
  requestJson,
  trimBase,
  unconfigured,
} from './request';
import { z } from './zod';

const dateish = z.union([z.string(), z.number(), z.looseObject({})]).nullish();

export const unipileProfileSchema = z.looseObject({
  provider_id: z.string().nullish(),
  public_identifier: z.string().nullish(),
  public_profile_url: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  headline: z.string().nullish(),
  summary: z.string().nullish(),
  location: z.string().nullish(),
  network_distance: z.string().nullish(),
  shared_connections_count: z.number().nullish(),
  websites: z.array(z.string()).nullish(),
  work_experience: z
    .array(
      z.looseObject({
        position: z.string().nullish(),
        company: z.string().nullish(),
        location: z.string().nullish(),
        description: z.string().nullish(),
        current: z.boolean().nullish(),
        start: dateish,
        end: dateish,
      }),
    )
    .nullish(),
  education: z
    .array(
      z.looseObject({
        school: z.string().nullish(),
        degree: z.string().nullish(),
        field_of_study: z.string().nullish(),
        start: dateish,
        end: dateish,
      }),
    )
    .nullish(),
  throttled_sections: z.array(z.string()).nullish(),
});
export type UnipileProfile = z.infer<typeof unipileProfileSchema>;

export const unipilePostSchema = z.looseObject({
  id: z.string().nullish(),
  social_id: z.string().nullish(),
  share_url: z.string().nullish(),
  text: z.string().nullish(),
  date: z.string().nullish(),
  parsed_datetime: z.string().nullish(),
  is_repost: z.boolean().nullish(),
});
export type UnipilePost = z.infer<typeof unipilePostSchema>;

export const unipilePostsSchema = z.looseObject({
  items: z.array(unipilePostSchema).default([]),
  cursor: z.string().nullish(),
});

export const unipileSearchItemSchema = z.looseObject({
  type: z.string().nullish(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  member_urn: z.string().nullish(),
  member_id: z.string().nullish(),
  provider_id: z.string().nullish(),
  public_identifier: z.string().nullish(),
  profile_url: z.string().nullish(),
  public_profile_url: z.string().nullish(),
  network_distance: z.string().nullish(),
  location: z.string().nullish(),
  headline: z.string().nullish(),
});
export type UnipileSearchItem = z.infer<typeof unipileSearchItemSchema>;

export const unipileSearchSchema = z.looseObject({
  items: z.array(unipileSearchItemSchema).default([]),
  cursor: z.string().nullish(),
  paging: z.looseObject({ total_count: z.number().nullish() }).nullish(),
  config: z.looseObject({ params: z.record(z.string(), z.unknown()).nullish() }).nullish(),
});

export const unipileSearchParamsSchema = z.looseObject({
  items: z
    .array(z.looseObject({ id: z.union([z.string(), z.number()]), title: z.string().nullish() }))
    .default([]),
});

export type SearchParameterType = 'LOCATION' | 'COMPANY' | 'SCHOOL' | 'INDUSTRY' | 'PEOPLE' | 'SERVICE';

export interface ClassicPeopleSearch {
  api: 'classic';
  category: 'people';
  keywords?: string;
  network_distance?: (1 | 2 | 3)[];
  connections_of?: string[];
  company?: string[];
  past_company?: string[];
  school?: string[];
  location?: string[];
  industry?: string[];
  advanced_keywords?: {
    first_name?: string;
    last_name?: string;
    title?: string;
    company?: string;
    school?: string;
  };
}

type IncludeExclude = { include?: (string | number)[]; exclude?: (string | number)[] };
export interface SalesNavigatorPeopleSearch {
  api: 'sales_navigator';
  category: 'people';
  keywords?: string;
  network_distance?: (1 | 2 | 3 | 'GROUP')[];
  connections_of?: string[];
  company?: IncludeExclude;
  past_company?: IncludeExclude;
  role?: IncludeExclude;
  school?: IncludeExclude;
  location?: IncludeExclude;
  seniority?: IncludeExclude;
}

export type PeopleSearch = ClassicPeopleSearch | SalesNavigatorPeopleSearch;

export interface UnipileResearch {
  readonly configured: boolean;
  profile(
    accountId: string,
    identifier: string,
    opts?: { sections?: string[]; linkedinApi?: 'sales_navigator' | 'recruiter' },
  ): Promise<ProviderResult<UnipileProfile>>;
  posts(
    accountId: string,
    identifier: string,
    opts?: { limit?: number },
  ): Promise<ProviderResult<UnipilePost[]>>;
  /** the connected account's own profile; used to detect a Sales Navigator seat */
  me(accountId: string): Promise<ProviderResult<Record<string, unknown>>>;
  searchPeople(
    accountId: string,
    body: PeopleSearch,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ProviderResult<z.infer<typeof unipileSearchSchema>>>;
  searchParameters(
    accountId: string,
    type: SearchParameterType,
    keywords: string,
    opts?: { limit?: number },
  ): Promise<ProviderResult<{ id: string; title?: string }[]>>;
  /** the user's 1st-degree connections who are connected to a member (§4.2 step 3) */
  mutuals(
    accountId: string,
    memberId: string,
    opts?: { maxPages?: number },
  ): Promise<ProviderResult<UnipileSearchItem[]>>;
}

export const DOSSIER_SECTIONS = ['*_preview', 'experience', 'education', 'about'];

export function createUnipileResearch(opts: ProviderOptions): UnipileResearch {
  const configured = !!opts.apiKey && !!opts.baseUrl;
  const base = trimBase(opts.baseUrl ?? '');
  const headers = () => ({ 'X-API-KEY': opts.apiKey ?? '' });
  const notConfigured = () => unconfigured('unipile', 'API key or base URL');

  const api: UnipileResearch = {
    configured,
    async profile(accountId, identifier, o = {}) {
      if (!configured) return notConfigured();
      const q = query({
        account_id: accountId,
        linkedin_sections: (o.sections ?? DOSSIER_SECTIONS).join(',') || undefined,
        linkedin_api: o.linkedinApi,
        notify: 'false',
      });
      return requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/users/${encodeURIComponent(identifier)}${q}`,
        headers: headers(),
        schema: unipileProfileSchema,
      });
    },
    async posts(accountId, identifier, o = {}) {
      if (!configured) return notConfigured();
      const r = await requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/users/${encodeURIComponent(identifier)}/posts${query({ account_id: accountId, limit: o.limit ?? 10 })}`,
        headers: headers(),
        schema: unipilePostsSchema,
      });
      return r.ok ? { ok: true, value: r.value.items } : r;
    },
    async me(accountId) {
      if (!configured) return notConfigured();
      return requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/users/me${query({ account_id: accountId })}`,
        headers: headers(),
        schema: z.record(z.string(), z.unknown()),
      });
    },
    async searchPeople(accountId, body, o = {}) {
      if (!configured) return notConfigured();
      const max = body.api === 'classic' ? 10 : 100;
      return requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/linkedin/search${query({ account_id: accountId, limit: Math.min(max, o.limit ?? max), cursor: o.cursor })}`,
        method: 'POST',
        headers: headers(),
        body,
        schema: unipileSearchSchema,
      });
    },
    async searchParameters(accountId, type, keywords, o = {}) {
      if (!configured) return notConfigured();
      const r = await requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/linkedin/search/parameters${query({ account_id: accountId, type, keywords, limit: o.limit ?? 5 })}`,
        headers: headers(),
        schema: unipileSearchParamsSchema,
      });
      if (!r.ok) return r;
      return {
        ok: true,
        value: r.value.items.map((i) => ({ id: String(i.id), title: i.title ?? undefined })),
      };
    },
    async mutuals(accountId, memberId, o = {}) {
      if (!configured) return notConfigured();
      // LinkedIn states on the target's profile how many connections the two share; the search must agree with it
      const prof = await api.profile(accountId, memberId, { sections: [] });
      if (!prof.ok) return prof;
      const shared = prof.value.shared_connections_count;
      if (typeof shared !== 'number')
        return {
          ok: false,
          kind: 'invalid',
          provider: 'unipile',
          message: 'unipile: LinkedIn did not say how many connections are shared',
        };
      if (shared === 0) return { ok: true, value: [] };
      const items: UnipileSearchItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < (o.maxPages ?? 1); page++) {
        const r = await api.searchPeople(
          accountId,
          { api: 'classic', category: 'people', network_distance: [1], connections_of: [memberId] },
          { cursor },
        );
        if (!r.ok) return page === 0 ? r : { ok: true, value: items };
        // an answer without the filter, or far bigger than the shared count, is the student's own connections
        const applied = r.value.config?.params?.connections_of;
        const kept = Array.isArray(applied) ? applied.map(String) : applied == null ? [] : [String(applied)];
        const total = r.value.paging?.total_count;
        if (!kept.includes(memberId) || (typeof total === 'number' && total > shared * 1.5 + 5)) {
          return {
            ok: false,
            kind: 'invalid',
            provider: 'unipile',
            message: 'unipile: LinkedIn did not apply the mutual-connections filter',
          };
        }
        for (const it of r.value.items) {
          const id = it.id ?? it.provider_id ?? it.member_id;
          if (id === memberId) continue;
          if (it.network_distance && it.network_distance !== 'DISTANCE_1') continue;
          items.push(it);
        }
        cursor = r.value.cursor ?? undefined;
        if (!cursor || items.length >= shared) break;
      }
      return { ok: true, value: items };
    },
  };
  return api;
}

// ---- normalization ----------------------------------------------------------------------------------------

/** "DISTANCE_2" / "SECOND_DEGREE" / 2 → 2; unknown → undefined. */
export function networkDistance(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').toUpperCase();
  const m = s.match(/DISTANCE_(\d)/);
  if (m) return Number(m[1]);
  if (s.startsWith('FIRST')) return 1;
  if (s.startsWith('SECOND')) return 2;
  if (s.startsWith('THIRD')) return 3;
  return undefined;
}

/** A LinkedIn profile URL without tracking parameters, lowercased, no trailing slash. */
export function cleanLinkedInUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/linkedin\.com\/(in|pub)\/([^/?#]+)/i);
  if (!m) return undefined;
  return `https://www.linkedin.com/in/${decodeURIComponent(m[2]!).toLowerCase()}`;
}

/** The public slug in a LinkedIn URL ("jane-doe-123"). */
export function linkedInSlugOf(url: string | null | undefined): string | undefined {
  const clean = cleanLinkedInUrl(url);
  return clean ? clean.slice(clean.lastIndexOf('/') + 1) : undefined;
}

export interface LinkedInPerson {
  memberId?: string;
  name: string;
  headline?: string;
  location?: string;
  linkedinUrl?: string;
  networkDistance?: number;
}

export function linkedInPerson(i: UnipileSearchItem): LinkedInPerson {
  const name = (i.name ?? `${i.first_name ?? ''} ${i.last_name ?? ''}`).trim();
  const url =
    cleanLinkedInUrl(i.public_profile_url) ??
    cleanLinkedInUrl(i.profile_url) ??
    (i.public_identifier ? `https://www.linkedin.com/in/${i.public_identifier.toLowerCase()}` : undefined);
  return {
    memberId: i.id ?? i.provider_id ?? i.member_id ?? undefined,
    name,
    headline: i.headline ?? undefined,
    location: i.location ?? undefined,
    linkedinUrl: url,
    networkDistance: networkDistance(i.network_distance),
  };
}

/** Whether `GET /users/me` says the account has a Sales Navigator seat (tolerant of where the flag sits). */
export function hasSalesNavigator(me: Record<string, unknown>): boolean {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): boolean => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return false;
    seen.add(v);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/sales_?navigator/i.test(k) && x && x !== false) return true;
      if (walk(x, depth + 1)) return true;
    }
    return false;
  };
  return walk(me, 0);
}
