/**
 * A person's accounts on other sites, from a username they are known to use (docs/plan/20, investigator loop). The
 * sites and how each tells an existing account from a missing one come from Maigret's site database
 * (https://github.com/soxoj/maigret, MIT licence, data.json): only work, writing, code, design and hobby sites, never
 * payment, dating or adult ones, and none that need a logged-in token. Only two kinds of username are ever checked:
 * one the person published themselves (a link on a page already shown to be theirs), and a LinkedIn address that is a
 * distinctive word (ten letters or more, no numbers): a common or generated one would find strangers. An account found
 * here is never cited on its own: its page goes through the same identity check as any other page.
 */

export interface HandleSite {
  name: string;
  /** the profile address, {u} for the username */
  url: string;
  /** where to check, when not the profile itself */
  probe?: string;
  /** status: a 2xx answer means it exists; absent: it exists unless one of `strs` is in the body; present: it exists when one is */
  check: 'status' | 'absent' | 'present';
  strs?: string[];
  headers?: Record<string, string>;
  /** usernames the site allows */
  pattern?: RegExp;
}

/** From Maigret's data.json, checked against it on 2026-10-27. */
export const HANDLE_SITES: HandleSite[] = [
  {
    name: 'GitHub',
    url: 'https://github.com/{u}',
    probe: 'https://api.github.com/users/{u}',
    check: 'status',
    pattern: /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/,
  },
  {
    name: 'YouTube',
    url: 'https://www.youtube.com/@{u}/about',
    check: 'present',
    strs: ['visitorData'],
    headers: { 'user-agent': 'curl/8.6.0', accept: '*/*' },
    pattern: /^[^/]+$/,
  },
  { name: 'Medium', url: 'https://medium.com/@{u}', probe: 'https://medium.com/feed/@{u}', check: 'status' },
  {
    name: 'Substack',
    url: 'https://substack.com/@{u}',
    probe: 'https://substack.com/api/v1/user/{u}/public_profile',
    check: 'status',
  },
  {
    name: 'Hugging Face',
    url: 'https://huggingface.co/{u}',
    probe: 'https://huggingface.co/api/users/{u}/overview',
    check: 'status',
  },
  { name: 'Behance', url: 'https://www.behance.net/{u}', check: 'status', headers: { 'user-agent': 'Curl' } },
  {
    name: 'Dribbble',
    url: 'https://dribbble.com/{u}',
    check: 'absent',
    strs: ['Whoops, that page is gone.'],
    pattern: /^[a-zA-Z][a-zA-Z0-9_-]*$/,
  },
  { name: 'Linktree', url: 'https://linktr.ee/{u}', check: 'status' },
  { name: 'DEV', url: 'https://dev.to/{u}', check: 'status', pattern: /^[a-zA-Z][a-zA-Z0-9_-]*$/ },
  {
    name: 'GitLab',
    url: 'https://gitlab.com/{u}',
    probe: 'https://gitlab.com/api/v4/users?username={u}',
    check: 'absent',
    strs: ['[]'],
  },
  {
    name: 'Bluesky',
    url: 'https://bsky.app/profile/{u}.bsky.social',
    probe: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={u}.bsky.social',
    check: 'present',
    strs: ['"did"'],
  },
  {
    name: 'Chess.com',
    url: 'https://www.chess.com/member/{u}',
    probe: 'https://api.chess.com/pub/player/{u}',
    check: 'present',
    strs: ['"player_id":'],
  },
  {
    name: 'Letterboxd',
    url: 'https://letterboxd.com/{u}',
    check: 'absent',
    strs: ['Sorry, we can’t find the page you’ve requested.'],
  },
  {
    name: 'CodePen',
    url: 'https://codepen.io/{u}',
    check: 'absent',
    strs: ["I'm afraid you've found a page that doesn't exist on CodePen"],
  },
  {
    name: 'Speaker Deck',
    url: 'https://speakerdeck.com/{u}',
    check: 'absent',
    strs: ['User Not Found'],
    pattern: /^[^.]+$/,
  },
];

/**
 * A LinkedIn address worth checking elsewhere: one distinctive word (no hyphen-and-number tail LinkedIn adds, no digits,
 * ten letters or more). "vaibhavhariram" yes; "zion-darko-8a0b78190" and "danaliu" no.
 */
export function distinctiveSlug(slug: string | undefined): string | undefined {
  const s = (slug ?? '').toLowerCase().trim();
  return /^[a-z]{10,30}$/.test(s) ? s : undefined;
}

export interface FoundAccount {
  site: string;
  url: string;
  handle: string;
}

/** Whether one site has an account under the username. */
async function exists(site: HandleSite, handle: string, doFetch: typeof fetch, timeoutMs: number) {
  if (site.pattern && !site.pattern.test(handle)) return false;
  const target = (site.probe ?? site.url).replaceAll('{u}', encodeURIComponent(handle));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await doFetch(target, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Orbit research)', ...(site.headers ?? {}) },
    });
    if (site.check === 'status') return r.ok;
    if (!r.ok && r.status !== 404) return false;
    const body = (await r.text()).slice(0, 400_000);
    if (site.check === 'absent') return r.ok && !(site.strs ?? []).some((s) => body.includes(s));
    return (site.strs ?? []).some((s) => body.includes(s));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Every site where the usernames have an account, all checked at once. */
export async function findAccounts(
  handles: string[],
  opts: { fetch?: typeof fetch; timeoutMs?: number; sites?: HandleSite[] } = {},
): Promise<FoundAccount[]> {
  const doFetch = opts.fetch ?? fetch;
  const sites = opts.sites ?? HANDLE_SITES;
  const unique = [...new Set(handles.map((h) => h.trim()).filter((h) => h.length >= 3))].slice(0, 3);
  const checks = unique.flatMap((handle) =>
    sites.map(async (site) =>
      (await exists(site, handle, doFetch, opts.timeoutMs ?? 6000))
        ? { site: site.name, handle, url: site.url.replaceAll('{u}', encodeURIComponent(handle)) }
        : undefined,
    ),
  );
  return (await Promise.all(checks)).filter((x): x is FoundAccount => !!x);
}
