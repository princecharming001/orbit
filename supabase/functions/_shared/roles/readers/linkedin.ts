/**
 * The student's own LinkedIn job search, through Unipile (plan 44 §4.4): `POST /api/v1/linkedin/search` with
 * category `jobs`, newest first, and one role's full text from `GET /api/v1/linkedin/jobs/{id}`. The account is the
 * student's; what it finds is kept as listings marked `linkedin`.
 */
import type { JobListing, Remote } from '../../../../../packages/core/src/roles/types.ts';
import type { LinkedinJobAccess, LinkedinJobQuery } from '../contracts.ts';
import { askJson, fail, type Got, isoOf, type Obj, obj, type ReaderNet, str } from './http.ts';

const base = (a: LinkedinJobAccess) => a.base.replace(/\/+$/, '');

/** "Los Gatos, CA (On-site)": the place, and how the role is worked. */
export function linkedinPlace(raw: string | undefined): { place?: string; remote?: Remote } {
  if (!raw) return {};
  const m = /\((on-site|onsite|hybrid|remote)\)\s*$/i.exec(raw);
  const how = m?.[1]?.toLowerCase();
  const place = raw.replace(/\s*\((on-site|onsite|hybrid|remote)\)\s*$/i, '').trim();
  return {
    place: place || undefined,
    remote: how === 'remote' ? 'remote' : how === 'hybrid' ? 'hybrid' : how ? 'on_site' : undefined,
  };
}

export function linkedinListing(it: Obj): JobListing | undefined {
  const id = str(it.id);
  const title = str(it.title);
  const company = obj(it.company);
  const name = str(company?.name) ?? str(it.company);
  if (!id || !title || !name || (it.type && it.type !== 'JOB')) return undefined;
  const { place, remote } = linkedinPlace(str(it.location));
  return {
    source: 'linkedin',
    externalId: id,
    companyName: name,
    companyLinkedinId: str(company?.id),
    companyLogoUrl: str(company?.profile_picture_url),
    title,
    locations: place ? [place] : [],
    remote,
    url: str(it.url) ?? `https://www.linkedin.com/jobs/view/${id}`,
    postedAt: isoOf(it.posted_at),
    meta: {
      companySlug: str(company?.public_identifier),
      easyApply: it.easy_apply === true,
      reposted: it.reposted === true,
      promoted: it.promoted === true,
    },
  };
}

export async function linkedinJobSearch(
  net: ReaderNet,
  access: LinkedinJobAccess,
  q: LinkedinJobQuery,
): Promise<Got<JobListing[]>> {
  const limit = Math.min(50, Math.max(1, q.limit ?? 25));
  const params = new URLSearchParams({ account_id: access.accountId, limit: String(limit) });
  const body: Obj = { api: 'classic', category: 'jobs', keywords: q.keywords, sort_by: 'date' };
  if (q.seniority?.length) body.seniority = q.seniority;
  if (q.jobType?.length) body.job_type = q.jobType;
  if (q.presence?.length) body.presence = q.presence;
  if (q.datePosted) body.date_posted = q.datePosted;
  const got = await askJson(net, `${base(access)}/api/v1/linkedin/search?${params}`, {
    method: 'POST',
    body,
    headers: { 'X-API-KEY': access.apiKey },
    retries: 1,
    maxBytes: 3_000_000,
  });
  if (!got.ok) return got;
  const items = obj(got.value)?.items;
  if (!Array.isArray(items)) return fail('bad_shape', 'no items');
  const out = items
    .map((x) => (obj(x) ? linkedinListing(obj(x)!) : undefined))
    .filter((x): x is JobListing => !!x);
  return { ok: true, value: out, bytes: got.bytes };
}

export interface LinkedinJob {
  text: string;
  title?: string;
  companyName?: string;
  companyLinkedinId?: string;
  place?: string;
  state?: string;
}

export async function linkedinJob(
  net: ReaderNet,
  access: LinkedinJobAccess,
  id: string,
): Promise<Got<LinkedinJob>> {
  const params = new URLSearchParams({ account_id: access.accountId });
  const got = await askJson(net, `${base(access)}/api/v1/linkedin/jobs/${encodeURIComponent(id)}?${params}`, {
    headers: { 'X-API-KEY': access.apiKey },
    retries: 1,
    maxBytes: 2_000_000,
  });
  if (!got.ok) return got;
  const j = obj(got.value);
  if (!j) return fail('bad_shape', 'not a job');
  return {
    ok: true,
    bytes: got.bytes,
    value: {
      text: typeof j.description === 'string' ? j.description : '',
      title: str(j.title),
      companyName: str(j.company) ?? str(obj(j.company)?.name),
      companyLinkedinId: str(j.company_id),
      place: str(j.location),
      state: str(j.state),
    },
  };
}
