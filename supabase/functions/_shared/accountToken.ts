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
