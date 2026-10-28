/**
 * Which browser origins may call Orbit's functions, and the caller's IP. Shared by orbit-claude, orbit-connectors
 * and the account-mode functions. Kept free of Deno APIs so it runs under Node tests.
 */

/** Orbit's published app (its own domain and the GitHub Pages address) and any local dev server. */
const PUBLISHED = new Set([
  'https://tryorbit.today',
  'https://www.tryorbit.today',
  'https://princecharming001.github.io',
]);

export function defaultOrigins(origin: string): boolean {
  if (PUBLISHED.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * The caller's address for rate limits: the headers the platform sets itself come first. The first
 * x-forwarded-for entry is whatever the caller sent, so it is only a last resort (the last hop, added by a proxy).
 */
export function clientIp(req: Request): string {
  const set = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  if (set) return set.trim();
  const xff = req.headers.get('x-forwarded-for');
  return xff ? xff.split(',').at(-1)!.trim() : 'unknown';
}
