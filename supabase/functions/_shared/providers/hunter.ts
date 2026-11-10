/**
 * Hunter (https://hunter.io/api-documentation/v2), auth by the `X-API-KEY` header:
 *   Email Finder    `GET /v2/email-finder` by LinkedIn handle, or by first name, last name and company domain.
 *                   Charged 1 credit only when it finds an address; the answer carries the public pages it was seen on
 *                   and Hunter's own verification of it.
 *   Domain Search   `GET /v2/domain-search?limit=1`: the address pattern the company uses ("{first}",
 *                   "{f}{last}"), learned from every address Hunter has seen there (1 credit when it has any).
 *   Email Verifier  `GET /v2/email-verifier` (0.5 credit): valid, invalid, accept_all (the server takes any address,
 *                   so nothing can be confirmed), webmail, disposable or unknown. It talks to the mail server itself,
 *                   which an edge function cannot (no port 25), and sends nothing.
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

export const HUNTER_BASE = 'https://api.hunter.io';

const sourceSchema = z.looseObject({
  domain: z.string().nullish(),
  uri: z.string().nullish(),
  still_on_page: z.boolean().nullish(),
});

export const hunterFinderSchema = z.looseObject({
  data: z
    .looseObject({
      email: z.string().nullish(),
      score: z.number().nullish(),
      accept_all: z.boolean().nullish(),
      position: z.string().nullish(),
      linkedin_url: z.string().nullish(),
      sources: z.array(sourceSchema).nullish(),
      verification: z.looseObject({ status: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
export type HunterFinder = z.infer<typeof hunterFinderSchema>;

export const hunterDomainSchema = z.looseObject({
  data: z.looseObject({ pattern: z.string().nullish(), accept_all: z.boolean().nullish() }).nullish(),
});

export const hunterVerifierSchema = z.looseObject({
  data: z.looseObject({ status: z.string().nullish(), score: z.number().nullish() }).nullish(),
});

/** What a verification says about one address, in the three answers Orbit acts on. */
export type Deliverability = 'valid' | 'invalid' | 'risky';

export function deliverability(status: string | null | undefined): Deliverability {
  const s = (status ?? '').toLowerCase();
  if (s === 'valid') return 'valid';
  if (s === 'invalid' || s === 'disposable') return 'invalid';
  return 'risky';
}

export interface Hunter {
  readonly configured: boolean;
  findEmail(
    params:
      | { linkedin_handle: string }
      | { first_name: string; last_name: string; domain: string }
      // Hunter finds the company's domain itself from its name, when Orbit does not know it
      | { first_name: string; last_name: string; company: string },
  ): Promise<ProviderResult<HunterFinder>>;
  domainPattern(domain: string): Promise<ProviderResult<z.infer<typeof hunterDomainSchema>>>;
  verifyEmail(email: string): Promise<ProviderResult<z.infer<typeof hunterVerifierSchema>>>;
}

/**
 * Out of credits or over the rate limit (seen live: a free plan used up mid-search turned each call into three slow
 * retries and a 47-second search): Hunter answers 429, 402 or 403, and every later call in the same search is skipped.
 */
const SPENT = new Set([402, 403, 429]);

export function createHunter(given: ProviderOptions): Hunter {
  // one try, short: an email is never worth holding up a search for
  const opts: ProviderOptions = { ...given, maxRetries: 0, timeoutMs: given.timeoutMs ?? 6000 };
  const base = trimBase(opts.baseUrl ?? HUNTER_BASE);
  const headers = () => ({ 'X-API-KEY': opts.apiKey ?? '' });
  let spent = false;
  const call = async <T>(run: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> => {
    if (!opts.apiKey) return unconfigured('hunter');
    if (spent)
      return { ok: false, kind: 'budget_exceeded', provider: 'hunter', message: 'hunter: out of credits' };
    const r = await run();
    if (!r.ok && r.status !== undefined && SPENT.has(r.status)) spent = true;
    return r;
  };
  return {
    configured: !!opts.apiKey,
    findEmail(params) {
      return call(() =>
        requestJson(opts, {
          provider: 'hunter',
          url: `${base}/v2/email-finder${query({ ...params })}`,
          headers: headers(),
          schema: hunterFinderSchema,
          // nobody found by that handle or name
          emptyOn: [404],
          onEmpty: () => ({ data: null }),
        }),
      );
    },
    domainPattern(domain) {
      return call(() =>
        requestJson(opts, {
          provider: 'hunter',
          url: `${base}/v2/domain-search${query({ domain, limit: 1 })}`,
          headers: headers(),
          schema: hunterDomainSchema,
        }),
      );
    },
    verifyEmail(email) {
      return call(() =>
        requestJson(opts, {
          provider: 'hunter',
          url: `${base}/v2/email-verifier${query({ email })}`,
          headers: headers(),
          schema: hunterVerifierSchema,
        }),
      );
    },
  };
}
