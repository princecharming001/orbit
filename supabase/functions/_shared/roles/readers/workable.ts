/**
 * Workable (plan 44 §14): the v3 job search each company's careers page calls (POST, paged by `nextPage`), no text;
 * one role's text from the v2 job. The older widget answers 429 to a reader and is not used.
 */
import type { JobListing, Remote } from '../../../../../packages/core/src/roles/types.ts';
import { pageText } from '../../postings.ts';
import {
  arr,
  askJson,
  type BoardRead,
  fail,
  type Got,
  isoOf,
  obj,
  type ReaderNet,
  sleepFor,
  str,
} from './http.ts';

export const WORKABLE_MAX_PAGES = 10;

const REMOTE: Record<string, Remote> = {
  remote: 'remote',
  hybrid: 'hybrid',
  on_site: 'on_site',
  onsite: 'on_site',
};

export async function readWorkable(net: ReaderNet, token: string, companyName: string): Promise<BoardRead> {
  const listings: JobListing[] = [];
  let bytes = 0;
  let requests = 0;
  let next: string | undefined;
  for (let page = 0; page < WORKABLE_MAX_PAGES; page++) {
    if (page > 0) await sleepFor(net)(500);
    const got = await askJson(
      net,
      `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(token)}/jobs`,
      {
        method: 'POST',
        body: {
          query: '',
          location: [],
          department: [],
          worktype: [],
          remote: [],
          ...(next ? { token: next } : {}),
        },
        maxBytes: 2_000_000,
      },
    );
    requests++;
    if (!got.ok)
      return page === 0 ? { ...got, requests } : { ok: true, listings, bytes, complete: false, requests };
    bytes += got.bytes;
    const o = obj(got.value);
    const results = o?.results;
    if (!Array.isArray(results)) return { ...fail('bad_shape', 'no results'), requests };
    for (const raw of results) {
      const j = obj(raw);
      const code = str(j?.shortcode);
      const title = str(j?.title);
      if (!j || !code || !title || j.state === 'closed') continue;
      const places = (arr(j.locations).length ? arr(j.locations) : [j.location])
        .map((l) => {
          const x = obj(l);
          return x ? [str(x.city), str(x.region), str(x.country)].filter(Boolean).join(', ') : '';
        })
        .filter((x) => !!x);
      listings.push({
        source: 'workable',
        externalId: `${token}/${code.toUpperCase()}`,
        companyName,
        title,
        team: str(arr(j.department)[0]),
        locations: [...new Set(places)],
        remote: REMOTE[String(j.workplace ?? '').toLowerCase()] ?? (j.remote === true ? 'remote' : undefined),
        language: str(j.language),
        url: `https://apply.workable.com/${token}/j/${code.toUpperCase()}/`,
        postedAt: isoOf(j.published),
        meta: { type: str(j.type) },
      });
    }
    next = str(o?.nextPage);
    if (!next || !results.length) return { ok: true, listings, bytes, complete: true, requests };
  }
  return { ok: true, listings, bytes, complete: false, requests };
}

/** One role's text: description, requirements and benefits. */
export async function readWorkableJob(
  net: ReaderNet,
  token: string,
  code: string,
): Promise<Got<{ text: string; title?: string; place?: string }>> {
  const got = await askJson(
    net,
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(token)}/jobs/${encodeURIComponent(code)}`,
    { maxBytes: 2_000_000 },
  );
  if (!got.ok) return got;
  const j = obj(got.value);
  if (!j) return fail('bad_shape', 'not a job');
  const text = ['description', 'requirements', 'benefits']
    .map((k) => (typeof j[k] === 'string' ? pageText(j[k] as string) : ''))
    .filter((x) => x.trim())
    .join('\n\n');
  const loc = obj(j.location);
  const place = loc
    ? [str(loc.city), str(loc.region), str(loc.country)].filter(Boolean).join(', ')
    : undefined;
  return { ok: true, value: { text, title: str(j.title), place: place || undefined }, bytes: got.bytes };
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(REMOTE, null);
