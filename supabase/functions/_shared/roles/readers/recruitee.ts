/**
 * Recruitee (plan 44 §14): every offer in one request, each with its text, places, department, experience and
 * education codes. A role is keyed `<company>/<offer slug>`, the way its link names it.
 */
import type { JobLevel, JobListing, JobPay } from '../../../../../packages/core/src/roles/types.ts';
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
  str,
} from './http.ts';

export const RECRUITEE_MAX_BYTES = 6_000_000;

const DEGREES: Record<string, string> = {
  high_school: 'High School',
  associate_degree: "Associate's",
  bachelor_degree: "Bachelor's",
  master_degree: "Master's",
  doctorate_degree: 'PhD',
  professional: 'Professional',
};

function recruiteeLevel(code: string | undefined): JobLevel | undefined {
  const c = (code ?? '').toLowerCase();
  if (/intern|student/.test(c)) return 'intern';
  if (/entry/.test(c)) return 'entry';
  if (/executive/.test(c)) return 'exec';
  return undefined;
}

export function recruiteeListing(o: Obj, token: string): JobListing | undefined {
  const slug = str(o.slug);
  const title = str(o.title);
  if (!slug || !title) return undefined;
  const places = arr(o.locations)
    .map((l) => {
      const x = obj(l);
      return x ? [str(x.city), str(x.state), str(x.country)].filter(Boolean).join(', ') : '';
    })
    .filter((x) => !!x);
  const one = str(o.location);
  const salary = obj(o.salary);
  const pay: JobPay | undefined =
    salary && (num(salary.min) || num(salary.max))
      ? {
          min: num(salary.min),
          max: num(salary.max),
          currency: str(salary.currency),
          per: /hour/i.test(String(salary.period ?? ''))
            ? 'hour'
            : /month/i.test(String(salary.period ?? ''))
              ? 'month'
              : 'year',
        }
      : undefined;
  const degree = DEGREES[String(o.education_code ?? '')];
  const html = `${typeof o.description === 'string' ? o.description : ''}\n${typeof o.requirements === 'string' ? o.requirements : ''}`;
  return {
    source: 'recruitee',
    externalId: `${token}/${slug.toLowerCase()}`,
    companyName: str(o.company_name) ?? token,
    title,
    team: str(o.department),
    locations: [...new Set(places.length ? places : one ? [one] : [])],
    remote:
      o.remote === true
        ? 'remote'
        : o.hybrid === true
          ? 'hybrid'
          : o.on_site === true
            ? 'on_site'
            : undefined,
    level: recruiteeLevel(str(o.experience_code)),
    pay,
    degrees: degree ? [degree] : undefined,
    url: str(o.careers_url) ?? `https://${token}.recruitee.com/o/${slug}`,
    applyUrl: str(o.careers_apply_url),
    postedAt: isoOf(o.published_at) ?? isoOf(o.created_at),
    text: html.trim() ? pageText(html) : undefined,
    meta: {
      employment: str(o.employment_type_code),
      experience: str(o.experience_code),
      education: str(o.education_code),
      country: str(o.country_code),
    },
  };
}

export async function readRecruitee(net: ReaderNet, token: string): Promise<BoardRead> {
  const got = await askJson(net, `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`, {
    maxBytes: RECRUITEE_MAX_BYTES,
  });
  if (!got.ok) return { ...got, requests: 1 };
  const offers = obj(got.value)?.offers;
  if (!Array.isArray(offers)) return { ...fail('bad_shape', 'no offers'), requests: 1 };
  const listings = offers
    .map((x) => (obj(x) ? recruiteeListing(obj(x)!, token) : undefined))
    .filter((x): x is JobListing => !!x);
  return { ok: true, listings, bytes: got.bytes, complete: true, requests: 1 };
}

/** One offer, by its slug. */
export async function readRecruiteeJob(
  net: ReaderNet,
  token: string,
  slug: string,
): Promise<Got<JobListing>> {
  const got = await askJson(
    net,
    `https://${encodeURIComponent(token)}.recruitee.com/api/offers/${encodeURIComponent(slug)}`,
    { maxBytes: 2_000_000 },
  );
  if (!got.ok) return got;
  const o = obj(obj(got.value)?.offer);
  const l = o && recruiteeListing(o, token);
  return l ? { ok: true, value: l, bytes: got.bytes } : fail('bad_shape', 'not an offer');
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
Object.setPrototypeOf(DEGREES, null);
