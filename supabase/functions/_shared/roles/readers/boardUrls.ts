/**
 * Plan 44 §4.3: which board a link is on. A job link or a careers link on Greenhouse, Lever, Ashby, Workday,
 * SmartRecruiters, Workable or Recruitee names the service and the board's token, and a job link also names the role
 * as that service's reader keys it (`externalId`), so a SimplifyJobs entry or a pasted link can be matched to the role
 * a board read stored.
 *
 * Tokens: Greenhouse and Lever boards on their EU hosts are `eu:<token>`; a Workday site is `<host>/<tenant>/<site>`.
 */
import type { BoardService } from '../../../../../packages/core/src/roles/types.ts';
import { boardJobOf, decodeEntities } from '../../postings.ts';

export interface BoardLink {
  service: BoardService;
  token: string;
  /** the role, keyed as the service's reader keys it */
  externalId?: string;
  /** Workday: the role's path after the site, which the detail call needs */
  path?: string;
}

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_TOKEN = /^(embed|jobs?|v\d|api|o|j|en-us|search|apply|careers|static|assets|images|favicon\.ico)$/i;
const token = (s: string | undefined) => (s && SLUG.test(s) && !NOT_TOKEN.test(s) ? s : undefined);

/** Workday's role key: the requisition id at the end of its path ("..._JR2029097"), or the whole path. */
export function workdayRoleKey(tenant: string, site: string, path: string): string {
  const req = /_([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(path.replace(/\/+$/, ''))?.[1];
  return `${tenant}/${site}/${req ?? path}`;
}

/** The board a link points at, and the role when it is a job's link. */
export function boardOfUrl(raw: string): BoardLink | undefined {
  let u: URL;
  try {
    u = new URL(decodeEntities(raw.trim()));
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  // Greenhouse: boards / job-boards (EU too), the embed, and the API
  let m = /^(?:boards|job-boards)(\.eu)?\.greenhouse\.io$/.exec(host);
  if (m) {
    const eu = !!m[1];
    const t = token(parts[0]) ?? token(u.searchParams.get('for') ?? undefined);
    const job = boardJobOf(u.toString());
    if (!t)
      return job?.board === 'greenhouse'
        ? { service: 'greenhouse', token: '', externalId: job.id }
        : undefined;
    return {
      service: 'greenhouse',
      token: eu ? `eu:${t.toLowerCase()}` : t.toLowerCase(),
      externalId: job?.id,
    };
  }
  m = /^boards-api(\.eu)?\.greenhouse\.io$/.exec(host);
  if (m && parts[0] === 'v1' && parts[1] === 'boards' && token(parts[2])) {
    const id = parts[3] === 'jobs' && /^\d+$/.test(parts[4] ?? '') ? parts[4] : undefined;
    return { service: 'greenhouse', token: `${m[1] ? 'eu:' : ''}${parts[2]!.toLowerCase()}`, externalId: id };
  }
  // a company site that frames a Greenhouse job (?gh_jid=): the role, with no board
  const gh = boardJobOf(u.toString());
  if (gh?.board === 'greenhouse' && !host.endsWith('greenhouse.io'))
    return { service: 'greenhouse', token: gh.token?.toLowerCase() ?? '', externalId: gh.id };
  // Lever
  m = /^jobs(\.eu)?\.lever\.co$/.exec(host);
  if (m && token(parts[0]))
    return {
      service: 'lever',
      token: `${m[1] ? 'eu:' : ''}${parts[0]!.toLowerCase()}`,
      externalId: UUID.test(parts[1] ?? '') ? parts[1]!.toLowerCase() : undefined,
    };
  m = /^api(\.eu)?\.lever\.co$/.exec(host);
  if (m && parts[0] === 'v0' && parts[1] === 'postings' && token(parts[2]))
    return {
      service: 'lever',
      token: `${m[1] ? 'eu:' : ''}${parts[2]!.toLowerCase()}`,
      externalId: UUID.test(parts[3] ?? '') ? parts[3]!.toLowerCase() : undefined,
    };
  // Ashby
  if (host === 'jobs.ashbyhq.com' && token(parts[0]))
    return {
      service: 'ashby',
      token: parts[0]!.toLowerCase(),
      externalId: UUID.test(parts[1] ?? '') ? parts[1]!.toLowerCase() : undefined,
    };
  if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board' && token(parts[2]))
    return { service: 'ashby', token: parts[2]!.toLowerCase() };
  // Workday: <tenant>.wd<N>.myworkdayjobs.com/[locale/]<site>[/job/...], wd<N>.myworkdaysite.com/[locale/]recruiting/<tenant>/<site>
  m = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (m) {
    const rest = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
    if (rest[0] === 'wday' && rest[1] === 'cxs' && rest[2] && rest[3]) {
      const path = rest[4] === 'job' ? `/${rest.slice(4).join('/')}` : undefined;
      return {
        service: 'workday',
        token: `${host}/${rest[2]}/${rest[3]}`,
        path,
        externalId: path ? workdayRoleKey(rest[2], rest[3], path) : undefined,
      };
    }
    const site = rest[0];
    if (!site || !SLUG.test(site) || /^(wday|login)$/i.test(site)) return undefined;
    const tenant = m[1]!;
    const path = rest[1] === 'job' && rest.length > 2 ? `/${rest.slice(1).join('/')}` : undefined;
    return {
      service: 'workday',
      token: `${host}/${tenant}/${site}`,
      path,
      externalId: path ? workdayRoleKey(tenant, site, path) : undefined,
    };
  }
  m = /^(wd\d+)\.myworkdaysite\.com$/.exec(host);
  if (m) {
    const rest = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? '') ? parts.slice(1) : parts;
    if (rest[0] !== 'recruiting' || !rest[1] || !rest[2]) return undefined;
    const path = rest[3] === 'job' ? `/${rest.slice(3).join('/')}` : undefined;
    return {
      service: 'workday',
      token: `${host}/${rest[1]}/${rest[2]}`,
      path,
      externalId: path ? workdayRoleKey(rest[1], rest[2], path) : undefined,
    };
  }
  // SmartRecruiters: jobs. / careers. smartrecruiters.com/<Company>[/<id>-slug]
  if (
    /^(jobs|careers)\.smartrecruiters\.com$/.test(host) &&
    token(parts[0]) &&
    !/^(oneclick-ui|external-referrals)$/i.test(parts[0]!)
  ) {
    const id = /^(\d{6,})/.exec(parts[1] ?? '')?.[1];
    return { service: 'smartrecruiters', token: parts[0]!, externalId: id ? `${parts[0]}/${id}` : undefined };
  }
  if (
    host === 'api.smartrecruiters.com' &&
    parts[0] === 'v1' &&
    parts[1] === 'companies' &&
    token(parts[2])
  ) {
    const id = parts[3] === 'postings' && /^\d+$/.test(parts[4] ?? '') ? parts[4] : undefined;
    return { service: 'smartrecruiters', token: parts[2]!, externalId: id ? `${parts[2]}/${id}` : undefined };
  }
  // Workable: apply.workable.com/<slug>[/j/<shortcode>]
  if (host === 'apply.workable.com' && token(parts[0])) {
    const slug = parts[0]!.toLowerCase();
    const code =
      parts[1] === 'j' && /^[A-Z0-9]{6,12}$/i.test(parts[2] ?? '') ? parts[2]!.toUpperCase() : undefined;
    return { service: 'workable', token: slug, externalId: code ? `${slug}/${code}` : undefined };
  }
  // Recruitee: <slug>.recruitee.com[/o/<offer>]
  m = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/.exec(host);
  if (m && m[1] !== 'www' && m[1] !== 'api') {
    const offer = parts[0] === 'o' && SLUG.test(parts[1] ?? '') ? parts[1]!.toLowerCase() : undefined;
    return { service: 'recruitee', token: m[1]!, externalId: offer ? `${m[1]}/${offer}` : undefined };
  }
  return undefined;
}

/** Every board link written in a page, most often named first (a careers page names its own board many times). */
export function boardLinksIn(html: string): { link: BoardLink; n: number }[] {
  const text = decodeEntities(html).replace(/\\\//g, '/');
  const counts = new Map<string, { link: BoardLink; n: number }>();
  const re =
    /https?:\/\/(?:(?:job-)?boards(?:\.eu)?\.greenhouse\.io|boards-api(?:\.eu)?\.greenhouse\.io|jobs(?:\.eu)?\.lever\.co|jobs\.ashbyhq\.com|[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com|wd\d+\.myworkdaysite\.com|(?:jobs|careers)\.smartrecruiters\.com|apply\.workable\.com|[a-z0-9-]+\.recruitee\.com)[^"'\s<>)\\]*/gi;
  for (const m of text.matchAll(re)) {
    const link = boardOfUrl(m[0].replace(/[).,;]+$/, ''));
    if (!link?.token) continue;
    const key = `${link.service}:${link.token.toLowerCase()}`;
    const had = counts.get(key);
    if (had) had.n++;
    else counts.set(key, { link: { service: link.service, token: link.token }, n: 1 });
  }
  // Greenhouse's embed script names the board without a full link: job_board/js?for=<token>
  for (const m of text.matchAll(
    /greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s<>]*?&)?for=([a-z0-9_.-]+)/gi,
  )) {
    const t = token(m[1]);
    if (!t) continue;
    const key = `greenhouse:${t.toLowerCase()}`;
    const had = counts.get(key);
    if (had) had.n++;
    else counts.set(key, { link: { service: 'greenhouse', token: t.toLowerCase() }, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}
