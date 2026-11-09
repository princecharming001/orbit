/**
 * Unipile's account list, one account, and unlinking (plan 35 E1, E5). Shapes per developer.unipile.com:
 * - `GET /api/v1/accounts?limit=&cursor=` (reference/accountscontroller_listaccounts) → `{object: 'AccountList', items:
 *   [{object: 'Account', type: 'LINKEDIN' | 'WHATSAPP' | ..., id, name, created_at, connection_params, groups,
 *   sources: [{id, status: OK | STOPPED | ERROR | CREDENTIALS | PERMISSIONS | CONNECTING}]}], cursor}`, `limit` 1 to
 *   250, the next page asked for with `cursor` until it comes back null.
 * - `GET /api/v1/accounts/{id}` (reference/accountscontroller_getaccountbyid) → one Account; 404 when it is gone.
 * - `DELETE /api/v1/accounts/{id}` (reference/accountscontroller_deleteaccount) → `{object: 'AccountDeleted'}`: "Unlink
 *   the given account from Unipile". Unipile bills on the peak number of linked accounts in each 30-day period, and the
 *   API has no pause: an account that is not deleted is linked (reconnect, restart and resync all keep it linked).
 *
 * The Unipile account is shared with another product, so the list is only ever read. Unlinking is a separate function
 * that the reconciler does not import; only the parking job calls it, and only for an id read from
 * orbit.integration_accounts.
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

export const unipileAccountSchema = z.looseObject({
  id: z.string(),
  type: z.string().nullish(),
  name: z.string().nullish(),
  created_at: z.union([z.string(), z.number()]).nullish(),
  sources: z.array(z.looseObject({ id: z.string().nullish(), status: z.string().nullish() })).nullish(),
});
export type UnipileAccountRow = z.infer<typeof unipileAccountSchema>;

const listSchema = z.looseObject({
  items: z.array(unipileAccountSchema).default([]),
  cursor: z.string().nullish(),
});

/** 250 a page (Unipile's maximum); 20 pages is 5,000 accounts, far past what the shared plan holds. */
export const ACCOUNTS_PAGE = 250;
export const ACCOUNTS_MAX_PAGES = 20;

const headers = (opts: ProviderOptions) => ({ 'X-API-KEY': opts.apiKey ?? '' });
const configured = (opts: ProviderOptions) => !!opts.apiKey && !!opts.baseUrl;

/** Every account on the Unipile key, every type, paged by cursor. Read only. */
export async function listUnipileAccounts(
  opts: ProviderOptions,
): Promise<ProviderResult<UnipileAccountRow[]>> {
  if (!configured(opts)) return unconfigured('unipile', 'API key or base URL');
  const base = trimBase(opts.baseUrl ?? '');
  const out: UnipileAccountRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    const r = await requestJson(opts, {
      provider: 'unipile',
      url: `${base}/api/v1/accounts${query({ limit: ACCOUNTS_PAGE, cursor })}`,
      headers: headers(opts),
      schema: listSchema,
    });
    if (!r.ok) return r;
    out.push(...r.value.items);
    if (!r.value.cursor) break;
    cursor = r.value.cursor;
  }
  return { ok: true, value: out };
}

/** One account; `null` when Unipile no longer has it (404). */
export async function getUnipileAccount(
  opts: ProviderOptions,
  id: string,
): Promise<ProviderResult<UnipileAccountRow | null>> {
  if (!configured(opts)) return unconfigured('unipile', 'API key or base URL');
  return requestJson(opts, {
    provider: 'unipile',
    url: `${trimBase(opts.baseUrl ?? '')}/api/v1/accounts/${encodeURIComponent(id)}`,
    headers: headers(opts),
    schema: unipileAccountSchema.nullable(),
    emptyOn: [404],
    onEmpty: () => null,
  });
}

/** Unlinks one account. Already gone (404) counts as unlinked. */
export async function deleteUnipileAccount(
  opts: ProviderOptions,
  id: string,
): Promise<ProviderResult<{ deleted: boolean }>> {
  if (!configured(opts)) return unconfigured('unipile', 'API key or base URL');
  const r = await requestJson(opts, {
    provider: 'unipile',
    url: `${trimBase(opts.baseUrl ?? '')}/api/v1/accounts/${encodeURIComponent(id)}`,
    method: 'DELETE',
    headers: headers(opts),
    schema: z.looseObject({ object: z.string().nullish() }).nullable(),
    emptyOn: [404],
    onEmpty: () => null,
  });
  if (r.ok) return { ok: true, value: { deleted: r.value !== null } };
  // a 2xx whose body is not the documented shape still unlinked the account ('invalid' only follows a 2xx)
  if (r.kind === 'invalid') return { ok: true, value: { deleted: true } };
  return r;
}
