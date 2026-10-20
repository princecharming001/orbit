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

export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}
