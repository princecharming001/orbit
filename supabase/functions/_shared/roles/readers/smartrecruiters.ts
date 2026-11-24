/**
 * SmartRecruiters (plan 44 §14): a company's postings in pages of 100, no text; one posting's text from its detail.
 * The company id is case sensitive ("Visa"); an unknown id answers an empty list, which reads as an empty board.
 */
import type { JobLevel, JobListing } from '../../../../../packages/core/src/roles/types.ts';
import { pageText } from '../../postings.ts';
import {
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

export const SR_PAGE = 100;
export const SR_MAX_PAGES = 10;

/** SmartRecruiters' own experience level, when it says something a title might not. */
const SR_LEVEL: Record<string, JobLevel> = {
  internship: 'intern',
  entry_level: 'entry',
  director: 'exec',
  executive: 'exec',
};

export async function readSmartRecruiters(
  net: ReaderNet,
  token: string,
  companyName?: string,
): Promise<BoardRead> {
  const listings: JobListing[] = [];
  let bytes = 0;
  let requests = 0;
  for (let page = 0; page < SR_MAX_PAGES; page++) {
    if (page > 0) await sleepFor(net)(300);
    const got = await askJson(
      net,
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${SR_PAGE}&offset=${page * SR_PAGE}`,
      { maxBytes: 3_000_000 },
    );
    requests++;
    if (!got.ok)
      return page === 0 ? { ...got, requests } : { ok: true, listings, bytes, complete: false, requests };
    bytes += got.bytes;
    const o = obj(got.value);
    const content = o?.content;
    if (!Array.isArray(content)) return { ...fail('bad_shape', 'no content'), requests };
    for (const raw of content) {
      const p = obj(raw);
      const id = str(p?.id);
      const title = str(p?.name);
      if (!p || !id || !title) continue;
      const loc = obj(p.location) ?? {};
      const place =
        str(loc.fullLocation) ??
        [str(loc.city), str(loc.region), str(loc.country)?.toUpperCase()].filter(Boolean).join(', ');
      listings.push({
        source: 'smartrecruiters',
        externalId: `${token}/${id}`,
        companyName: str(obj(p.company)?.name) ?? companyName ?? token,
        title,
        team: str(obj(p.department)?.label),
        locations: place ? [place] : [],
        remote: loc.remote === true ? 'remote' : loc.hybrid === true ? 'hybrid' : undefined,
        level: SR_LEVEL[String(obj(p.experienceLevel)?.id ?? '')],
        language: str(obj(p.language)?.code),
        url: `https://jobs.smartrecruiters.com/${token}/${id}`,
        postedAt: isoOf(p.releasedDate),
        meta: {
          employment: str(obj(p.typeOfEmployment)?.label),
          experience: str(obj(p.experienceLevel)?.id),
          function: str(obj(p.function)?.label),
          ref: str(p.refNumber),
        },
      });
    }
    const total = num(o?.totalFound) ?? 0;
    if (content.length < SR_PAGE || (page + 1) * SR_PAGE >= total)
      return { ok: true, listings, bytes, complete: true, requests };
  }
  return { ok: true, listings, bytes, complete: false, requests };
}

/** One posting's text: its job ad's sections. */
export interface SmartRecruitersJob {
  text: string;
  url?: string;
  title?: string;
  companyName?: string;
  place?: string;
  postedAt?: string;
}

export async function readSmartRecruitersJob(
  net: ReaderNet,
  token: string,
  id: string,
): Promise<Got<SmartRecruitersJob>> {
  const got = await askJson(
    net,
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(id)}`,
    { maxBytes: 2_000_000 },
  );
  if (!got.ok) return got;
  const sections = obj(obj(obj(got.value)?.jobAd)?.sections);
  if (!sections) return fail('bad_shape', 'no job ad');
  const parts: string[] = [];
  for (const k of ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']) {
    const s = obj(sections[k]);
    const html = typeof s?.text === 'string' ? s.text : '';
    if (html.trim()) parts.push(`${str(s?.title) ?? ''}\n${pageText(html)}`.trim());
  }
  const o = obj(got.value)!;
  return {
    ok: true,
    value: {
      text: parts.join('\n\n'),
      url: str(o.postingUrl),
      title: str(o.name),
      companyName: str(obj(o.company)?.name),
      place: str(obj(o.location)?.fullLocation),
      postedAt: isoOf(o.releasedDate),
    },
    bytes: got.bytes,
  };
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(SR_LEVEL, null);
