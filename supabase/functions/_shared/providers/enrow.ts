/**
 * Enrow (docs: https://docs.enrow.io), an email finder Orbit tries before Hunter when ENROW_API_KEY is set (plan 35
 * E6). Auth by the `x-api-key` header, base https://api.enrow.io.
 *   Find      `POST /email/find/single` {fullname, company_domain | company_name, linkedin_url?}: starts a search and
 *             answers its id (https://docs.enrow.io/email-finder/find-single-email).
 *   Result    `GET /email/find/single?id=`: 202 while the search runs, then {email, qualification: 'valid' |
 *             'invalid', credits_used} (https://docs.enrow.io/email-finder/get-single-email-result).
 * One credit per address found, none for a miss; 402 when the credits are gone.
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

export const ENROW_BASE = 'https://api.enrow.io';

const startSchema = z.looseObject({ id: z.string().nullish(), message: z.string().nullish() });
export const enrowResultSchema = z.looseObject({
  email: z.string().nullish(),
  qualification: z.string().nullish(),
  credits_used: z.number().nullish(),
});
export type EnrowResult = z.infer<typeof enrowResultSchema>;

/** Polls of a running search at most, and the wait between them: an address is never worth holding a job for. */
export const ENROW_POLLS = 4;
export const ENROW_POLL_MS = 1500;

export interface Enrow {
  readonly configured: boolean;
  /** The address, `{email: null}` for a miss, or why it could not say. */
  findEmail(params: {
    fullname: string;
    domain?: string;
    companyName?: string;
    linkedinUrl?: string;
  }): Promise<ProviderResult<EnrowResult>>;
}

const SPENT = new Set([401, 402, 403, 429]);

export function createEnrow(given: ProviderOptions): Enrow {
  const opts: ProviderOptions = { ...given, maxRetries: 0, timeoutMs: given.timeoutMs ?? 6000 };
  const base = trimBase(opts.baseUrl ?? ENROW_BASE);
  const headers = () => ({ 'x-api-key': opts.apiKey ?? '' });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let spent = false;
  return {
    configured: !!opts.apiKey,
    async findEmail(p) {
      if (!opts.apiKey) return unconfigured('enrow');
      if (spent)
        return { ok: false, kind: 'budget_exceeded', provider: 'enrow', message: 'enrow: out of credits' };
      if (!p.domain && !p.companyName)
        return { ok: false, kind: 'invalid', provider: 'enrow', message: 'enrow: a company is needed' };
      const started = await requestJson(opts, {
        provider: 'enrow',
        url: `${base}/email/find/single`,
        headers: headers(),
        body: {
          fullname: p.fullname,
          ...(p.domain ? { company_domain: p.domain } : { company_name: p.companyName }),
          ...(p.linkedinUrl ? { linkedin_url: p.linkedinUrl } : {}),
        },
        schema: startSchema,
      });
      if (!started.ok) {
        if (started.status !== undefined && SPENT.has(started.status)) spent = true;
        return started;
      }
      const id = started.value.id;
      if (!id) return { ok: false, kind: 'invalid', provider: 'enrow', message: 'enrow: no search id' };
      for (let i = 0; i < ENROW_POLLS; i++) {
        await sleep(ENROW_POLL_MS);
        const r = await requestJson(opts, {
          provider: 'enrow',
          url: `${base}/email/find/single${query({ id })}`,
          headers: headers(),
          schema: enrowResultSchema,
        });
        // a 202 with no JSON body yet is a search still running
        if (!r.ok && r.kind === 'invalid') continue;
        if (!r.ok) return r;
        const q = (r.value.qualification ?? '').toLowerCase();
        // still running: a 202 carries no qualification yet (or "ongoing")
        if (q === 'valid' || q === 'invalid' || (r.value.email && q !== 'ongoing')) return r;
        if (q && q !== 'ongoing') return { ok: true, value: { ...r.value, email: null } };
      }
      return {
        ok: false,
        kind: 'timeout',
        provider: 'enrow',
        message: 'enrow: the search did not finish in time',
      };
    },
  };
}
