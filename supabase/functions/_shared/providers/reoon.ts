/**
 * Reoon Email Verifier (docs: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/), the check
 * Orbit runs on an address it built or guessed before a message goes to it, when REOON_API_KEY is set (plan 35 E6;
 * Hunter's verifier without it). One call: `GET https://emailverifier.reoon.com/api/v1/verify?email=&key=&mode=`,
 * the key in the query as the API asks. Power mode talks to the mail server and answers safe, invalid, disabled,
 * disposable, inbox_full, catch_all, role_account, spamtrap or unknown; quick mode answers valid, invalid, disposable
 * or spamtrap. Up to 5 checks at a time; nothing is sent to the address.
 */
import type { Deliverability } from './hunter';
import {
  type ProviderOptions,
  type ProviderResult,
  query,
  requestJson,
  trimBase,
  unconfigured,
} from './request';
import { z } from './zod';

export const REOON_BASE = 'https://emailverifier.reoon.com';

export const reoonSchema = z.looseObject({
  email: z.string().nullish(),
  status: z.string().nullish(),
  is_safe_to_send: z.boolean().nullish(),
  is_deliverable: z.boolean().nullish(),
  is_catch_all: z.boolean().nullish(),
  overall_score: z.number().nullish(),
});
export type ReoonResult = z.infer<typeof reoonSchema>;

/** Reoon's answer in the three Orbit acts on: a server that takes any address proves nothing, so it is risky. */
export function reoonDeliverability(r: ReoonResult): Deliverability {
  const s = (r.status ?? '').toLowerCase();
  if (s === 'safe' || s === 'valid' || (r.is_safe_to_send && !r.is_catch_all)) return 'valid';
  if (s === 'invalid' || s === 'disabled' || s === 'disposable' || s === 'spamtrap') return 'invalid';
  return 'risky';
}

export interface Reoon {
  readonly configured: boolean;
  verifyEmail(email: string, mode?: 'power' | 'quick'): Promise<ProviderResult<ReoonResult>>;
}

export function createReoon(given: ProviderOptions): Reoon {
  // power mode waits on the mail server: a little longer than the finders, still one try
  const opts: ProviderOptions = { ...given, maxRetries: 0, timeoutMs: given.timeoutMs ?? 12_000 };
  const base = trimBase(opts.baseUrl ?? REOON_BASE);
  return {
    configured: !!opts.apiKey,
    verifyEmail(email, mode = 'power') {
      if (!opts.apiKey) return Promise.resolve(unconfigured('reoon'));
      return requestJson(opts, {
        provider: 'reoon',
        url: `${base}/api/v1/verify${query({ email, key: opts.apiKey, mode })}`,
        schema: reoonSchema,
      });
    },
  };
}
