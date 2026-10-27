/**
 * Reading a page straight from its site, for nothing: the investigator loop fetches each page itself (no paid reader),
 * keeps its readable text, the title and description its own tags give, and the links on it that point at someone's
 * profile on a known site (GitHub, X, Instagram, YouTube, a Linktree...), which is how the loop follows a person's
 * own links. A page that cannot be fetched (blocked, too slow, not HTML) answers undefined and the caller keeps the
 * search engine's excerpt instead. Blocked sites (guards.ts) are never fetched.
 */
import { isBlockedSource } from './guards';

/** Characters of a page kept for reading. */
export const PAGE_TEXT_CHARS = 9000;
/** Bytes of HTML read at most. */
const MAX_BYTES = 1_500_000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
  /** profile links on the page: https://github.com/dana, https://x.com/dana */
  profiles: string[];
  published?: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`,
    'i',
  );
  const m = re.exec(html);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v).trim() : undefined;
}

/** The readable text of an HTML page: no scripts, styles or navigation chrome, block elements on their own lines. */
export function htmlToText(html: string): { title?: string; text: string; published?: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim() || undefined;
  const description = meta(html, 'og:description') ?? meta(html, 'description');
  const ogTitle = meta(html, 'og:title');
  const published = meta(html, 'article:published_time') ?? meta(html, 'og:published_time');
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|blockquote|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  // the page's own summary first: a profile page that renders in the browser often carries only its tags
  const head = [ogTitle && ogTitle !== title ? ogTitle : '', description ?? ''].filter(Boolean).join('\n');
  return { title: title ?? ogTitle, text: [head, text].filter(Boolean).join('\n\n'), published };
}

/** Profile pages on the sites the loop knows: a person's own account there, never a post, a search or a home page. */
const PROFILE_RES: RegExp[] = [
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/?$/i,
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i,
  /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\/?$/i,
  /^https?:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9_.-]{3,30})\/?$/i,
  /^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,24})\/?$/i,
  /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@([A-Za-z0-9_.]{1,30})\/?$/i,
  /^https?:\/\/(?:www\.)?medium\.com\/@([A-Za-z0-9_.-]{1,30})\/?$/i,
  /^https?:\/\/([a-z0-9-]{2,40})\.substack\.com\/?$/i,
  /^https?:\/\/(?:www\.)?linktr\.ee\/([A-Za-z0-9_.]{2,30})\/?$/i,
  /^https?:\/\/(?:www\.)?behance\.net\/([A-Za-z0-9_-]{2,30})\/?$/i,
  /^https?:\/\/(?:www\.)?dribbble\.com\/([A-Za-z0-9_-]{2,30})\/?$/i,
  /^https?:\/\/(?:www\.)?devpost\.com\/([A-Za-z0-9_-]{2,40})\/?$/i,
  /^https?:\/\/(?:www\.)?huggingface\.co\/([A-Za-z0-9_-]{2,40})\/?$/i,
  /^https?:\/\/bsky\.app\/profile\/([A-Za-z0-9_.-]{3,60})\/?$/i,
];

/** Never someone's handle: the sites' own pages that look like one. */
const NOT_HANDLES = new Set([
  'about',
  'explore',
  'home',
  'login',
  'signup',
  'search',
  'settings',
  'share',
  'intent',
  'features',
  'pricing',
  'topics',
  'trending',
  'sponsors',
  'orgs',
  'www',
  'help',
  'privacy',
  'terms',
]);

/** The handle a profile link names, or undefined when the link is not someone's profile on a known site. */
export function profileHandle(url: string): string | undefined {
  for (const re of PROFILE_RES) {
    const m = re.exec(url.trim());
    if (m?.[1] && !NOT_HANDLES.has(m[1].toLowerCase())) return m[1];
  }
  return undefined;
}

/** The profile links an HTML page points to, absolute, deduped. */
export function profileLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let u: string;
    try {
      u = new URL(decodeEntities(m[1]!), base).toString();
    } catch {
      continue;
    }
    if (profileHandle(u)) out.add(u.replace(/\/+$/, ''));
  }
  return [...out].slice(0, 40);
}

/** Fetch one page and read it; undefined when it cannot be read. */
export async function fetchPage(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchedPage | undefined> {
  if (isBlockedSource(url) || !/^https?:\/\//i.test(url)) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const r = await (opts.fetch ?? fetch)(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en' },
    });
    if (!r.ok) return undefined;
    const type = r.headers.get('content-type') ?? '';
    if (type && !/html|xml|text\/plain/i.test(type)) return undefined;
    const raw = (await r.text()).slice(0, MAX_BYTES);
    const finalUrl = r.url || url;
    if (/text\/plain/i.test(type))
      return { url: finalUrl, text: raw.slice(0, PAGE_TEXT_CHARS), profiles: [], published: null };
    const read = htmlToText(raw);
    if (!read.text.trim()) return undefined;
    return {
      url: finalUrl,
      title: read.title,
      text: read.text.slice(0, PAGE_TEXT_CHARS),
      profiles: profileLinks(raw, finalUrl),
      published: read.published ?? null,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
