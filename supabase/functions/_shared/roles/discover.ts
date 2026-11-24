/**
 * Plan 44 §4.3: which company's board is which, found so it can be trusted.
 *
 * 1. From the company's own careers page. Orbit fetches /careers, /jobs, careers.<domain>, and the page the home page
 *    links as Careers, and reads the board links on it (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable,
 *    Recruitee). A link on the company's own site, or a redirect from it, is the proof that the board is theirs. A
 *    few requests per company, never a dozen guesses.
 * 2. From the SimplifyJobs lists: each entry's link is the company's own posting, so it names the board (Workday
 *    sites included). This alone finds thousands.
 * 3. With no site to read: Greenhouse only, by name, and only when the name the board reports is the company's
 *    (normalizeCompany). Lever and Ashby report no name, so they are never guessed.
 *
 * Every answer, "none" included, is kept in job_board_lookups and not asked again for 30 days (3 days after a
 * failure). Requests carry Orbit's posting user agent; a site that refuses is left for days, not retried now.
 */
import { looksLikeSchool } from '@orbit/core/resume/schools';
import { normalizeCompany } from '@orbit/core/text/normalize';
import type { JobListing } from '../../../../packages/core/src/roles/types.ts';
import type { Db } from '../db.ts';
import { POSTING_USER_AGENT, postingUrlProblem } from '../postings.ts';
import { upsertBoard } from './boards.ts';
import { companyKey } from './intake.ts';
import { type BoardLink, boardLinksIn, boardOfUrl } from './readers/boardUrls.ts';
import { greenhouseBoardName } from './readers/greenhouse.ts';
import { DEFAULT_TIMEOUT_MS, type ReaderNet, sleepFor } from './readers/http.ts';
import { count, take } from './usage.ts';

const DAY = 86_400_000;
/** An answer is asked again after this long. */
export const LOOKUP_RECHECK_MS = 30 * DAY;
export const LOOKUP_FAILED_RECHECK_MS = 3 * DAY;
/** Companies a day, across all ticks (plan 44 §11). */
export const DISCOVERY_PER_DAY = 500;
/** Pages fetched for one company at most. */
export const PAGES_PER_COMPANY = 4;
const PAGE_MAX_BYTES = 1_500_000;

export interface CompanyToFind {
  key: string;
  name: string;
  domain?: string;
}

export interface Discovery {
  outcome: 'found' | 'none' | 'failed';
  board?: BoardLink & { id: string; via: 'careers_page' | 'name'; url?: string };
  requests: number;
  refused: number;
}

/** "https://www.acme.com/about" → "acme.com"; mail and school hosts are no company's site. */
export function siteOf(raw: string | undefined | null): string | undefined {
  if (!raw?.trim()) return undefined;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./, '');
  if (!host.includes('.') || postingUrlProblem(`https://${host}/`)) return undefined;
  if (
    /(^|\.)(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton|protonmail|msn|qq|163|gmx|mail|yandex|linkedin|github|medium|substack|notion|wixsite|squarespace)\.[a-z.]+$/.test(
      host,
    ) ||
    /\.edu$|\.ac\.[a-z]+$/.test(host)
  )
    return undefined;
  return host;
}

const onSite = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

interface Page {
  status: number;
  html?: string;
  /** a board the page redirected to */
  board?: BoardLink;
  url: string;
}

/** Fetch one page, following redirects by hand: on the company's site, or onto a board (the proof itself). */
async function getPage(net: ReaderNet, url: string, domain: string): Promise<Page> {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await net.fetch(at, {
        headers: { 'user-agent': POSTING_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: AbortSignal.timeout(net.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      return { status: 0, url: at };
    }
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (next) {
      await res.body?.cancel().catch(() => undefined);
      const to = new URL(next, at).toString();
      const board = boardOfUrl(to);
      if (board?.token) return { status: res.status, board, url: to };
      if (postingUrlProblem(to) || !onSite(new URL(to).hostname.toLowerCase().replace(/^www\./, ''), domain))
        return { status: res.status, url: to };
      at = to;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, url: at };
    }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|text/i.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, url: at };
    }
    const text = await res.text().catch(() => '');
    return { status: res.status, html: text.slice(0, PAGE_MAX_BYTES), url: at };
  }
  return { status: 0, url: at };
}

/** The page the home page links as its careers page, when it does. */
export function careersLinkIn(html: string, base: string): string | undefined {
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = m[2]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      !/^(careers?|jobs|join us|join the team|open (roles|positions)|we('|’)re hiring|work with us|work at .{1,30})$/i.test(
        label,
      )
    )
      continue;
    try {
      return new URL(m[1]!, base).toString();
    } catch {
      // the next link
    }
  }
  return undefined;
}

/** The board a page names, when it names one plainly (the one it names most). */
function boardOnPage(html: string): BoardLink | undefined {
  const links = boardLinksIn(html);
  return links[0]?.link;
}

/** Look for one company's board. Records the answer in job_board_lookups. */
export async function discoverCompany(
  db: Db,
  net: ReaderNet,
  c: CompanyToFind,
  now: Date,
): Promise<Discovery> {
  const out: Discovery = { outcome: 'none', requests: 0, refused: 0 };
  const sleep = sleepFor(net);
  const domain = siteOf(c.domain);
  let found: (BoardLink & { url?: string }) | undefined;
  let failed = false;
  if (domain) {
    const tried = new Set<string>();
    const queue = [
      `https://${domain}/careers`,
      `https://${domain}/jobs`,
      `https://careers.${domain}/`,
      `https://${domain}/`,
    ];
    while (queue.length && out.requests < PAGES_PER_COMPANY && !found) {
      const url = queue.shift()!;
      if (tried.has(url)) continue;
      tried.add(url);
      if (out.requests) await sleep(400);
      const page = await getPage(net, url, domain);
      out.requests++;
      if (page.board) {
        found = { ...page.board, url };
        break;
      }
      if (page.status === 403 || page.status === 429) {
        out.refused++;
        // a site that refuses is asked no more today
        if (page.status === 429) break;
        continue;
      }
      if (!page.html) continue;
      const board = boardOnPage(page.html);
      if (board) {
        found = { ...board, url: page.url };
        break;
      }
      // the home page's own link to its careers page, read next
      if (url === `https://${domain}/`) {
        const link = careersLinkIn(page.html, page.url);
        const linked = link ? boardOfUrl(link) : undefined;
        if (linked?.token) {
          found = { ...linked, url: page.url };
          break;
        }
        if (
          link &&
          !tried.has(link) &&
          !postingUrlProblem(link) &&
          onSite(new URL(link).hostname.replace(/^www\./, ''), domain)
        )
          queue.push(link);
      }
    }
    if (!found && out.refused && out.refused >= out.requests) failed = true;
  }
  let via: 'careers_page' | 'name' = 'careers_page';
  if (!found && !failed) {
    // Greenhouse by name: only when the board says it is this company
    const tokens = [...new Set([c.key.replace(/[^a-z0-9]/g, ''), c.key.replace(/[^a-z0-9]+/g, '-')])].filter(
      (t) => t.length >= 3,
    );
    for (const t of tokens.slice(0, 2)) {
      if (out.requests) await sleep(300);
      const got = await greenhouseBoardName(net, t);
      out.requests++;
      if (got.ok && got.value && normalizeCompany(got.value) === c.key) {
        found = { service: 'greenhouse', token: t };
        via = 'name';
        break;
      }
      if (!got.ok && (got.reason === 'refused' || got.reason === 'rate_limited')) out.refused++;
    }
  }
  if (found) {
    const board = await upsertBoard(db, {
      service: found.service,
      token: found.token,
      companyKey: c.key,
      companyName: c.name,
      companyDomain: domain,
      foundVia: via,
      foundUrl: found.url,
    });
    out.outcome = 'found';
    out.board = { service: found.service, token: found.token, id: board.id, via, url: found.url };
  } else if (failed) out.outcome = 'failed';
  await db.sql`
    insert into orbit_private.job_board_lookups (company_key, company_name, domain, outcome, board_id, checked_at)
    values (${c.key}, ${c.name}, ${domain ?? null}, ${out.outcome}, ${out.board?.id ?? null}::uuid, ${now}::timestamptz)
    on conflict (company_key) do update set company_name = excluded.company_name, domain = excluded.domain,
      outcome = excluded.outcome, board_id = excluded.board_id, checked_at = excluded.checked_at`;
  await count(db, now, 'discovery_companies');
  await count(db, now, 'discovery_requests', out.requests);
  await count(db, now, 'discovery_refused', out.refused);
  if (found) await count(db, now, 'discovery_found');
  return out;
}

/**
 * Companies to look for, most wanted first: every student's target companies, the companies their people work at
 * (most people first), then YC companies with a site. Left out: schools, companies that already have a board, and
 * companies asked about lately.
 */
export async function companiesToFind(db: Db, now: Date, limit: number): Promise<CompanyToFind[]> {
  const rows = await db.sql<{ name: string; domain: string | null; pri: number; n: number }>`
    select trim(t.name) as name, null::text as domain, 3 as pri, count(*)::int as n
      from orbit.goals g
      join orbit.users u on u.id = g.user_id and u.deleted_at is null,
           jsonb_array_elements_text(coalesce(g.targets->'organizations', '[]'::jsonb)) t(name)
     where g.deleted_at is null and trim(t.name) <> ''
     group by 1
    union all
    select * from (
      select coalesce(o.name, p.org_raw) as name, max(o.domains[1]) as domain, 2 as pri, count(*)::int as n
        from orbit.people p
        join orbit.users u on u.id = p.user_id and u.deleted_at is null
        left join orbit.organizations o on o.id = p.org_id
       where p.deleted_at is null and p.merged_into is null and not p.is_self and coalesce(o.name, p.org_raw) is not null
       group by 1
       order by count(*) desc
       limit 4000) people
    union all
    select * from (
      select name, website as domain, 1 as pri, coalesce(team_size, 0) as n
        from orbit_private.company_facts
       where website is not null and coalesce(yc_status, 'Active') <> 'Inactive'
       order by coalesce(team_size, 0) desc
       limit 6000) facts`;
  const known = new Set(
    (
      await db.sql<{ key: string }>`
        select company_key as key from orbit_private.job_board_lookups
         where (outcome <> 'failed' and checked_at > ${new Date(now.getTime() - LOOKUP_RECHECK_MS)}::timestamptz)
            or (outcome = 'failed' and checked_at > ${new Date(now.getTime() - LOOKUP_FAILED_RECHECK_MS)}::timestamptz)
        union
        select company_key from orbit_private.job_boards where company_key is not null`
    ).map((r) => r.key),
  );
  const byKey = new Map<string, CompanyToFind & { pri: number; n: number }>();
  for (const r of rows) {
    const name = r.name?.trim();
    if (!name || looksLikeSchool(name)) continue;
    const key = companyKey(name);
    if (!key || known.has(key)) continue;
    const had = byKey.get(key);
    const domain = siteOf(r.domain) ?? had?.domain;
    if (had) {
      had.pri = Math.max(had.pri, Number(r.pri));
      had.n += Number(r.n);
      had.domain = domain;
    } else byKey.set(key, { key, name, domain, pri: Number(r.pri), n: Number(r.n) });
  }
  return [...byKey.values()]
    .sort((a, b) => b.pri - a.pri || b.n - a.n)
    .slice(0, limit)
    .map(({ key, name, domain }) => ({ key, name, domain }));
}

export interface DiscoveryRun {
  clock: () => number;
  deadline: number;
  maxCompanies: number;
}

/** Look for up to `maxCompanies` boards, inside this share of the tick and the day's cap. */
export async function discoverSome(
  db: Db,
  net: ReaderNet,
  now: Date,
  run: DiscoveryRun,
): Promise<{ looked: number; found: number; refused: number; requests: number; stoppedBy?: 'time' | 'cap' }> {
  const s = {
    looked: 0,
    found: 0,
    refused: 0,
    requests: 0,
    stoppedBy: undefined as 'time' | 'cap' | undefined,
  };
  if (run.deadline - run.clock() < 5_000) return { ...s, stoppedBy: 'time' };
  const todo = await companiesToFind(db, now, run.maxCompanies);
  for (const c of todo) {
    if (run.deadline - run.clock() < 5_000) {
      s.stoppedBy = 'time';
      break;
    }
    if (!(await take(db, now, 'discovery_cap', DISCOVERY_PER_DAY))) {
      s.stoppedBy = 'cap';
      break;
    }
    const d = await discoverCompany(db, net, c, now);
    s.looked++;
    s.requests += d.requests;
    s.refused += d.refused;
    if (d.outcome === 'found') s.found++;
  }
  return s;
}

/**
 * Boards named by listings' links (the SimplifyJobs lists): each Greenhouse, Lever, Ashby, Workday, SmartRecruiters,
 * Workable or Recruitee link is that company's board. Returns how many boards were new.
 */
export async function harvestBoards(db: Db, listings: JobListing[], now: Date): Promise<number> {
  const seen = new Map<string, { link: BoardLink; name: string; url: string }>();
  for (const l of listings) {
    const link = boardOfUrl(l.url);
    if (!link?.token) continue;
    const k = `${link.service}:${link.token.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, { link, name: l.companyName, url: l.url });
  }
  if (!seen.size) return 0;
  const have = new Set(
    (
      await db.sql<{ k: string }>`
        select service || ':' || lower(token) as k from orbit_private.job_boards
         where service || ':' || lower(token) = any(${[...seen.keys()]}::text[])`
    ).map((r) => r.k),
  );
  let added = 0;
  for (const [k, v] of seen) {
    if (have.has(k)) continue;
    const r = await upsertBoard(db, {
      service: v.link.service,
      token: v.link.token,
      companyKey: companyKey(v.name),
      companyName: v.name,
      foundVia: 'simplify',
      foundUrl: v.url,
    });
    if (r.created) added++;
  }
  await count(db, now, 'boards_harvested', added);
  return added;
}
