/**
 * YC's company directory as yc-oss/api publishes it (a nightly mirror of the public directory, MIT), read into
 * company facts. The server's nightly sync and a browser without an Orbit account both read it with this.
 */
import { COMMON_WORDS } from './commonWords';
import { type CompanyFact, isAmbiguousKey, orgKey, ycBatchOf } from './companies';

export const YC_OSS_URL = 'https://yc-oss.github.io/api/companies/all.json';

export interface YcOssCompany {
  id?: number;
  name?: string;
  /** the company's page: https://www.ycombinator.com/companies/<slug> */
  slug?: string;
  former_names?: string[];
  website?: string;
  one_liner?: string;
  team_size?: number | null;
  batch?: string;
  status?: string;
  stage?: string;
  industries?: string[];
  tags?: string[];
}

const STATUSES = new Set(['Active', 'Inactive', 'Acquired', 'Public']);
const STAGES = new Set(['Early', 'Growth']);
const clip = (s: unknown, n: number) =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined;

/** One directory entry as a fact, or undefined when it has no usable name. */
export function ycOssFact(c: YcOssCompany, asOf?: string): CompanyFact | undefined {
  const name = clip(c.name, 160);
  const key = name ? orgKey(name) : '';
  if (!name || !key) return undefined;
  const words = [...(c.industries ?? []), ...(c.tags ?? [])]
    .filter((w): w is string => typeof w === 'string' && !!w.trim())
    .map((w) => w.trim().slice(0, 60));
  const team =
    typeof c.team_size === 'number' && Number.isFinite(c.team_size) && c.team_size >= 0
      ? c.team_size
      : undefined;
  const formerNames = (c.former_names ?? [])
    .filter((n): n is string => typeof n === 'string' && !!n.trim())
    .slice(0, 5);
  const f: CompanyFact = { key, name, source: 'yc' };
  if (formerNames.length) f.formerNames = formerNames;
  const website = clip(c.website, 300);
  if (website) f.website = website;
  const batch = ycBatchOf(c.batch);
  if (batch) f.ycBatch = batch;
  if (c.status && STATUSES.has(c.status)) f.ycStatus = c.status as CompanyFact['ycStatus'];
  if (c.stage && STAGES.has(c.stage)) f.ycStage = c.stage as CompanyFact['ycStage'];
  if (team !== undefined) f.teamSize = team;
  const industries = [...new Set(words)].slice(0, 16);
  if (industries.length) f.industries = industries;
  const oneLiner = clip(c.one_liner, 300);
  if (oneLiner) f.oneLiner = oneLiner;
  if (isAmbiguousKey(key, COMMON_WORDS)) f.ambiguousName = true;
  if (asOf) f.asOf = asOf;
  return f;
}

/** A YC company page's address, for a directory slug that looks like one. */
export function ycCompanyUrl(slug: string | undefined): string | undefined {
  return slug && /^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)
    ? `https://www.ycombinator.com/companies/${slug}`
    : undefined;
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export interface YcFounder {
  name: string;
  title?: string;
  active?: boolean;
}

/**
 * The founders a YC company page lists (the page's embedded data: props.company.founders, each with full_name, title
 * and is_active). Undefined when the page has no such data (a changed page, a block page), so nothing is overwritten.
 */
export function parseYcFounders(html: string): YcFounder[] | undefined {
  const m = /data-page="([^"]+)"/.exec(html);
  if (!m?.[1]) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(unescapeHtml(m[1]));
  } catch {
    return undefined;
  }
  const list = (data as { props?: { company?: { founders?: unknown } } })?.props?.company?.founders;
  if (!Array.isArray(list)) return undefined;
  const out: YcFounder[] = [];
  for (const f of list as { full_name?: unknown; title?: unknown; is_active?: unknown }[]) {
    const name = clip(f?.full_name, 120);
    if (!name) continue;
    const title = clip(f?.title, 80);
    out.push({ name, ...(title ? { title } : {}), ...(f?.is_active === false ? { active: false } : {}) });
  }
  return out.slice(0, 12);
}
