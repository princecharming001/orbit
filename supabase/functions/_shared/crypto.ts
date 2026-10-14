/** Small crypto helpers on Web Crypto (available in Deno and Node 20+). */

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Decodes standard or url-safe base64; undefined when the text is not base64. */
export function fromBase64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return undefined;
  try {
    return fromBase64url(text.replace(/=+$/, ''));
  } catch {
    return undefined;
  }
}

/** n random bytes as base64url (32 bytes → 43 characters). */
export function randomToken(n = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256Bytes(text), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Compares two secrets in time that does not depend on where they differ (both are hashed to equal length). */
export async function timingSafeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
