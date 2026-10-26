/**
 * Reading a job posting (plan 23 §4.1), for orbit-connectors' /posting route. The browser cannot fetch another site,
 * so the page is fetched here (Greenhouse, Lever, Ashby, Workday, LinkedIn Jobs, a company's careers page), cut to
 * its text, and a small model returns one fixed shape: the company, the role, the team, the location, the level, a
 * deadline, the requisition id, and the names the page gives for recruiters and managers. "Not a posting" and "a
 * careers list" are answers too. A page that carries schema.org JobPosting data is read from that first: it is what
 * the job boards publish for search engines, and it needs no model at all.
 *
 * Postings are public, so answers are cached by the address (hashed) for 7 days and shared. Kept free of Deno APIs
 * so it runs under Node tests.
 */

export interface Posting {
  company: string;
  role: string;
  team?: string;
  location?: string;
  level?: string;
  /** YYYY-MM-DD */
  deadline?: string;
  requisitionId?: string;
  namesOnPage: { recruiters: string[]; managers: string[] };
  url?: string;
}

export type PostingAnswer =
  | { ok: true; posting: Posting; cached?: boolean; source: 'jsonld' | 'model' | 'text' }
  | {
      ok: false;
      reason: 'not_a_posting' | 'careers_list' | 'unreachable' | 'unconfigured' | 'limit' | 'bad_request';
      message: string;
    };

export interface PostingCache {
  get(key: string): Promise<PostingAnswer | undefined>;
  put(key: string, url: string, value: PostingAnswer): Promise<void>;
}

export interface PostingDeps {
  anthropicKey?: string;
  /** claude-haiku-5-5 unless set */
  model?: string;
  cache?: PostingCache;
  fetch?: typeof fetch;
  /** how long a page fetch may take; the research function's 8 seconds */
  timeoutMs?: number;
}

/** The research function's user agent, so a site sees the same reader. */
export const POSTING_USER_AGENT =
  'Mozilla/5.0 (compatible; OrbitResearch/1.0; +https://tryorbit.today/remove-me)';
export const POSTING_TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 14_000;
export const POSTING_MODEL = 'claude-haiku-5-5';

/** Addresses this route never fetches: anything that is not public http(s) on a normal host. */
export function postingUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'That is not a link.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only web links can be read.';
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':') ||
    !host.includes('.')
  )
    return 'That link cannot be read.';
  if (u.username || u.password) return 'That link cannot be read.';
  return undefined;
}

/** The cache key: the address without its tracking parameters or fragment, hashed. */
export async function postingKey(raw: string): Promise<string> {
  const u = new URL(raw);
  u.hash = '';
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|gh_src|source|ref|lever-source|trk|refid|trackingid)/i.test(k)) u.searchParams.delete(k);
  const norm = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return `posting:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

/** A page's readable text: no scripts, styles or tags, blocks on their own lines. */
export function pageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A model's way of saying it does not know ("<UNKNOWN>", "N/A", "not specified") is no value. */
const NO_VALUE =
  /^[<([]?\s*(unknown|n\/?a|none|null|not (stated|specified|listed|given|mentioned))\s*[>)\]]?\.?$/i;

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const t = decodeEntities(v.trim()).replace(/\s+/g, ' ').slice(0, 200);
  return NO_VALUE.test(t) ? undefined : t;
};

/** schema.org JobPosting data on the page, when the board publishes it. */
export function jsonLdPosting(html: string): Posting | undefined {
  const blocks = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];
  for (const b of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(b[1]!.trim());
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data]).flatMap((d) =>
      d && typeof d === 'object' && Array.isArray((d as { '@graph'?: unknown[] })['@graph'])
        ? (d as { '@graph': unknown[] })['@graph']
        : [d],
    );
    for (const it of items) {
      const o = it as Record<string, unknown>;
      const type = o?.['@type'];
      if (!(type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))) continue;
      const org = o.hiringOrganization as Record<string, unknown> | string | undefined;
      const company = typeof org === 'string' ? str(org) : str(org?.name);
      const role = str(o.title);
      if (!company || !role) continue;
      const locs = (Array.isArray(o.jobLocation) ? o.jobLocation : [o.jobLocation]) as Record<
        string,
        unknown
      >[];
      const addr = locs.map((l) => (l?.address ?? {}) as Record<string, unknown>)[0] ?? {};
      const location =
        [str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean).join(', ') ||
        (o.jobLocationType === 'TELECOMMUTE' ? 'Remote' : undefined);
      const through = str(o.validThrough);
      const ident = o.identifier as Record<string, unknown> | string | undefined;
      return {
        company,
        role,
        location: location || undefined,
        deadline: through && /^\d{4}-\d\d-\d\d/.test(through) ? through.slice(0, 10) : undefined,
        requisitionId: typeof ident === 'string' ? str(ident) : str(ident?.value),
        namesOnPage: { recruiters: [], managers: [] },
      };
    }
  }
  return undefined;
}

/** The page's own title, which job boards write as "Role at Company" or "Company - Role". */
function titleOf(html: string): string | undefined {
  return str(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
}

/** What the model must return: one call, one tool, this shape. */
const POSTING_TOOL = {
  name: 'posting',
  description: 'Record what this page says about one job opening.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['posting', 'careers_list', 'not_a_posting'],
        description:
          'posting: the page is one job opening. careers_list: a list of openings with no single role. not_a_posting: anything else (a blog post, a news story, a product page).',
      },
      company: { type: 'string', description: 'The hiring company as the page names it, not the job board.' },
      role: { type: 'string', description: 'The job title exactly as written.' },
      team: { type: 'string', description: 'The team or group the role is on, when the page names one.' },
      location: { type: 'string', description: 'City and region, or Remote.' },
      level: { type: 'string', description: 'Intern, new grad, junior, senior, and so on, when stated.' },
      deadline: { type: 'string', description: 'The application deadline as YYYY-MM-DD, only when stated.' },
      requisitionId: { type: 'string', description: 'The requisition or job id, when shown.' },
      recruiters: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full names the page gives as recruiters or contacts for this role. Never guess.',
      },
      managers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full names the page gives as the hiring manager or team lead. Never guess.',
      },
    },
    required: ['kind'],
  },
} as const;

const SYSTEM =
  "You read one web page and record whether it is a single job posting and, if it is, what it says. Copy names, titles and places exactly as the page writes them, in the page's language. Leave out anything the page does not state. A page listing many openings is a careers_list. Never invent a person's name.";

interface ModelOut {
  kind?: string;
  company?: string;
  role?: string;
  team?: string;
  location?: string;
  level?: string;
  deadline?: string;
  requisitionId?: string;
  recruiters?: string[];
  managers?: string[];
}

async function askModel(deps: PostingDeps, text: string, url: string | undefined, doFetch: typeof fetch) {
  const res = await doFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': deps.anthropicKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: deps.model ?? POSTING_MODEL,
      max_tokens: 800,
      system: SYSTEM,
      tools: [POSTING_TOOL],
      tool_choice: { type: 'tool', name: 'posting' },
      messages: [
        {
          role: 'user',
          content: `${url ? `Address: ${url}\n\n` : ''}Page text:\n${text.slice(0, MAX_TEXT)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const body = (await res.json()) as { content?: { type: string; input?: ModelOut }[] };
  return body.content?.find((c) => c.type === 'tool_use')?.input ?? {};
}

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x))
        .filter((x): x is string => !!x && x.split(' ').length >= 2 && x.length <= 60)
        .slice(0, 5)
    : [];

function fromModel(o: ModelOut, url?: string): PostingAnswer {
  if (o.kind === 'careers_list')
    return {
      ok: false,
      reason: 'careers_list',
      message: "That's the careers page. Pick a role and paste its link, or go with the company.",
    };
  const company = str(o.company);
  const role = str(o.role);
  if (o.kind !== 'posting' || !company || !role)
    return {
      ok: false,
      reason: 'not_a_posting',
      message: "That page doesn't look like a job posting. Try the company name.",
    };
  const deadline = str(o.deadline);
  return {
    ok: true,
    source: 'model',
    posting: {
      company,
      role,
      team: str(o.team),
      location: str(o.location),
      level: str(o.level),
      deadline: deadline && /^\d{4}-\d\d-\d\d$/.test(deadline) ? deadline : undefined,
      requisitionId: str(o.requisitionId),
      namesOnPage: { recruiters: names(o.recruiters), managers: names(o.managers) },
      url,
    },
  };
}

/** Fetch a page as text, never more than MAX_BYTES, within the timeout. */
async function fetchPage(url: string, deps: PostingDeps, doFetch: typeof fetch): Promise<string | undefined> {
  // redirects are followed by hand, a few at most, each checked like the first address
  const signal = AbortSignal.timeout(deps.timeoutMs ?? POSTING_TIMEOUT_MS);
  let at = url;
  let res: Response | undefined;
  for (let hop = 0; hop < 4; hop++) {
    res = await doFetch(at, {
      headers: {
        'user-agent': POSTING_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
      },
      redirect: 'manual',
      signal,
    });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) break;
    at = new URL(next, at).toString();
    if (postingUrlProblem(at)) return undefined;
    res = undefined;
  }
  if (!res?.ok) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type && !/html|text|xml|json/i.test(type)) return undefined;
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, MAX_BYTES));
  let filled = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - filled));
    all.set(part, filled);
    filled += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * Read a posting from its address or its pasted text. Never throws: an unreachable page, a model that fails or a
 * key that is not set comes back as an answer the app can show.
 */
export async function readPosting(
  input: { url?: string; text?: string },
  deps: PostingDeps,
  opts: { take?: () => Promise<boolean> } = {},
): Promise<PostingAnswer> {
  const doFetch = deps.fetch ?? fetch;
  const url = input.url?.trim();
  if (url) {
    const problem = postingUrlProblem(url);
    if (problem) return { ok: false, reason: 'bad_request', message: problem };
    const key = await postingKey(url);
    const hit = await deps.cache?.get(key).catch(() => undefined);
    if (hit) return hit.ok ? { ...hit, cached: true } : hit;
    if (opts.take && !(await opts.take()))
      return {
        ok: false,
        reason: 'limit',
        message: 'Orbit has read as many postings as it allows today. Paste the company name instead.',
      };
    let html: string | undefined;
    try {
      html = await fetchPage(url, deps, doFetch);
    } catch {
      html = undefined;
    }
    if (!html)
      return {
        ok: false,
        reason: 'unreachable',
        message: "Orbit couldn't open that page. Paste the posting's text, or the company name.",
      };
    let answer: PostingAnswer;
    const ld = jsonLdPosting(html);
    if (ld) answer = { ok: true, source: 'jsonld', posting: { ...ld, url } };
    else if (!deps.anthropicKey)
      return {
        ok: false,
        reason: 'unconfigured',
        message: 'Reading postings is not set up yet. Paste the company name.',
      };
    else {
      const text = `${titleOf(html) ?? ''}\n${pageText(html)}`.trim();
      try {
        answer = fromModel(await askModel(deps, text, url, doFetch), url);
      } catch {
        return {
          ok: false,
          reason: 'unreachable',
          message: "Orbit couldn't read that page just now. Paste the company name.",
        };
      }
    }
    // a page that names its team and people in the text: the model fills in what the structured data leaves out
    if (answer.ok && answer.source === 'jsonld' && deps.anthropicKey) {
      try {
        const more = fromModel(await askModel(deps, pageText(html), url, doFetch), url);
        if (more.ok)
          answer = {
            ...answer,
            posting: {
              ...answer.posting,
              team: answer.posting.team ?? more.posting.team,
              level: answer.posting.level ?? more.posting.level,
              namesOnPage: more.posting.namesOnPage,
            },
          };
      } catch {
        // the structured data alone is enough
      }
    }
    if (answer.ok || answer.reason === 'not_a_posting' || answer.reason === 'careers_list')
      await deps.cache?.put(key, url, answer).catch(() => undefined);
    return answer;
  }
  const text = input.text?.trim();
  if (!text) return { ok: false, reason: 'bad_request', message: 'Paste a job link or the posting text.' };
  if (!deps.anthropicKey)
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'Reading postings is not set up yet. Paste the company name.',
    };
  if (opts.take && !(await opts.take()))
    return {
      ok: false,
      reason: 'limit',
      message: 'Orbit has read as many postings as it allows today. Paste the company name instead.',
    };
  try {
    return fromModel(await askModel(deps, text.slice(0, MAX_TEXT), undefined, doFetch));
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: "Orbit couldn't read that just now. Paste the company name.",
    };
  }
}

/** The posting cache over PostgREST: two service-role-only functions over orbit_private.posting_cache. */
export function postgrestPostingCache(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): PostingCache {
  const headers = {
    'content-type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  return {
    get: async (key) => {
      const r = await doFetch(`${url}/rest/v1/rpc/orbit_posting_get`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_key: key }),
      });
      if (!r.ok) return undefined;
      return ((await r.json()) as PostingAnswer | null) ?? undefined;
    },
    put: async (key, pageUrl, value) => {
      await doFetch(`${url}/rest/v1/rpc/orbit_posting_put`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_key: key, p_url: pageUrl, p_value: value }),
      });
    },
  };
}

export function memoryPostingCache(): PostingCache {
  const m = new Map<string, PostingAnswer>();
  return {
    get: async (k) => m.get(k),
    put: async (k, _u, v) => {
      m.set(k, v);
    },
  };
}
