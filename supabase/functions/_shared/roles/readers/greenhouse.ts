/**
 * Greenhouse (plan 44 §4.6): the board's roles listed without their text (Stripe: 0.5 MB, against 6 MB with it), and
 * one role's text read on its own when it is needed. Greenhouse says the company's name, each role's language and
 * when it was updated. EU boards live on boards-api.eu.greenhouse.io (token `eu:<name>`).
 */
import type { JobListing, JobPay } from '../../../../../packages/core/src/roles/types.ts';
import { decodeEntities, pageText } from '../../postings.ts';
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
  str,
} from './http.ts';

export const GREENHOUSE_MAX_BYTES = 6_000_000;

export function greenhouseBase(token: string): { base: string; name: string } {
  const eu = token.startsWith('eu:');
  const name = eu ? token.slice(3) : token;
  return {
    base: `https://boards-api${eu ? '.eu' : ''}.greenhouse.io/v1/boards/${encodeURIComponent(name)}`,
    name,
  };
}

/** Pay from Greenhouse's custom fields ("Salary Range": "$120,000 - $150,000") when one says so plainly. */
export function greenhouseMetaPay(metadata: unknown): JobPay | undefined {
  for (const m of arr(metadata)) {
    const o = obj(m);
    if (!o || !/salary|pay|compensation|wage/i.test(String(o.name ?? ''))) continue;
    const v = obj(o.value);
    if (v && (num(v.min_value) || num(v.max_value)))
      return { min: num(v.min_value), max: num(v.max_value), currency: str(v.unit) ?? 'USD', per: 'year' };
    const text = typeof o.value === 'string' ? o.value : undefined;
    if (text) {
      const nums = [...text.matchAll(/\$?\s?(\d{2,3}(?:,\d{3})+|\d{4,7})(?:\.\d+)?\s*(k)?/gi)].map(
        (x) => Number(x[1]!.replace(/,/g, '')) * (x[2] ? 1000 : 1),
      );
      if (nums.length)
        return {
          min: nums[0],
          max: nums[1] ?? nums[0],
          currency: 'USD',
          per: nums[0]! < 500 ? 'hour' : 'year',
        };
    }
  }
  return undefined;
}

export async function readGreenhouse(
  net: ReaderNet,
  token: string,
  companyName?: string,
): Promise<BoardRead> {
  const { base, name } = greenhouseBase(token);
  const got = await askJson(net, `${base}/jobs`, { maxBytes: GREENHOUSE_MAX_BYTES });
  if (!got.ok) return { ...got, requests: 1 };
  const jobs = obj(got.value)?.jobs;
  if (!Array.isArray(jobs)) return { ...fail('bad_shape', 'no jobs list'), requests: 1 };
  const boardName = str(obj(jobs[0])?.company_name);
  const listings: JobListing[] = [];
  for (const raw of jobs) {
    const j = obj(raw);
    const id = str(j?.id);
    const title = str(j?.title);
    if (!j || !id || !title) continue;
    const place = str(obj(j.location)?.name);
    listings.push({
      source: 'greenhouse',
      externalId: id,
      companyName: str(j.company_name) ?? companyName ?? boardName ?? name,
      title,
      locations: place ? [place] : [],
      language: str(j.language),
      pay: greenhouseMetaPay(j.metadata),
      url: str(j.absolute_url) ?? `https://job-boards.greenhouse.io/${name}/jobs/${id}`,
      postedAt: isoOf(j.first_published) ?? isoOf(j.updated_at),
      meta: {
        updatedAt: str(j.updated_at),
        requisitionId: str(j.requisition_id),
        education: str(j.education),
        deadline: str(j.application_deadline),
      },
    });
  }
  return { ok: true, listings, bytes: got.bytes, complete: true, companyName: boardName, requests: 1 };
}

export interface GreenhouseJob {
  text: string;
  team?: string;
  pay?: JobPay;
  title?: string;
  place?: string;
}

/** One role with its text. The content comes as escaped HTML. */
export async function readGreenhouseJob(
  net: ReaderNet,
  token: string,
  id: string,
): Promise<Got<GreenhouseJob>> {
  const { base } = greenhouseBase(token);
  const got = await askJson(net, `${base}/jobs/${encodeURIComponent(id)}?pay_transparency=true`, {
    maxBytes: 2_000_000,
  });
  if (!got.ok) return got;
  const j = obj(got.value);
  if (!j) return fail('bad_shape', 'not a job');
  const range = obj(arr(j.pay_input_ranges)[0]);
  const pay: JobPay | undefined = range
    ? {
        min: (num(range.min_cents) ?? 0) / 100 || undefined,
        max: (num(range.max_cents) ?? 0) / 100 || undefined,
        currency: str(range.currency_type),
        per: 'year',
      }
    : greenhouseMetaPay(j.metadata);
  return {
    ok: true,
    bytes: got.bytes,
    value: {
      text: pageText(decodeEntities(typeof j.content === 'string' ? j.content : '')),
      team: str(obj(arr(j.departments)[0])?.name),
      pay,
      title: str(j.title),
      place: str(obj(j.location)?.name),
    },
  };
}

/** The company's name as the board reports it (`/v1/boards/<token>` answers `{name}`), for discovery by name. */
export async function greenhouseBoardName(net: ReaderNet, token: string): Promise<Got<string | undefined>> {
  const { base } = greenhouseBase(token);
  const got = await askJson(net, base, { maxBytes: 200_000, retries: 1 });
  if (!got.ok) return got;
  return { ok: true, value: str(obj(got.value)?.name), bytes: got.bytes };
}
