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
 * linked through /connect/start (Unipile names those orbit_<random>), never for one linked through orbit-api.
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

/**
 * Asks Unipile whether an account was linked through /connect/start (its name is orbit_<random>), remembering each
 * answer for an hour. Anything Unipile cannot answer counts as no, and is asked again next time.
 */
export function unipileBrowserKept(
  base: string | undefined,
  key: string | undefined,
  doFetch: typeof fetch,
  now: () => number = Date.now,
): (accountId: string) => Promise<boolean> {
  const known = new Map<string, { kept: boolean; at: number }>();
  return async (accountId) => {
    if (!base || !key) return false;
    const hit = known.get(accountId);
    if (hit && now() - hit.at < 3_600_000) return hit.kept;
    const res = await doFetch(`${base}/api/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { accept: 'application/json', 'X-API-KEY': key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const a = (await res.json()) as { name?: unknown };
    const kept = typeof a.name === 'string' && /^orbit_[A-Za-z0-9-]{4,64}$/.test(a.name);
    known.set(accountId, { kept, at: now() });
    return kept;
  };
}
