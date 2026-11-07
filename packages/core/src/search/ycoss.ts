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
