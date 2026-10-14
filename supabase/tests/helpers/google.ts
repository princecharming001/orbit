/** A stand-in for Google's token endpoint and JWKS: id_tokens signed with a local RSA key. */
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from 'jose';

export const CLIENT_ID = 'client-id-placeholder.apps.googleusercontent.com';

export interface FakeGoogle {
  jwks: JWTVerifyGetKey;
  idToken(
    claims?: Record<string, unknown>,
    opts?: { aud?: string; iss?: string; expSec?: number },
  ): Promise<string>;
}

export async function fakeGoogle(): Promise<FakeGoogle> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return {
    jwks,
    async idToken(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        email: 'maya@example.com',
        email_verified: true,
        name: 'Maya Chen',
        given_name: 'Maya',
        family_name: 'Chen',
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(String(claims.sub ?? 'google-sub-1'))
        .setIssuer(opts.iss ?? 'https://accounts.google.com')
        .setAudience(opts.aud ?? CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + (opts.expSec ?? 3600))
        .sign(privateKey);
    },
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that records calls and answers from a route function. */
export function recordingFetch(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init.body == null ? '' : typeof init.body === 'string' ? init.body : String(init.body);
    const call = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
