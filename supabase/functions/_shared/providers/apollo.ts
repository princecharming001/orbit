/**
 * Apollo People API Search (https://docs.apollo.io/reference/people-api-search):
 * `POST /api/v1/mixed_people/api_search` with every filter in the query string (`person_titles[]=...`), auth by the
 * `x-api-key` header. Free (no credits) and returns no emails; last names come obfuscated (`last_name_obfuscated`),
 * so a record is keyed by Apollo's `id` until the user adds it. `linkedin_url` is not in the documented response
 * but is read when present. People Match (`POST /api/v1/people/match`, 1 credit) runs only on an explicit request.
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

export const APOLLO_BASE = 'https://api.apollo.io';

export interface ApolloPeopleSearch {
  person_titles?: string[];
  include_similar_titles?: boolean;
  person_seniorities?: string[];
  person_locations?: string[];
  organization_locations?: string[];
  organization_num_employees_ranges?: string[];
  q_organization_domains_list?: string[];
  q_keywords?: string;
  page?: number;
  per_page?: number;
}

export const apolloPersonSchema = z.looseObject({
  id: z.string(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  last_name_obfuscated: z.string().nullish(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  headline: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
  has_email: z.boolean().nullish(),
  seniority: z.string().nullish(),
  organization: z
    .looseObject({
      name: z.string().nullish(),
      primary_domain: z.string().nullish(),
      website_url: z.string().nullish(),
    })
    .nullish(),
});
export type ApolloPerson = z.infer<typeof apolloPersonSchema>;

export const apolloSearchResponseSchema = z.looseObject({
  total_entries: z.number().nullish(),
  people: z.array(apolloPersonSchema).default([]),
});
export type ApolloSearchResponse = z.infer<typeof apolloSearchResponseSchema>;

export const apolloMatchResponseSchema = z.looseObject({
  person: apolloPersonSchema.extend({ email: z.string().nullish() }).nullish(),
});

export interface Apollo {
  readonly configured: boolean;
  searchPeople(params: ApolloPeopleSearch): Promise<ProviderResult<ApolloSearchResponse>>;
  /** 1 credit; only when the user chooses to email a sourced person with no known address */
  matchPerson(params: {
    id?: string;
    first_name?: string;
    last_name?: string;
    organization_name?: string;
    domain?: string;
    linkedin_url?: string;
    reveal_personal_emails?: boolean;
  }): Promise<ProviderResult<z.infer<typeof apolloMatchResponseSchema>>>;
}

export function createApollo(opts: ProviderOptions): Apollo {
  const base = trimBase(opts.baseUrl ?? APOLLO_BASE);
  const headers = () => ({ 'x-api-key': opts.apiKey ?? '', 'cache-control': 'no-cache' });
  return {
    configured: !!opts.apiKey,
    async searchPeople(params) {
      if (!opts.apiKey) return unconfigured('apollo');
      return requestJson(opts, {
        provider: 'apollo',
        url: `${base}/api/v1/mixed_people/api_search${query({ ...params }, true)}`,
        method: 'POST',
        headers: headers(),
        schema: apolloSearchResponseSchema,
      });
    },
    async matchPerson(params) {
      if (!opts.apiKey) return unconfigured('apollo');
      return requestJson(opts, {
        provider: 'apollo',
        url: `${base}/api/v1/people/match${query({ ...params })}`,
        method: 'POST',
        headers: headers(),
        schema: apolloMatchResponseSchema,
      });
    },
  };
}

/** The display name Apollo gives: full when it has one, else first name plus the obfuscated last name. */
export function apolloName(p: ApolloPerson): { first: string; last: string; obfuscated: boolean } {
  if (p.last_name) return { first: p.first_name ?? '', last: p.last_name, obfuscated: false };
  if (p.name && !p.last_name_obfuscated) {
    const [first = '', ...rest] = p.name.trim().split(/\s+/);
    return { first, last: rest.join(' '), obfuscated: false };
  }
  return { first: p.first_name ?? '', last: p.last_name_obfuscated ?? '', obfuscated: true };
}
