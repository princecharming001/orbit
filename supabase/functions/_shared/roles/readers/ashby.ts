/**
 * Ashby (plan 44 §4.6): one request for the whole board, with each role's text and pay. No paging and no short form,
 * so a board is read whole or not at all. Stage 0 measured 22% of Ashby boards over 2 MB, and parsing about 10 MB
 * costs well under 100 ms, so boards up to ASHBY_MAX_BYTES (12 MB) are read; a board over LARGE_BOARD_BYTES is a
 * tick's whole share of boards (boards.ts). One larger still comes back `too_large` with its size, and the daily
 * digest names it. Ashby says no company name.
 */
import type { JobListing, JobPay, Remote } from '../../../../../packages/core/src/roles/types.ts';
import { pageText } from '../../postings.ts';
import {
  arr,
  askJson,
  type BoardRead,
  fail,
  isoOf,
  num,
  type Obj,
  obj,
  type ReaderNet,
  str,
} from './http.ts';

export const ASHBY_MAX_BYTES = 12_000_000;

const REMOTE: Record<string, Remote> = { remote: 'remote', hybrid: 'hybrid', onsite: 'on_site' };

export function ashbyPay(comp: unknown): JobPay | undefined {
  const c = obj(comp);
  if (!c) return undefined;
  const salary = arr(c.summaryComponents)
    .map(obj)
    .find(
      (x) =>
        x && /salary|hourly/i.test(String(x.compensationType ?? '')) && (num(x.minValue) || num(x.maxValue)),
    );
  if (!salary) return undefined;
  const interval = String(salary.interval ?? '');
  return {
    min: num(salary.minValue),
    max: num(salary.maxValue),
    currency: str(salary.currencyCode),
    per: /hour/i.test(interval) ? 'hour' : /month/i.test(interval) ? 'month' : 'year',
  };
}

export function ashbyListing(j: Obj, companyName: string, org: string): JobListing | undefined {
  const id = str(j.id);
  const title = str(j.title);
  if (!id || !title || j.isListed === false) return undefined;
  const places = [str(j.location), ...arr(j.secondaryLocations).map((s) => str(obj(s)?.location))].filter(
    (x): x is string => !!x,
  );
  const workplace = String(j.workplaceType ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return {
    source: 'ashby',
    externalId: id.toLowerCase(),
    companyName,
    title,
    team: str(j.team) ?? str(j.department),
    locations: places,
    remote: REMOTE[workplace] ?? (j.isRemote === true && !places.length ? 'remote' : undefined),
    pay: ashbyPay(j.compensation),
    url: str(j.jobUrl) ?? `https://jobs.ashbyhq.com/${org}/${id}`,
    applyUrl: str(j.applyUrl),
    postedAt: isoOf(j.publishedAt),
    text: str(j.descriptionPlain)
      ? String(j.descriptionPlain)
      : typeof j.descriptionHtml === 'string'
        ? pageText(j.descriptionHtml)
        : undefined,
    meta: {
      employmentType: str(j.employmentType),
      department: str(j.department),
      isRemote: j.isRemote === true,
      country: str(obj(obj(j.address)?.postalAddress)?.addressCountry),
    },
  };
}

export async function readAshby(
  net: ReaderNet,
  token: string,
  companyName: string,
  maxBytes = ASHBY_MAX_BYTES,
): Promise<BoardRead> {
  const got = await askJson(
    net,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
    { maxBytes },
  );
  if (!got.ok) return { ...got, requests: 1 };
  const jobs = obj(got.value)?.jobs;
  if (!Array.isArray(jobs)) return { ...fail('bad_shape', 'no jobs list'), requests: 1 };
  const listings = jobs
    .map((j) => (obj(j) ? ashbyListing(obj(j)!, companyName, token) : undefined))
    .filter((x): x is JobListing => !!x);
  return { ok: true, listings, bytes: got.bytes, complete: true, requests: 1 };
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(REMOTE, null);
