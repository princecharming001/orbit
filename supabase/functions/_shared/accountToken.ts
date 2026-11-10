/**
 * A connected LinkedIn account's token for orbit-connectors' account routes (profiles, companies): base64url
 * HMAC-SHA256 of `unipile-account:<id>` with the signing key (the service role key in production). orbit-connectors
 * hands it to the browser that connected the account; orbit-api hands it to a signed-in student for their own account,
 * so the same reads serve both. Must stay the same as accountToken in orbit-connectors/connectors.ts (a test checks).
 */
export async function accountToken(accountId: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`unipile-account:${accountId}`)),
  );
  return btoa(String.fromCharCode(...sig))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * The token orbit-api hands a signed-in student for their own account (POST /linkedin/reader): a second version, so
 * a first-version token for such an account, which /connect/status could hand out by user id until 2026-11-05 (that
 * route names a server-linked account after its owner's id), no longer passes anywhere.
 */
export function accountTokenV2(accountId: string, signingKey: string): Promise<string> {
  return accountToken(`v2:${accountId}`, signingKey);
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether `token` opens `accountId`: a second-version token always; a first-version one only for an account a browser
 * linked through /connect/start (Orbit keeps each of those sign-ins: `linkedBrowserKept`), never for one linked
 * through orbit-api.
 */
export async function accountTokenOk(
  accountId: string,
  token: unknown,
  signingKey: string | undefined,
  browserKept: (accountId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!signingKey || !accountId || typeof token !== 'string' || !token) return false;
  if (sameText(await accountTokenV2(accountId, signingKey), token)) return true;
  if (!sameText(await accountToken(accountId, signingKey), token)) return false;
  return browserKept(accountId).catch(() => false);
}

/** The status Unipile reports to /connect/notify when a hosted sign-in made a new account. */
export const LINK_CREATED = 'CREATION_SUCCESS';

/**
 * Whether an account was linked by a browser through /connect/start, from Orbit's own record of those sign-ins
 * (public.orbit_unipile_links: /connect/notify writes a row, under the signed reference only /connect/start issues,
 * when Unipile reports the new account). `created` reads that record.
 *
 * Until 2026-11-10 this asked Unipile for the account's name and expected the sign-in's reference there. Unipile
 * names a LinkedIn account after the person, and hands the reference back only to notify_url, so every account a
 * browser linked was refused: "LinkedIn did not answer (403)" on the first sync after connecting.
 *
 * A yes is remembered for an hour. A no is asked again each time (a sign-in that has just finished must pass at
 * once), and a record that cannot be read counts as no.
 */
export function linkedBrowserKept(
  created: (accountId: string) => Promise<boolean>,
  now: () => number = Date.now,
): (accountId: string) => Promise<boolean> {
  const yes = new Map<string, number>();
  return async (accountId) => {
    if (!accountId) return false;
    const at = yes.get(accountId);
    if (at !== undefined && now() - at < 3_600_000) return true;
    if (!(await created(accountId))) return false;
    yes.set(accountId, now());
    return true;
  };
}

/** `created` over PostgREST with the service role key: a new-account row for this account in orbit_unipile_links. */
export function postgrestLinkCreated(
  url: string | undefined,
  serviceKey: string | undefined,
  doFetch: typeof fetch = fetch,
): (accountId: string) => Promise<boolean> {
  return async (accountId) => {
    if (!url || !serviceKey) return false;
    const r = await doFetch(
      `${url}/rest/v1/orbit_unipile_links?account_id=eq.${encodeURIComponent(accountId)}&status=eq.${LINK_CREATED}&select=ref&limit=1`,
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!r.ok) {
      await r.body?.cancel();
      return false;
    }
    return ((await r.json()) as unknown[]).length > 0;
  };
}
