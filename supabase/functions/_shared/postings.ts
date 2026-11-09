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
  | { ok: true; posting: Posting; cached?: boolean; source: 'board' | 'jsonld' | 'model' | 'text' }
  | {
      ok: false;
      reason:
        | 'not_a_posting'
        | 'careers_list'
        | 'closed'
        | 'unreachable'
        | 'unconfigured'
        | 'limit'
        | 'bad_request';
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

/**
 * A job on a board, named by the address: Greenhouse ids (`gh_jid`, or the board's own /{board}/jobs/{id} and embed
 * addresses) and Ashby ids (`ashby_jid`). Company sites embed these boards with script, so their own page is an empty
 * shell ("Loading job application…"); the board says what the job is. Both ids are unique across all of the board.
 */
export type BoardJob =
  | { board: 'greenhouse'; id: string; token?: string; eu?: boolean }
  | { board: 'ashby'; id: string; org?: string };

const GREENHOUSE_HOST = /^(?:boards|job-boards)(\.eu)?\.greenhouse\.io$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;

export function boardJobOf(raw: string): BoardJob | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const gh = GREENHOUSE_HOST.exec(u.hostname);
  const forParam = u.searchParams.get('for') ?? undefined;
  if (gh) {
    const eu = !!gh[1];
    const token = parts[0] && parts[0] !== 'embed' && SLUG.test(parts[0]) ? parts[0] : forParam;
    const id =
      (parts[1] === 'jobs' && parts[2]) ||
      u.searchParams.get('gh_jid') ||
      (parts[0] === 'embed' ? u.searchParams.get('token') : null);
    if (id && /^\d{4,}$/.test(id)) return { board: 'greenhouse', id, token: token || undefined, eu };
  }
  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid && /^\d{4,}$/.test(ghJid))
    return { board: 'greenhouse', id: ghJid, token: forParam && SLUG.test(forParam) ? forParam : undefined };
  const ashby = u.searchParams.get('ashby_jid');
  if (ashby && UUID.test(ashby) && !/(^|\.)ashbyhq\.com$/i.test(u.hostname))
    return { board: 'ashby', id: ashby };
  return undefined;
}

/** The address a board job is cached under: its id alone, so tracking parameters and embedding sites share one read. */
export function boardJobKey(job: BoardJob): string {
  return job.board === 'greenhouse'
    ? `https://boards.greenhouse.io/job/${job.id}`
    : `https://jobs.ashbyhq.com/job/${job.id}`;
}

/** "neuralink.com", "careers.neuralink.com", "jobs.acme.co.uk": the names a company's board is likely kept under. */
function siteNames(raw: string): string[] {
  try {
    const labels = new URL(raw).hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.');
    const generic =
      /^(www|jobs|careers|career|apply|boards|job-boards|work|join|hire|talent|co|com|org|net|io)$/;
    return [...new Set(labels.filter((l) => l.length > 1 && !generic.test(l)).slice(0, 2))];
  } catch {
    return [];
  }
}

interface BoardRead {
  posting: Posting;
  source: 'board' | 'jsonld';
  /** the job's words, for the optional pass that finds the team, the level and the names on it */
  text: string;
}

type BoardOutcome = BoardRead | 'closed' | undefined;

const boardHeaders = { 'user-agent': POSTING_USER_AGENT, accept: 'application/json' };

/** Greenhouse's embed answers a bare job id with the board's address: …/embed/job_app?for=<board>&token=<id>. */
async function greenhouseBoardOf(
  id: string,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<{ token: string; eu: boolean } | undefined> {
  try {
    const res = await doFetch(`https://boards.greenhouse.io/embed/job_app?token=${id}`, {
      headers: { 'user-agent': POSTING_USER_AGENT },
      redirect: 'manual',
      signal,
    });
    const at = res.headers.get('location');
    if (!at) return undefined;
    const u = new URL(at, 'https://boards.greenhouse.io');
    const token = u.searchParams.get('for');
    return token && SLUG.test(token) ? { token, eu: /\.eu\.greenhouse\.io$/i.test(u.hostname) } : undefined;
  } catch {
    return undefined;
  }
}

/** One job from Greenhouse's public job board API, or 'closed' when the board answers that it has no such job. */
async function greenhouseJob(
  token: string,
  id: string,
  eu: boolean,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<BoardOutcome> {
  const res = await doFetch(
    `https://boards-api${eu ? '.eu' : ''}.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${id}`,
    { headers: boardHeaders, signal },
  );
  if (res.status === 404) return 'closed';
  if (!res.ok) return undefined;
  const j = (await res.json()) as Record<string, unknown>;
  const role = str(j.title);
  if (!role) return undefined;
  const company =
    str(j.company_name) ?? token.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const deadline = str(j.application_deadline);
  const dept = (Array.isArray(j.departments) ? j.departments[0] : undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    source: 'board',
    posting: {
      company,
      role,
      team: str(dept?.name),
      location: str((j.location as Record<string, unknown> | undefined)?.name),
      deadline: deadline && /^\d{4}-\d\d-\d\d/.test(deadline) ? deadline.slice(0, 10) : undefined,
      requisitionId: str(j.requisition_id),
      namesOnPage: { recruiters: [], managers: [] },
    },
    // the job's description comes as escaped HTML
    text: `${role} at ${company}\n${pageText(decodeEntities(typeof j.content === 'string' ? j.content : ''))}`,
  };
}

/** Board names written into a page: Greenhouse's embed script (job_board/js?for=X) and links to the board. */
function boardNamesIn(html: string | undefined, re: RegExp): string[] {
  if (!html) return [];
  const out = new Set<string>();
  for (const m of decodeEntities(html).matchAll(re)) if (m[1] && SLUG.test(m[1])) out.add(m[1].toLowerCase());
  return [...out].filter((x) => !/^(embed|jobs?|v1|api)$/.test(x));
}

/**
 * Read a board job at the source. Greenhouse: the board from the address, Greenhouse's own embed redirect, the page's
 * embed script or the site's name, then the job from the public API. Ashby: the board from the page or the site's
 * name, then the job's page on jobs.ashbyhq.com, which carries JobPosting data.
 */
async function readBoardJob(
  job: BoardJob,
  pageUrl: string,
  html: string | undefined,
  deps: PostingDeps,
  doFetch: typeof fetch,
): Promise<BoardOutcome> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? POSTING_TIMEOUT_MS);
  if (job.board === 'greenhouse') {
    // `named`: the board came from Greenhouse or the address, so its "no such job" means the job has closed; a board
    // guessed from the site's name proves nothing either way
    const boards: { token: string; eu: boolean; named: boolean }[] = [];
    if (job.token) boards.push({ token: job.token, eu: !!job.eu, named: true });
    else {
      const found = await greenhouseBoardOf(job.id, doFetch, signal);
      if (found) boards.push({ ...found, named: true });
      for (const token of [
        ...boardNamesIn(
          html,
          /greenhouse\.io\/(?:embed\/job_(?:board(?:\/js)?|app)\?(?:[^"'\s<>]*?&)?for=)?([a-z0-9_.-]+)/gi,
        ),
        ...siteNames(pageUrl),
      ])
        if (!boards.some((b) => b.token === token)) boards.push({ token, eu: false, named: false });
    }
    let closed = false;
    for (const b of boards.slice(0, 4)) {
      try {
        const r = await greenhouseJob(b.token, job.id, b.eu, doFetch, signal);
        if (r === 'closed') closed ||= b.named;
        else if (r) return r;
      } catch {
        // the next board name, or the page itself
      }
    }
    return closed ? 'closed' : undefined;
  }
  for (const org of [
    ...boardNamesIn(html, /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/gi),
    ...siteNames(pageUrl),
  ].slice(0, 3)) {
    try {
      const page = await fetchPage(`https://jobs.ashbyhq.com/${org}/${job.id}`, deps, doFetch);
      const ld = page ? jsonLdPosting(page) : undefined;
      if (ld) return { posting: ld, source: 'jsonld', text: pageText(page!) };
    } catch {
      // the next name
    }
  }
  return undefined;
}

/**
 * One job link written into a page that is not itself a posting (a careers site that frames its board): the board's
 * own job address, when the page names exactly one.
 */
export function embeddedJobLink(html: string): string | undefined {
  const found = new Set<string>();
  const re =
    /https?:\/\/(?:(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?[^"'\s<>]*token=\d+[^"'\s<>]*|[a-z0-9_.-]+\/jobs\/\d+)|jobs\.(?:eu\.)?lever\.co\/[a-z0-9_.-]+\/[0-9a-f-]{36}|jobs\.ashbyhq\.com\/[a-z0-9_.-]+\/[0-9a-f-]{36}|[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[^"'\s<>]*\/job\/[^"'\s<>]+)/gi;
  for (const m of decodeEntities(html).matchAll(re)) found.add(m[0].replace(/[).,;]+$/, ''));
  return found.size === 1 ? [...found][0] : undefined;
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

/** Pages with less readable text than this are shells (or errors), not postings that were read and turned down. */
const THIN_TEXT = 600;

type UrlAnswer = PostingAnswer & { thin?: boolean };

function withoutThin(a: UrlAnswer): PostingAnswer {
  const { thin: _thin, ...rest } = a as UrlAnswer & { thin?: boolean };
  return rest as PostingAnswer;
}

const CLOSED: PostingAnswer = {
  ok: false,
  reason: 'closed',
  message: 'The job board no longer lists that job, so it may have closed. Try the company name.',
};

/** What an address says: the board behind it first, then the page's JobPosting data, an embedded job, the model. */
async function readUrl(
  url: string,
  job: BoardJob | undefined,
  deps: PostingDeps,
  doFetch: typeof fetch,
): Promise<UrlAnswer> {
  let found: BoardOutcome;
  // Greenhouse needs no page at all: the id names the job
  if (job?.board === 'greenhouse') found = await readBoardJob(job, url, undefined, deps, doFetch);
  let html: string | undefined;
  if (!found || found === 'closed') {
    try {
      html = await fetchPage(url, deps, doFetch);
    } catch {
      html = undefined;
    }
  }
  if (!found && html) {
    const ld = jsonLdPosting(html);
    if (ld) found = { posting: ld, source: 'jsonld', text: pageText(html) };
    else if (job) found = await readBoardJob(job, url, html, deps, doFetch);
    if (!found) {
      // a careers site that frames its board: the one job link the page carries
      const inner = embeddedJobLink(html);
      if (inner && inner !== url && !postingUrlProblem(inner)) {
        const innerJob = boardJobOf(inner);
        if (innerJob) found = await readBoardJob(innerJob, inner, html, deps, doFetch);
        else {
          const page = await fetchPage(inner, deps, doFetch).catch(() => undefined);
          const ld2 = page ? jsonLdPosting(page) : undefined;
          if (ld2) found = { posting: ld2, source: 'jsonld', text: pageText(page!) };
        }
      }
    }
  }
  if (found === 'closed') {
    if (!html || !jsonLdPosting(html)) return { ...CLOSED, thin: true };
    found = { posting: jsonLdPosting(html)!, source: 'jsonld', text: pageText(html) };
  }
  if (found) {
    let posting: Posting = { ...found.posting, url };
    // the job's words name the team, the level and sometimes the people; the structured data leaves those out
    if (deps.anthropicKey && found.text.trim()) {
      try {
        const more = fromModel(await askModel(deps, found.text, url, doFetch), url);
        if (more.ok)
          posting = {
            ...posting,
            team: posting.team ?? more.posting.team,
            level: posting.level ?? more.posting.level,
            namesOnPage: more.posting.namesOnPage,
          };
      } catch {
        // the structured data alone is enough
      }
    }
    return { ok: true, source: found.source, posting };
  }
  if (!html)
    return {
      ok: false,
      reason: 'unreachable',
      message: "Orbit couldn't open that page. Paste the posting's text, or the company name.",
    };
  if (!deps.anthropicKey)
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'Reading postings is not set up yet. Paste the company name.',
    };
  const body = pageText(html);
  const text = `${titleOf(html) ?? ''}\n${body}`.trim();
  try {
    const answer = fromModel(await askModel(deps, text, url, doFetch), url);
    return answer.ok ? answer : { ...answer, thin: body.length < THIN_TEXT };
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      message: "Orbit couldn't read that page just now. Paste the company name.",
    };
  }
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
    const job = boardJobOf(url);
    const key = await postingKey(job ? boardJobKey(job) : url);
    const hit = await deps.cache?.get(key).catch(() => undefined);
    if (hit) return hit.ok ? { ...hit, posting: { ...hit.posting, url }, cached: true } : hit;
    if (opts.take && !(await opts.take()))
      return {
        ok: false,
        reason: 'limit',
        message: 'Orbit has read as many postings as it allows today. Paste the company name instead.',
      };
    const answer = await readUrl(url, job, deps, doFetch);
    // a thin page (a shell that fills itself in with script) is never remembered as "not a posting": it may read
    // differently once the board behind it is known
    if (answer.ok || answer.reason === 'careers_list' || (answer.reason === 'not_a_posting' && !answer.thin))
      await deps.cache?.put(key, url, withoutThin(answer)).catch(() => undefined);
    return withoutThin(answer);
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
