/**
 * Lever (plan 44 §4.6): read in pages of 50 with `skip` and `limit`; each posting carries its text. Lever says no
 * company name, so the board's own name (where it was found) is used. EU sites are api.eu.lever.co (`eu:<name>`).
 */
import type { JobListing, JobPay, Remote } from '../../../../../packages/core/src/roles/types.ts';
import { pageText } from '../../postings.ts';
import {
  arr,
  askJson,
  type BoardRead,
  fail,
  type Got,
  isoOf,
  num,
  type Obj,
  obj,
  type ReaderNet,
  sleepFor,
  str,
} from './http.ts';

export const LEVER_PAGE = 50;
/** 2,000 roles a board at most; a larger board is read as far as this and its other roles are left open */
export const LEVER_MAX_PAGES = 40;

export function leverBase(token: string): { base: string; name: string; eu: boolean } {
  const eu = token.startsWith('eu:');
  const name = eu ? token.slice(3) : token;
  return { base: `https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(name)}`, name, eu };
}

const REMOTE: Record<string, Remote> = {
  remote: 'remote',
  hybrid: 'hybrid',
  'on-site': 'on_site',
  onsite: 'on_site',
};

/** A posting's words: the description, each list with its heading, and the closing part. */
export function leverText(p: Obj): string {
  const parts = [
    str(p.descriptionPlain) ?? (typeof p.description === 'string' ? pageText(p.description) : ''),
  ];
  for (const l of arr(p.lists)) {
    const o = obj(l);
    if (!o) continue;
    parts.push(`${str(o.text) ?? ''}\n${typeof o.content === 'string' ? pageText(o.content) : ''}`);
  }
  parts.push(str(p.additionalPlain) ?? (typeof p.additional === 'string' ? pageText(p.additional) : ''));
  return parts.filter((x) => x?.trim()).join('\n\n');
}

function leverPay(p: Obj): JobPay | undefined {
  const s = obj(p.salaryRange);
  if (!s || (!num(s.min) && !num(s.max))) return undefined;
  const interval = String(s.interval ?? '');
  return {
    min: num(s.min),
    max: num(s.max),
    currency: str(s.currency),
    per: /hour/i.test(interval) ? 'hour' : /month/i.test(interval) ? 'month' : 'year',
  };
}

export function leverListing(p: Obj, companyName: string): JobListing | undefined {
  const id = str(p.id);
  const title = str(p.text);
  if (!id || !title) return undefined;
  const c = obj(p.categories) ?? {};
  const all = arr(c.allLocations)
    .map((x) => str(x))
    .filter((x): x is string => !!x);
  const one = str(c.location);
  return {
    source: 'lever',
    externalId: id.toLowerCase(),
    companyName,
    title,
    team: str(c.team) ?? str(c.department),
    locations: all.length ? all : one ? [one] : [],
    remote: REMOTE[String(p.workplaceType ?? '').toLowerCase()],
    pay: leverPay(p),
    url: str(p.hostedUrl) ?? '',
    applyUrl: str(p.applyUrl),
    postedAt: isoOf(num(p.createdAt)),
    text: leverText(p),
    meta: { commitment: str(c.commitment), department: str(c.department), country: str(p.country) },
  };
}

export async function readLever(net: ReaderNet, token: string, companyName: string): Promise<BoardRead> {
  const { base } = leverBase(token);
  const listings: JobListing[] = [];
  let bytes = 0;
  let requests = 0;
  for (let page = 0; page < LEVER_MAX_PAGES; page++) {
    if (page > 0) await sleepFor(net)(300);
    const got = await askJson(net, `${base}?mode=json&skip=${page * LEVER_PAGE}&limit=${LEVER_PAGE}`, {
      maxBytes: 4_000_000,
    });
    requests++;
    if (!got.ok)
      return page === 0 ? { ...got, requests } : { ok: true, listings, bytes, complete: false, requests };
    bytes += got.bytes;
    if (!Array.isArray(got.value)) return { ...fail('bad_shape', 'not a list of postings'), requests };
    for (const p of got.value) {
      const l = obj(p) && leverListing(obj(p)!, companyName);
      if (l) listings.push(l);
    }
    if (got.value.length < LEVER_PAGE) return { ok: true, listings, bytes, complete: true, requests };
  }
  return { ok: true, listings, bytes, complete: false, requests };
}

/** One posting with its text. */
export async function readLeverJob(
  net: ReaderNet,
  token: string,
  id: string,
  companyName: string,
): Promise<Got<JobListing>> {
  const { base } = leverBase(token);
  const got = await askJson(net, `${base}/${encodeURIComponent(id)}?mode=json`, { maxBytes: 2_000_000 });
  if (!got.ok) return got;
  const p = obj(got.value);
  const l = p && leverListing(p, companyName);
  return l ? { ok: true, value: l, bytes: got.bytes } : fail('bad_shape', 'not a posting');
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(REMOTE, null);
