/**
 * Workday career sites (plan 44 §14): the public job search each site's own page calls. 20 roles a page, newest
 * first, with no text; one role's text, places and dates from its detail. A board's token is `<host>/<tenant>/<site>`
 * (nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite). Large sites (NVIDIA lists over 2,000) are read to
 * WORKDAY_MAX_PAGES a day; Workday answers 429 when asked too fast, so pages are spaced and 429 backs off.
 */
import type { JobListing, Remote } from '../../../../../packages/core/src/roles/types.ts';
import { pageText } from '../../postings.ts';
import { workdayRoleKey } from './boardUrls.ts';
import {
  arr,
  askJson,
  type BoardRead,
  fail,
  type Got,
  isoOf,
  num,
  obj,
  type ReaderNet,
  sleepFor,
  str,
} from './http.ts';

export const WORKDAY_PAGE = 20;
export const WORKDAY_MAX_PAGES = 25;

export function workdayParts(token: string): { host: string; tenant: string; site: string } | undefined {
  const [host, tenant, site] = token.split('/');
  return host && tenant && site ? { host, tenant, site } : undefined;
}

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago": a day, from now. */
export function workdayPosted(postedOn: string | undefined, now: Date): string | undefined {
  if (!postedOn) return undefined;
  const t = postedOn.toLowerCase();
  const day = (n: number) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * 86_400_000,
    ).toISOString();
  if (/today/.test(t)) return day(0);
  if (/yesterday/.test(t)) return day(1);
  const n = /(\d+)\+?\s*days?/.exec(t);
  return n ? day(Number(n[1])) : undefined;
}

/** "US-CA-Santa-Clara" from a role's path: the place a "3 Locations" role is first listed in. */
export function workdayPathPlace(path: string): string | undefined {
  const seg = path.split('/').filter(Boolean)[1];
  if (!seg) return undefined;
  const m = /^([A-Z]{2})-([A-Z]{2})-(.+)$/.exec(seg);
  if (m) return `${m[3]!.replace(/-/g, ' ')}, ${m[2]}, ${m[1]}`;
  return undefined;
}

export async function readWorkday(
  net: ReaderNet,
  token: string,
  companyName: string,
  maxPages = WORKDAY_MAX_PAGES,
): Promise<BoardRead> {
  const w = workdayParts(token);
  if (!w) return { ...fail('bad_shape', 'not a Workday token'), requests: 0 };
  const url = `https://${w.host}/wday/cxs/${w.tenant}/${w.site}/jobs`;
  const listings: JobListing[] = [];
  let bytes = 0;
  let requests = 0;
  let total: number | undefined;
  const now = net.now();
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleepFor(net)(800);
    const got = await askJson(net, url, {
      method: 'POST',
      body: { appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: '' },
      maxBytes: 1_000_000,
    });
    requests++;
    if (!got.ok)
      return page === 0 ? { ...got, requests } : { ok: true, listings, bytes, complete: false, requests };
    bytes += got.bytes;
    const o = obj(got.value);
    const posts = o?.jobPostings;
    if (!Array.isArray(posts)) return { ...fail('bad_shape', 'no jobPostings'), requests };
    // Workday gives the total on the first page only
    if (page === 0) total = num(o?.total);
    for (const raw of posts) {
      const p = obj(raw);
      const title = str(p?.title);
      const path = str(p?.externalPath);
      if (!p || !title || !path) continue;
      const where = str(p.locationsText);
      const several = !!where && /^\d+\s+locations?$/i.test(where);
      const first = several ? workdayPathPlace(path) : where;
      listings.push({
        source: 'workday',
        externalId: workdayRoleKey(w.tenant, w.site, path),
        companyName,
        title,
        locations: first ? [first] : [],
        url: `https://${w.host}/${w.site}${path}`,
        postedAt: workdayPosted(str(p.postedOn), now),
        meta: {
          path,
          requisitionId: str(arr(p.bulletFields)[0]),
          ...(several ? { locationsText: where } : {}),
        },
      });
    }
    if (posts.length < WORKDAY_PAGE || (total !== undefined && (page + 1) * WORKDAY_PAGE >= total))
      return { ok: true, listings, bytes, complete: true, requests };
  }
  return { ok: true, listings, bytes, complete: false, requests };
}

export interface WorkdayJob {
  text: string;
  places: string[];
  title?: string;
  postedAt?: string;
  remote?: Remote;
  timeType?: string;
  companyName?: string;
}

/**
 * One role's detail: its text and every place it is listed in. A 429 is not asked again here (`retries` 0 for it is
 * the caller's choice): sources.ts spaces these reads and stops asking Workday for a while after one.
 */
export async function readWorkdayJob(
  net: ReaderNet,
  token: string,
  path: string,
  o: { retries?: number } = {},
): Promise<Got<WorkdayJob>> {
  const w = workdayParts(token);
  if (!w) return fail('bad_shape', 'not a Workday token');
  const got = await askJson(net, `https://${w.host}/wday/cxs/${w.tenant}/${w.site}${path}`, {
    maxBytes: 2_000_000,
    ...(o.retries !== undefined ? { retries: o.retries } : {}),
  });
  if (!got.ok) return got;
  const info = obj(obj(got.value)?.jobPostingInfo);
  if (!info) return fail('bad_shape', 'no jobPostingInfo');
  const places = [str(info.location), ...arr(info.additionalLocations).map((x) => str(x))].filter(
    (x): x is string => !!x,
  );
  const remoteType = String(info.remoteType ?? '').toLowerCase();
  return {
    ok: true,
    bytes: got.bytes,
    value: {
      text: typeof info.jobDescription === 'string' ? pageText(info.jobDescription) : '',
      places,
      title: str(info.title),
      postedAt: isoOf(info.startDate) ?? workdayPosted(str(info.postedOn), net.now()),
      remote: /remote/.test(remoteType)
        ? 'remote'
        : /hybrid/.test(remoteType)
          ? 'hybrid'
          : remoteType
            ? 'on_site'
            : undefined,
      timeType: str(info.timeType),
      companyName: str(obj(obj(got.value)?.hiringOrganization)?.name),
    },
  };
}
