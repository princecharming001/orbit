/**
 * orbit-research: deep research on one person, for students whose LinkedIn is connected through Orbit
 * (docs/plan/20-deep-research.md). Research starts only when the student presses Deep research on a person's About
 * tab (or Go deeper on the finished brief); nothing here runs on a schedule or on its own.
 *
 * Routes (POST, JSON, Orbit's origins only):
 *   /quick    the brief, within 90 seconds: { accountId, token, person, profile?, posts?, history?, student, chosen? }
 *   /deeper   the same body: upgrades the brief (more about them, or their company's news and hiring)
 *   /status   { accountId, token } → this month's allowance and which web search is set up
 *   /remove   { name, linkedinUrl?, email?, company? } → the public "remove me" page: Orbit never researches them again
 *
 * Who may use it: the browser holding the account token orbit-connectors' /connect/status handed out for a connected
 * LinkedIn account (an HMAC of the account id with the service role key, so the token is the server's record of the
 * connection). The allowance is counted per that account: 15 different people a month until raised
 * (ORBIT_RESEARCH_PER_MONTH), separate from the chat's budget. Asking again about the same person that month (a retry
 * after a timeout, Go deeper) is not counted again. Each call is also held to a dollar cap ($0.30 quick, $0.50 for
 * quick and deeper together), a global daily dollar cap across every student (ORBIT_RESEARCH_USD_PER_DAY, $40), and
 * request counters per visitor and per account.
 *
 * Never researched: anyone the student marked do-not-contact (the browser says so and the server refuses), anyone on
 * the removal list, and anyone with neither a LinkedIn profile nor a company to tell them from namesakes (nothing is
 * spent; the student is asked for one). The brief goes back to the browser and is kept there; this function stores
 * only the public-web cache, the allowance count and a cost log, with the account and the person hashed.
 *
 * Kept free of Deno APIs so it runs under Node tests; main.ts binds it to the real secrets and stores.
 */
import Anthropic from '@anthropic-ai/sdk';
import { makeClaude } from '../_shared/claude.ts';
import { clientIp, defaultOrigins } from '../_shared/origins.ts';
import type { Exa } from '../_shared/providers/exa';
import {
  BOTH_CAP_USD,
  type BriefOutcome,
  type BriefRequest,
  DEEPER_DEADLINE_MS,
  QUICK_CAP_USD,
  QUICK_DEADLINE_MS,
  runBrief,
} from '../_shared/research/brief';
import type { ClaudeDep } from '../_shared/research/deps';
import { norm, normOrg } from '../_shared/research/guards';
import { identityCard, slugOf } from '../_shared/research/identity';
import { claudeWeb, exaWeb, GATHER_MODEL, type SharedCache, type WebSource } from '../_shared/research/web';

export { clientIp, defaultOrigins };

export interface Bucket {
  key: string;
  limit: number;
  expires: string;
}
export type Take = (buckets: Bucket[]) => Promise<{ allowed: boolean; over?: string }>;

/** The four research tables (supabase/migrations/20261023_orbit_research.sql). */
export interface ResearchStore {
  use(
    account: string,
    month: string,
    person: string,
    limit: number,
  ): Promise<{ allowed: boolean; used: number; counted: boolean }>;
  refund(account: string, month: string, person: string): Promise<number>;
  status(account: string, month: string): Promise<{ used: number; spentToday: number }>;
  lastQuick(account: string, person: string): Promise<number | null>;
  logRun(row: RunRow): Promise<void>;
  suppressed(keys: string[]): Promise<boolean>;
  suppress(keys: string[], source: string): Promise<void>;
  /** old rows go: the expired cache, last-but-one month's allowance, cost-log rows older than 90 days */
  cleanup?(): Promise<void>;
}

export interface RunRow {
  account: string;
  person_key: string;
  kind: 'quick' | 'deeper';
  status: string;
  cost_usd: number;
  steps: unknown[];
  notes: string[];
  error?: string | null;
  ms: number;
}

export interface ResearchDeps {
  origins: (origin: string) => boolean;
  /** verifies account tokens (the service role key in production); without it every research call is refused */
  signingKey?: string;
  /** salt for the hashed account, person and visitor */
  salt?: string;
  take: Take;
  store: ResearchStore;
  cache: SharedCache;
  /** ORBIT_ANTHROPIC_API_KEY: the writer, the support check and (without Exa) the web search */
  anthropicKey?: string | (() => Promise<string | undefined>);
  /** Exa, preferred for search when EXA_API_KEY is set */
  exa?: Exa;
  /** the model that runs Claude's web search and fetch */
  gatherModel?: string;
  /** different people one LinkedIn account may research a month */
  perMonth?: number;
  /** dollars all research may spend in a day, every student together */
  usdPerDay?: number;
  /** research calls one account may make a day, and per visitor (hashed IP) a minute and a day */
  accountPerDay?: number;
  visitorPerMinute?: number;
  visitorPerDay?: number;
  /** removal requests one visitor may send a day */
  removePerDay?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  /** tests pin the deadline */
  deadlines?: { quick: number; deeper: number };
}

export const DEFAULT_PER_MONTH = 15;
export const DEFAULT_USD_PER_DAY = 40;

const ROUTES = new Set(['/quick', '/deeper', '/status', '/remove']);

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'x-orbit-connector, x-orbit-limit, retry-after',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The same token orbit-connectors hands out: base64url HMAC-SHA256 of `unipile-account:<id>`. */
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

async function tokenValid(
  accountId: string,
  token: unknown,
  signingKey: string | undefined,
): Promise<boolean> {
  if (!signingKey || !accountId || typeof token !== 'string' || !token) return false;
  const want = await accountToken(accountId, signingKey);
  if (want.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function dayBucket(prefix: string, who: string, now: Date, limit: number): Bucket {
  const day = now.toISOString().slice(0, 10);
  const end = new Date(`${day}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { key: `research:${prefix}:${day}:${who}`, limit, expires: end.toISOString() };
}

function minuteBucket(who: string, now: Date, limit: number): Bucket {
  const minute = now.toISOString().slice(0, 16);
  const end = new Date(`${minute}:00Z`);
  end.setUTCMinutes(end.getUTCMinutes() + 1);
  return { key: `research:min:${minute}:${who}`, limit, expires: end.toISOString() };
}

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

const str = (v: unknown, max = 300) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const strs = (v: unknown, n: number, max = 300) =>
  (Array.isArray(v) ? v : [])
    .map((x) => str(x, max))
    .filter((x): x is string => !!x)
    .slice(0, n);
const obj = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The request body as the pipeline takes it: every field trimmed and bounded, nothing else passed through. */
export function readBriefRequest(
  kind: 'quick' | 'deeper',
  body: Record<string, unknown>,
): BriefRequest | undefined {
  const p = obj(body.person);
  const name = str(p?.name, 120);
  if (!p || !name) return undefined;
  const prof = obj(body.profile);
  const student = obj(body.student) ?? {};
  const goalKinds = [
    'recruiting',
    'fundraising',
    'sales',
    'hiring',
    'advice',
    'cofounder',
    'collaboration',
    'community',
  ];
  const goalKind = str(student.goalKind, 20);
  return {
    kind,
    person: {
      name,
      firstName: str(p.firstName, 60),
      lastName: str(p.lastName, 60),
      title: str(p.title, 160),
      org: str(p.org, 160),
      location: str(p.location, 120),
      school: str(p.school, 160),
      linkedinUrl: str(p.linkedinUrl, 300)?.match(/^https:\/\/([\w-]+\.)?linkedin\.com\//i)
        ? str(p.linkedinUrl, 300)
        : undefined,
      emails: strs(p.emails, 5, 200).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    },
    profile: prof
      ? {
          headline: str(prof.headline, 220),
          location: str(prof.location, 120),
          about: str(prof.about, 1500),
          publicIdentifier: str(prof.publicIdentifier, 120),
          experience: (Array.isArray(prof.experience) ? prof.experience : [])
            .slice(0, 15)
            .map((x) => obj(x) ?? {})
            .map((x) => ({
              title: str(x.title, 160),
              company: str(x.company, 160),
              current: x.current === true,
              start: str(x.start, 40),
              end: str(x.end, 40),
            }))
            .filter((x) => x.company || x.title),
          education: (Array.isArray(prof.education) ? prof.education : [])
            .slice(0, 8)
            .map((x) => obj(x) ?? {})
            .map((x) => ({
              school: str(x.school, 160),
              degree: str(x.degree, 120),
              field: str(x.field, 120),
              start: str(x.start, 40),
              end: str(x.end, 40),
            }))
            .filter((x) => x.school),
        }
      : null,
    posts: (Array.isArray(body.posts) ? body.posts : [])
      .slice(0, 10)
      .map((x) => obj(x) ?? {})
      .map((x) => ({
        text: str(x.text, 1500) ?? '',
        date: str(x.date, 40),
        url: str(x.url, 300)?.match(/^https:\/\//) ? str(x.url, 300) : undefined,
      }))
      .filter((x) => x.text),
    history: str(body.history, 4000),
    student: {
      firstName: str(student.firstName, 60) ?? 'the student',
      context: str(student.context, 1200) ?? '',
      goalSentence:
        str(student.goalSentence, 300) ?? 'build relationships with people who matter to their work',
      goalKind:
        goalKind && goalKinds.includes(goalKind)
          ? (goalKind as BriefRequest['student']['goalKind'])
          : undefined,
    },
    chosen: obj(body.chosen)
      ? { org: str(obj(body.chosen)!.org, 160), url: str(obj(body.chosen)!.url, 300) }
      : undefined,
  };
}

/** The removal-list keys one person matches: their LinkedIn name, an email, or name with a company. */
export async function suppressionKeys(p: {
  name?: string;
  linkedinUrl?: string;
  slug?: string;
  emails?: string[];
  orgs?: string[];
}): Promise<string[]> {
  const raw: string[] = [];
  const slug = p.slug ?? slugOf(p.linkedinUrl);
  if (slug) raw.push(`slug:${slug.toLowerCase()}`);
  for (const e of p.emails ?? []) raw.push(`email:${e.trim().toLowerCase()}`);
  const name = norm(p.name);
  if (name) for (const o of p.orgs ?? []) if (normOrg(o)) raw.push(`name_org:${name}|${normOrg(o)}`);
  return Promise.all([...new Set(raw)].map((k) => sha256(`orbit-research-suppression:${k}`)));
}

/** The person as the allowance and the cost log know them: their LinkedIn name, else name and company, hashed. */
async function personKey(salt: string, req: BriefRequest): Promise<string> {
  const slug = slugOf(req.person.linkedinUrl) ?? req.profile?.publicIdentifier?.toLowerCase();
  const id = slug ? `slug:${slug}` : `name:${norm(req.person.name)}|${normOrg(req.person.org)}`;
  return (await sha256(`${salt}:person:${id}`)).slice(0, 40);
}

function claudeDepOf(claude: ReturnType<typeof makeClaude>): ClaudeDep {
  return {
    async parse(task, schema, prompt) {
      const r = await claude.structured({
        task: task === 'support' ? 'support' : task === 'dossier' ? 'dossier' : 'fit',
        system: prompt.system,
        user: prompt.user,
        schema,
        userId: null,
        timeoutMs: prompt.timeoutMs,
      });
      if (r.ok) return { ok: true, value: r.data, costUsd: r.costUsd, model: r.model };
      if ('unconfigured' in r) return { ok: false, reason: 'error', message: 'unconfigured' };
      if ('budgetExceeded' in r) return { ok: false, reason: 'budget_exceeded', message: r.cap };
      if ('refused' in r) return { ok: false, reason: 'refusal' };
      return { ok: false, reason: r.error === 'max_tokens' ? 'max_tokens' : 'error', message: r.error };
    },
  };
}

async function resolveKey(k: ResearchDeps['anthropicKey']): Promise<string | undefined> {
  if (!k) return undefined;
  if (typeof k === 'string') return k;
  try {
    return await k();
  } catch {
    return undefined;
  }
}

export function makeHandler(deps: ResearchDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const salt = deps.salt ?? 'orbit';
  const perMonth = deps.perMonth ?? DEFAULT_PER_MONTH;
  return async (req) => {
    const origin = req.headers.get('origin');
    const allowed = !!origin && deps.origins(origin);
    const h = cors(origin, allowed);
    if (req.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403, headers: h });
      return new Response(null, {
        status: 204,
        headers: {
          ...h,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') ?? '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (!allowed) return json(403, { error: 'origin not allowed' }, h);
    if (req.method !== 'POST') return json(405, { error: 'POST only' }, h);
    const path = new URL(req.url).pathname.replace(/.*\/orbit-research/, '') || '/';
    if (!ROUTES.has(path)) return json(404, { error: 'no such route' }, h);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    // without the service key (which signs LinkedIn account tokens) nothing here can run
    if (!deps.signingKey)
      return json(
        503,
        { ok: false, reason: 'unconfigured', message: 'Research is not set up yet.' },
        { ...h, 'x-orbit-connector': 'unconfigured' },
      );
    const t = now();
    const visitor = (await sha256(`${salt}:${clientIp(req)}`)).slice(0, 32);

    // a visitor's own counters first, so nobody can hammer the routes
    try {
      const v = await deps.take([
        minuteBucket(`ip:${visitor}`, t, deps.visitorPerMinute ?? 20),
        dayBucket(
          'ip',
          visitor,
          t,
          path === '/remove' ? (deps.removePerDay ?? 10) : (deps.visitorPerDay ?? 200),
        ),
      ]);
      if (!v.allowed) {
        const minute = v.over?.includes(':min:') ?? false;
        return json(
          429,
          {
            ok: false,
            reason: 'busy',
            message: minute ? 'Too many requests. Try again in a moment.' : "Today's limit is reached.",
          },
          { ...h, 'x-orbit-limit': minute ? 'minute' : 'day', ...(minute ? { 'retry-after': '30' } : {}) },
        );
      }
    } catch {
      return json(
        503,
        { ok: false, reason: 'unavailable', message: 'Research is unavailable right now.' },
        h,
      );
    }

    if (path === '/remove') return removeRoute(deps, body, h);

    const accountId = str(body.accountId, 200) ?? '';
    if (!(await tokenValid(accountId, body.token, deps.signingKey)))
      return json(
        403,
        { ok: false, reason: 'not_linked', message: 'Connect your LinkedIn to Orbit to research people.' },
        h,
      );
    const account = (await sha256(`${salt}:acct:${accountId}`)).slice(0, 40);
    const month = monthOf(t);
    const key = await resolveKey(deps.anthropicKey);
    const providers = { exa: !!deps.exa?.configured, claude: !!key };

    if (path === '/status') {
      try {
        const st = await deps.store.status(account, month);
        return json(200, { ok: true, allowance: allowance(st.used, perMonth, month), providers }, h);
      } catch {
        return json(
          503,
          { ok: false, reason: 'unavailable', message: 'Research is unavailable right now.' },
          h,
        );
      }
    }

    const kind = path === '/deeper' ? 'deeper' : 'quick';
    const brief = readBriefRequest(kind, body);
    if (!brief) return json(400, { ok: false, reason: 'bad_request', message: 'Say who to research.' }, h);
    if (!key)
      return json(
        503,
        { ok: false, reason: 'unconfigured', message: 'Research is not set up yet.' },
        { ...h, 'x-orbit-connector': 'unconfigured' },
      );
    // never research someone the student marked do-not-contact
    if (body.doNotContact === true)
      return json(
        200,
        {
          ok: false,
          reason: 'do_not_contact',
          message: 'You marked this person do-not-contact, so Orbit does not research them.',
        },
        h,
      );
    const card = identityCard({ ...brief.person, profile: brief.profile ?? null });
    const keys = await suppressionKeys({
      name: brief.person.name,
      linkedinUrl: brief.person.linkedinUrl,
      slug: brief.profile?.publicIdentifier,
      emails: brief.person.emails,
      orgs: card.employers.map((e) => e.name),
    });
    try {
      if (keys.length && (await deps.store.suppressed(keys)))
        return json(
          200,
          { ok: false, reason: 'suppressed', message: 'This person asked not to be researched by Orbit.' },
          h,
        );
    } catch {
      return json(
        503,
        { ok: false, reason: 'unavailable', message: 'Research is unavailable right now.' },
        h,
      );
    }
    // no LinkedIn and no company: nothing to tell namesakes apart, so nothing is spent or counted
    if (!card.anchored && card.domains.length === 0 && !brief.chosen?.org)
      return json(
        200,
        {
          ok: true,
          status: 'needs_anchor',
          message: 'Add their LinkedIn or their company, so Orbit researches the right person.',
        },
        h,
      );
    const person = await personKey(salt, brief);

    // counters per account (calls a day) and the global dollar cap
    try {
      const v = await deps.take([dayBucket('acct', account, t, deps.accountPerDay ?? 40)]);
      if (!v.allowed)
        return json(
          200,
          { ok: false, reason: 'limit', message: 'You have researched as much as Orbit allows today.' },
          h,
        );
      const st = await deps.store.status(account, month);
      if (st.spentToday >= (deps.usdPerDay ?? DEFAULT_USD_PER_DAY))
        return json(
          200,
          { ok: false, reason: 'busy', message: 'Research is busy today. Try again tomorrow.' },
          h,
        );
    } catch {
      return json(
        503,
        { ok: false, reason: 'unavailable', message: 'Research is unavailable right now.' },
        h,
      );
    }

    let cap = QUICK_CAP_USD;
    if (kind === 'deeper') {
      const quickCost = await deps.store.lastQuick(account, person).catch(() => null);
      if (quickCost === null)
        return json(
          200,
          { ok: false, reason: 'needs_quick', message: 'Run the quick brief first, then Go deeper.' },
          h,
        );
      cap = Math.max(0.1, BOTH_CAP_USD - quickCost);
    }
    let use: { allowed: boolean; used: number; counted: boolean };
    try {
      use = await deps.store.use(account, month, person, perMonth);
    } catch {
      return json(
        503,
        { ok: false, reason: 'unavailable', message: 'Research is unavailable right now.' },
        h,
      );
    }
    if (!use.allowed)
      return json(
        200,
        {
          ok: false,
          reason: 'limit',
          message: `You have used this month's ${perMonth} research briefs. They come back on the 1st.`,
          allowance: allowance(use.used, perMonth, month),
        },
        h,
      );

    // now and then, the expired cache and old rows go (as orbit_proxy_take clears its own counters)
    if (Math.random() < 0.02) void deps.store.cleanup?.().catch(() => undefined);
    const doFetch = deps.fetch ?? fetch;
    const client = new Anthropic({ apiKey: key, fetch: doFetch, maxRetries: 1 });
    const web: WebSource[] = [];
    if (deps.exa?.configured) web.push(exaWeb(deps.exa, deps.cache));
    web.push(claudeWeb(client, deps.cache, { model: deps.gatherModel ?? GATHER_MODEL }));
    const claude = claudeDepOf(makeClaude({ apiKey: key, fetch: doFetch, client }));
    const started = Date.now();
    const deadlineMs =
      kind === 'quick'
        ? (deps.deadlines?.quick ?? QUICK_DEADLINE_MS)
        : (deps.deadlines?.deeper ?? DEEPER_DEADLINE_MS);
    let out: BriefOutcome;
    try {
      out = await runBrief({ web, claude, clock: () => now().getTime() }, brief, {
        capUsd: cap,
        deadline: now().getTime() + deadlineMs,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : 'error';
      if (use.counted) await deps.store.refund(account, month, person).catch(() => undefined);
      await deps.store
        .logRun({
          account,
          person_key: person,
          kind,
          status: 'error',
          cost_usd: 0,
          steps: [],
          notes: [],
          error: message,
          ms: Date.now() - started,
        })
        .catch(() => undefined);
      return json(
        502,
        { ok: false, reason: 'error', message: "Research didn't work this time. Try again." },
        h,
      );
    }
    const ready = out.status === 'ready' || out.status === 'partial';
    let used = use.used;
    // only a brief counts against the month: "which one?" and the like give the person back
    if (!ready && use.counted) used = await deps.store.refund(account, month, person).catch(() => use.used);
    await deps.store
      .logRun({
        account,
        person_key: person,
        kind,
        status: out.status,
        cost_usd: out.costUsd,
        steps: out.steps,
        notes: out.notes,
        error: out.status === 'failed' ? out.error : null,
        ms: Date.now() - started,
      })
      .catch(() => undefined);
    const base = {
      ok: true,
      status: out.status,
      costUsd: out.costUsd,
      allowance: allowance(used, perMonth, month),
    };
    if (out.status === 'needs_disambiguation') return json(200, { ...base, candidates: out.candidates }, h);
    if (out.status === 'failed')
      return json(
        200,
        { ...base, message: 'This person appears to be in high school, so Orbit does not research them.' },
        h,
      );
    if (out.status === 'needs_anchor')
      return json(
        200,
        { ...base, message: 'Add their LinkedIn or their company, so Orbit researches the right person.' },
        h,
      );
    return json(
      200,
      {
        ...base,
        brief: {
          kind,
          content: out.content,
          sources: out.sources,
          model: out.model,
          promptVersion: out.promptVersion,
          notes: out.notes,
          checked: out.checked,
          strongPages: out.strongPages,
          provider: out.provider,
          costUsd: out.costUsd,
        },
      },
      h,
    );
  };
}

function allowance(used: number, limit: number, month: string) {
  return { used, limit, left: Math.max(0, limit - used), month };
}

/** The public "remove me" page: name plus a LinkedIn address, an email or a company, so namesakes stay unaffected. */
async function removeRoute(deps: ResearchDeps, body: Record<string, unknown>, h: Record<string, string>) {
  const name = str(body.name, 120);
  const linkedinUrl = str(body.linkedinUrl, 300);
  const email = str(body.email, 200);
  const company = str(body.company, 160);
  if (!name || (!slugOf(linkedinUrl) && !email && !company))
    return json(
      400,
      {
        ok: false,
        reason: 'bad_request',
        message:
          'Give your name and your LinkedIn address, your email, or your company, so Orbit removes the right person.',
      },
      h,
    );
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json(
      400,
      { ok: false, reason: 'bad_request', message: 'That email address does not look right.' },
      h,
    );
  const keys = await suppressionKeys({
    name,
    linkedinUrl,
    emails: email ? [email] : [],
    orgs: company ? [company] : [],
  });
  try {
    await deps.store.suppress(keys, 'remove_page');
  } catch {
    return json(
      503,
      { ok: false, reason: 'unavailable', message: 'Could not save that right now. Try again.' },
      h,
    );
  }
  return json(200, { ok: true, message: 'Done. Orbit will not research you from now on.' }, h);
}

// ---- stores ------------------------------------------------------------------------------------------------------

export function memoryStore(clock: () => number = Date.now): ResearchStore & {
  uses: Set<string>;
  runs: (RunRow & { at: number })[];
  suppressions: Set<string>;
} {
  const uses = new Set<string>();
  const runs: (RunRow & { at: number })[] = [];
  const suppressions = new Set<string>();
  const usedIn = (account: string, month: string) =>
    [...uses].filter((k) => k.startsWith(`${account}|${month}|`)).length;
  return {
    uses,
    runs,
    suppressions,
    async use(account, month, person, limit) {
      const k = `${account}|${month}|${person}`;
      if (uses.has(k)) return { allowed: true, used: usedIn(account, month), counted: false };
      const n = usedIn(account, month);
      if (n >= limit) return { allowed: false, used: n, counted: false };
      uses.add(k);
      return { allowed: true, used: n + 1, counted: true };
    },
    async refund(account, month, person) {
      uses.delete(`${account}|${month}|${person}`);
      return usedIn(account, month);
    },
    async status(account, month) {
      const day = new Date(clock()).toISOString().slice(0, 10);
      const spentToday = runs
        .filter((r) => new Date(r.at).toISOString().slice(0, 10) === day)
        .reduce((s, r) => s + r.cost_usd, 0);
      return { used: usedIn(account, month), spentToday };
    },
    async lastQuick(account, person) {
      const r = [...runs]
        .reverse()
        .find(
          (x) =>
            x.account === account &&
            x.person_key === person &&
            x.kind === 'quick' &&
            (x.status === 'ready' || x.status === 'partial') &&
            clock() - x.at < 30 * 86_400_000,
        );
      return r ? r.cost_usd : null;
    },
    async logRun(row) {
      runs.push({ ...row, at: clock() });
    },
    async suppressed(keys) {
      return keys.some((k) => suppressions.has(k));
    },
    async suppress(keys) {
      for (const k of keys) suppressions.add(k);
    },
  };
}

/** The research tables over PostgREST with the service role key. */
export function postgrestStore(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): ResearchStore {
  const headers = {
    'content-type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const r = await doFetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`research store ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    async use(account, month, person, limit) {
      const rows = await rpc<{ allowed: boolean; used: number; counted: boolean }[]>('orbit_research_use', {
        p_account: account,
        p_month: month,
        p_person: person,
        p_limit: limit,
      });
      const row = rows[0];
      if (!row) throw new Error('research store returned nothing');
      return row;
    },
    refund: (account, month, person) =>
      rpc<number>('orbit_research_refund', { p_account: account, p_month: month, p_person: person }),
    async status(account, month) {
      const rows = await rpc<{ used: number; spent_today: number | string }[]>('orbit_research_status', {
        p_account: account,
        p_month: month,
      });
      return { used: rows[0]?.used ?? 0, spentToday: Number(rows[0]?.spent_today ?? 0) };
    },
    async lastQuick(account, person) {
      const v = await rpc<number | string | null>('orbit_research_last_quick', {
        p_account: account,
        p_person: person,
      });
      return v === null || v === undefined ? null : Number(v);
    },
    async logRun(row) {
      const r = await doFetch(`${url}/rest/v1/orbit_research_runs`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`research store ${r.status}`);
    },
    async suppressed(keys) {
      const list = keys.map((k) => `"${k}"`).join(',');
      const r = await doFetch(
        `${url}/rest/v1/orbit_research_suppressions?key=in.(${encodeURIComponent(list)})&select=key&limit=1`,
        {
          headers,
        },
      );
      if (!r.ok) throw new Error(`research store ${r.status}`);
      return ((await r.json()) as unknown[]).length > 0;
    },
    async cleanup() {
      await rpc<unknown>('orbit_research_cleanup', {});
    },
    async suppress(keys, source) {
      const r = await doFetch(`${url}/rest/v1/orbit_research_suppressions?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(keys.map((key) => ({ key, source }))),
      });
      if (!r.ok) throw new Error(`research store ${r.status}`);
    },
  };
}

/** The request counters over PostgREST: the same orbit_proxy_take every Orbit function uses, keys prefixed research:. */
export function postgrestTake(url: string, serviceKey: string, doFetch: typeof fetch = fetch): Take {
  return async (bs) => {
    const r = await doFetch(`${url}/rest/v1/rpc/orbit_proxy_take`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_buckets: bs.map((b) => b.key),
        p_limits: bs.map((b) => b.limit),
        p_expires: bs.map((b) => b.expires),
      }),
    });
    if (!r.ok) throw new Error(`counter store ${r.status}`);
    const rows = (await r.json()) as { allowed: boolean; over_bucket: string | null }[];
    const row = rows[0];
    if (!row) throw new Error('counter store returned nothing');
    return { allowed: row.allowed, over: row.over_bucket ?? undefined };
  };
}

export function memoryTake(clock: () => number = Date.now): Take {
  const counts = new Map<string, { n: number; expires: number }>();
  return async (bs) => {
    const t = clock();
    for (const [k, v] of counts) if (v.expires < t) counts.delete(k);
    for (const b of bs) {
      const c = counts.get(b.key) ?? { n: 0, expires: Date.parse(b.expires) };
      c.n++;
      counts.set(b.key, c);
      if (c.n > b.limit) return { allowed: false, over: b.key };
    }
    return { allowed: true };
  };
}
