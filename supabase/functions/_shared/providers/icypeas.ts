/**
 * Icypeas (docs: https://api-doc.icypeas.com), an email finder Orbit tries before Hunter when ICYPEAS_API_KEY is set
 * and Enrow's is not (plan 35 E6). Auth by the `Authorization` header holding the key itself (no "Bearer"), base
 * https://app.icypeas.com/api.
 *   Find      `POST /email-search` {firstname, lastname, domainOrCompany}: starts a search, answers {success, item:
 *             {_id, status}} (https://api-doc.icypeas.com/find-emails/email-search/).
 *   Result    `POST /bulk-single-searchs/read` {id}: {success, items: [{status, results: {emails: [{email,
 *             certainty}]}}]} (https://api-doc.icypeas.com/find-emails/retrieve-result/). Running: NONE, SCHEDULED,
 *             IN_PROGRESS; found: FOUND, DEBITED; missed: NOT_FOUND, DEBITED_NOT_FOUND; and BAD_INPUT,
 *             INSUFFICIENT_FUNDS, ABORTED. Certainty ultra_sure and very_sure (99%), probable (95%), undeliverable.
 * A validation error comes back as HTTP 200 with success false. Reads are limited to 30 a minute.
 */
import { type ProviderOptions, type ProviderResult, requestJson, trimBase, unconfigured } from './request';
import { z } from './zod';

export const ICYPEAS_BASE = 'https://app.icypeas.com/api';

const startSchema = z.looseObject({
  success: z.boolean().nullish(),
  item: z.looseObject({ _id: z.string().nullish(), status: z.string().nullish() }).nullish(),
});
const readSchema = z.looseObject({
  success: z.boolean().nullish(),
  items: z
    .array(
      z.looseObject({
        status: z.string().nullish(),
        results: z
          .looseObject({
            emails: z
              .array(z.looseObject({ email: z.string().nullish(), certainty: z.string().nullish() }))
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

/** What a finished search says: the best address and how sure, or none; `debited` when a credit was taken. */
export interface IcypeasResult {
  email: string | null;
  certainty: string | null;
  status: string;
  debited: boolean;
}

export const ICYPEAS_POLLS = 4;
export const ICYPEAS_POLL_MS = 2000;
const RUNNING = new Set(['NONE', 'SCHEDULED', 'IN_PROGRESS']);
const CERTAINTY_RANK: Record<string, number> = { ultra_sure: 3, very_sure: 2, probable: 1 };

export interface Icypeas {
  readonly configured: boolean;
  findEmail(params: {
    firstname: string;
    lastname: string;
    domainOrCompany: string;
  }): Promise<ProviderResult<IcypeasResult>>;
}

export function createIcypeas(given: ProviderOptions): Icypeas {
  const opts: ProviderOptions = { ...given, maxRetries: 0, timeoutMs: given.timeoutMs ?? 6000 };
  const base = trimBase(opts.baseUrl ?? ICYPEAS_BASE);
  const headers = () => ({ Authorization: opts.apiKey ?? '' });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let spent = false;
  return {
    configured: !!opts.apiKey,
    async findEmail(p) {
      if (!opts.apiKey) return unconfigured('icypeas');
      if (spent)
        return {
          ok: false,
          kind: 'budget_exceeded',
          provider: 'icypeas',
          message: 'icypeas: out of credits',
        };
      const started = await requestJson(opts, {
        provider: 'icypeas',
        url: `${base}/email-search`,
        headers: headers(),
        body: p,
        schema: startSchema,
      });
      if (!started.ok) {
        if (started.status === 401 || started.status === 402 || started.status === 403) spent = true;
        return started;
      }
      const id = started.value.item?._id;
      if (!started.value.success || !id)
        return {
          ok: false,
          kind: 'invalid',
          provider: 'icypeas',
          message: 'icypeas: the search was refused',
        };
      for (let i = 0; i < ICYPEAS_POLLS; i++) {
        await sleep(ICYPEAS_POLL_MS);
        const r = await requestJson(opts, {
          provider: 'icypeas',
          url: `${base}/bulk-single-searchs/read`,
          headers: headers(),
          body: { id },
          schema: readSchema,
        });
        if (!r.ok) return r;
        const item = r.value.items?.[0];
        const status = (item?.status ?? 'NONE').toUpperCase();
        if (RUNNING.has(status)) continue;
        if (status === 'INSUFFICIENT_FUNDS') {
          spent = true;
          return {
            ok: false,
            kind: 'budget_exceeded',
            provider: 'icypeas',
            message: 'icypeas: out of credits',
          };
        }
        const best = (item?.results?.emails ?? [])
          .filter((e) => e.email?.includes('@') && CERTAINTY_RANK[(e.certainty ?? '').toLowerCase()])
          .sort(
            (a, b) =>
              CERTAINTY_RANK[(b.certainty ?? '').toLowerCase()]! -
              CERTAINTY_RANK[(a.certainty ?? '').toLowerCase()]!,
          )[0];
        const found = status === 'FOUND' || status === 'DEBITED';
        return {
          ok: true,
          value: {
            email: found && best?.email ? best.email.trim().toLowerCase() : null,
            certainty: found ? (best?.certainty ?? null) : null,
            status,
            debited: status === 'DEBITED' || status === 'DEBITED_NOT_FOUND' || status === 'FOUND',
          },
        };
      }
      return {
        ok: false,
        kind: 'timeout',
        provider: 'icypeas',
        message: 'icypeas: the search did not finish in time',
      };
    },
  };
}
