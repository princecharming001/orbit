/**
 * The SimplifyJobs lists (plan 44 §14, approved by the owner): the internship list and the new grad list, about 13 MB
 * each, read once a day. Only entries that are active and visible become listings. Each entry's `url` is usually the
 * company's own posting, so it also names the company's board (discover.ts harvests those) and the board role the
 * entry repeats (`meta.boardRef`, which intake uses to show the board's role instead).
 *
 * Sponsorship: "Offers Sponsorship" is `offers`; "Does Not Offer Sponsorship" and "U.S. Citizenship is Required" are
 * `none`, the second with `meta.citizenship` so the score can ask about it; "Other" says nothing.
 */
import type { JobListing } from '../../../../../packages/core/src/roles/types.ts';
import { boardOfUrl } from './boardUrls.ts';
import { arr, askJson, fail, type Got, type Obj, obj, type ReaderNet, str } from './http.ts';

export const SIMPLIFY_LISTS = {
  intern:
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  newgrad:
    'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
} as const;
export type SimplifyList = keyof typeof SIMPLIFY_LISTS;
export const SIMPLIFY_MAX_BYTES = 40_000_000;

export function simplifyListing(x: Obj, list: SimplifyList): JobListing | undefined {
  if (x.active !== true || x.is_visible === false) return undefined;
  const id = str(x.id);
  const title = str(x.title);
  const company = str(x.company_name);
  const url = str(x.url);
  if (!id || !title || !company || !url) return undefined;
  const sponsorRaw = str(x.sponsorship);
  const sponsorship =
    sponsorRaw === 'Offers Sponsorship'
      ? 'offers'
      : sponsorRaw === 'Does Not Offer Sponsorship' || sponsorRaw === 'U.S. Citizenship is Required'
        ? 'none'
        : undefined;
  const terms = arr(x.terms)
    .map((t) => str(t))
    .filter((t): t is string => !!t && !/^n\/?a$/i.test(t));
  const posted = typeof x.date_posted === 'number' ? new Date(x.date_posted * 1000).toISOString() : undefined;
  const board = boardOfUrl(url);
  return {
    source: 'simplify',
    externalId: id,
    companyName: company,
    title,
    locations: arr(x.locations)
      .map((l) => str(l))
      .filter((l): l is string => !!l),
    level: list === 'intern' ? 'intern' : undefined,
    employment: list === 'intern' ? 'internship' : undefined,
    term: terms.length ? terms.join(', ') : undefined,
    sponsorship,
    degrees: arr(x.degrees)
      .map((d) => str(d))
      .filter((d): d is string => !!d),
    url,
    applyUrl: url,
    postedAt: posted,
    meta: {
      list,
      category: str(x.category),
      companyUrl: str(x.company_url),
      ...(sponsorRaw && sponsorRaw !== 'Other' ? { sponsorshipNote: sponsorRaw } : {}),
      ...(sponsorRaw === 'U.S. Citizenship is Required' ? { citizenship: true } : {}),
      ...(board?.externalId ? { boardRef: `${board.service}:${board.externalId}` } : {}),
    },
  };
}

export interface SimplifyRead {
  listings: JobListing[];
  entries: number;
}

/** One list, read whole. */
export async function readSimplify(net: ReaderNet, list: SimplifyList): Promise<Got<SimplifyRead>> {
  const got = await askJson(net, SIMPLIFY_LISTS[list], { maxBytes: SIMPLIFY_MAX_BYTES, accept: '*/*' });
  if (!got.ok) return got;
  if (!Array.isArray(got.value)) return fail('bad_shape', 'not a list');
  const listings: JobListing[] = [];
  for (const raw of got.value) {
    const x = obj(raw);
    const l = x && simplifyListing(x, list);
    if (l) listings.push(l);
  }
  return { ok: true, value: { listings, entries: got.value.length }, bytes: got.bytes };
}
