/**
 * Plan 44: the source side's seam for the search side (contracts.ts `RoleSources`).
 *
 * - `keep`: intake and store listings, and return the roles shown for them.
 * - `text`: a stored role's posting text, read from where the role lives when it is not kept yet or is older than
 *   7 days: Greenhouse's job, Lever's posting (description, lists, closing), Ashby's job page, Workday's detail,
 *   SmartRecruiters', Workable's and Recruitee's own, LinkedIn's job through the student's account, and for a
 *   SimplifyJobs entry or a pasted posting, the link it names. Stored cleaned and capped, with its hash. A board that
 *   answers that the role is gone closes it.
 * - `linkedinSearch`: one job search through the student's own LinkedIn.
 * - `readUrl`: a posting by its link, with its text (the posting reader in postings.ts drops the text).
 */
import { roleLevel, termOf } from '@orbit/core/roles/level';
import type { JobListing, JobPay, Remote } from '../../../../packages/core/src/roles/types.ts';
import type { Db } from '../db.ts';
import { decodeEntities, embeddedJobLink, pageText, postingUrlProblem } from '../postings.ts';
import { nameFromToken } from './boards.ts';
import type { LinkedinJobAccess, RoleNet, RoleSources } from './contracts.ts';
import { cleanText, countriesOf, keep, payFromText, sha256, splitPlaces } from './intake.ts';
import { boardOfUrl } from './readers/boardUrls.ts';
import { readGreenhouseJob } from './readers/greenhouse.ts';
import { askText, type Got, isoOf, num, type Obj, obj, type ReaderNet, str } from './readers/http.ts';
import { readLeverJob } from './readers/lever.ts';
import { linkedinJob, linkedinJobSearch } from './readers/linkedin.ts';
import { readRecruiteeJob } from './readers/recruitee.ts';
import { readSmartRecruitersJob } from './readers/smartrecruiters.ts';
import { readWorkableJob } from './readers/workable.ts';
import { readWorkdayJob } from './readers/workday.ts';
import { count } from './usage.ts';

/** A kept text older than this is read again when asked for. */
export const TEXT_FRESH_MS = 7 * 86_400_000;
const PAGE_MAX_BYTES = 1_500_000;

// ---- a posting page's JobPosting block, text included ------------------------------------------------------------------

export interface JobLd {
  title: string;
  company: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  places: string[];
  remote?: Remote;
  pay?: JobPay;
}

/** schema.org JobPosting data on a page, with its description (which postings.ts `jsonLdPosting` leaves out). */
export function jobLdOf(html: string): JobLd | undefined {
  for (const b of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(b[1]!.trim());
    } catch {
      continue;
    }
    const items = (Array.isArray(data) ? data : [data]).flatMap((d) =>
      Array.isArray(obj(d)?.['@graph']) ? (obj(d)!['@graph'] as unknown[]) : [d],
    );
    for (const it of items) {
      const o = obj(it);
      const type = o?.['@type'];
      if (!o || !(type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting')))) continue;
      const org = o.hiringOrganization;
      const company = typeof org === 'string' ? str(org) : str(obj(org)?.name);
      const title = str(o.title);
      if (!company || !title) continue;
      const places = (Array.isArray(o.jobLocation) ? o.jobLocation : [o.jobLocation])
        .map((l) => {
          const a = obj(obj(l)?.address);
          return a
            ? [str(a.addressLocality), str(a.addressRegion), str(a.addressCountry)].filter(Boolean).join(', ')
            : '';
        })
        .filter((x) => !!x);
      const salary = obj(obj(o.baseSalary)?.value);
      const unit = String(obj(o.baseSalary)?.value && salary?.unitText ? salary.unitText : '');
      const pay: JobPay | undefined =
        salary && (num(salary.minValue) || num(salary.maxValue) || num(salary.value))
          ? {
              min: num(salary.minValue) ?? num(salary.value),
              max: num(salary.maxValue) ?? num(salary.value),
              currency: str(obj(o.baseSalary)?.currency),
              per: /hour/i.test(unit) ? 'hour' : /month/i.test(unit) ? 'month' : 'year',
            }
          : undefined;
      return {
        title: decodeEntities(title),
        company: decodeEntities(company),
        description: typeof o.description === 'string' ? pageText(decodeEntities(o.description)) : undefined,
        datePosted: isoOf(o.datePosted),
        employmentType: Array.isArray(o.employmentType) ? str(o.employmentType[0]) : str(o.employmentType),
        places,
        remote: o.jobLocationType === 'TELECOMMUTE' ? 'remote' : undefined,
        pay,
      };
    }
  }
  return undefined;
}

// ---- reading a posting by its link -------------------------------------------------------------------------------

const LINKEDIN_JOB =
  /linkedin\.com\/(?:comm\/)?jobs\/(?:view\/(?:[^/?#]*-)?(\d{6,})|.*[?&]currentJobId=(\d{6,}))/i;

async function pageListing(
  net: ReaderNet,
  url: string,
  depth = 0,
): Promise<JobListing | { problem: string }> {
  const got = await askText(net, url, {
    accept: 'text/html,application/xhtml+xml',
    maxBytes: PAGE_MAX_BYTES,
    retries: 1,
  });
  if (!got.ok)
    return {
      problem:
        got.reason === 'not_found'
          ? 'That posting is no longer listed.'
          : "Orbit couldn't open that page. Paste the posting's text.",
    };
  const ld = jobLdOf(got.value);
  if (ld)
    return {
      source: 'posting',
      externalId: url,
      companyName: ld.company,
      title: ld.title,
      locations: ld.places,
      remote: ld.remote,
      pay: ld.pay,
      url,
      postedAt: ld.datePosted,
      text: ld.description,
      meta: { employmentType: ld.employmentType },
    };
  // a careers site that frames its board: the one job link it carries
  const inner = depth === 0 ? embeddedJobLink(got.value) : undefined;
  if (inner && inner !== url && !postingUrlProblem(inner))
    return readUrlWith(net, inner, undefined, depth + 1);
  return { problem: "Orbit cannot read this site: paste the posting's text." };
}

async function readUrlWith(
  net: ReaderNet,
  url: string,
  linkedin: LinkedinJobAccess | undefined,
  depth: number,
): Promise<JobListing | { problem: string }> {
  const problem = postingUrlProblem(url);
  if (problem) return { problem };
  const li = LINKEDIN_JOB.exec(url);
  if (li) {
    const id = li[1] ?? li[2]!;
    if (!linkedin)
      return {
        problem:
          "Orbit reads LinkedIn jobs through your own LinkedIn. Connect it, or paste the posting's text.",
      };
    const got = await linkedinJob(net, linkedin, id);
    if (!got.ok || !got.value.title || !got.value.companyName)
      return { problem: "Orbit couldn't read that LinkedIn job just now. Paste the posting's text." };
    return {
      source: 'linkedin',
      externalId: id,
      companyName: got.value.companyName,
      companyLinkedinId: got.value.companyLinkedinId,
      title: got.value.title,
      locations: got.value.place ? [got.value.place] : [],
      url: `https://www.linkedin.com/jobs/view/${id}`,
      text: got.value.text,
    };
  }
  const board = boardOfUrl(url);
  if (board?.externalId) {
    const name = nameFromToken(board.token || 'company');
    switch (board.service) {
      case 'greenhouse': {
        if (!board.token) break;
        const got = await readGreenhouseJob(net, board.token, board.externalId);
        if (!got.ok) {
          if (got.reason === 'not_found') return { problem: 'That posting is no longer listed.' };
          break;
        }
        return {
          source: 'greenhouse',
          externalId: board.externalId,
          companyName: name,
          title: got.value.title ?? 'Role',
          team: got.value.team,
          locations: got.value.place ? [got.value.place] : [],
          pay: got.value.pay,
          url,
          text: got.value.text,
        };
      }
      case 'lever': {
        const got = await readLeverJob(net, board.token, board.externalId, name);
        if (got.ok) return { ...got.value, url: got.value.url || url };
        if (got.reason === 'not_found') return { problem: 'That posting is no longer listed.' };
        break;
      }
      case 'workday': {
        if (!board.path) break;
        const got = await readWorkdayJob(net, board.token, board.path);
        if (got.ok)
          return {
            source: 'workday',
            externalId: board.externalId,
            companyName: got.value.companyName ?? name,
            title: got.value.title ?? 'Role',
            locations: got.value.places,
            remote: got.value.remote,
            url,
            postedAt: got.value.postedAt,
            text: got.value.text,
            meta: { path: board.path, timeType: got.value.timeType },
          };
        if (got.reason === 'not_found') return { problem: 'That posting is no longer listed.' };
        break;
      }
      case 'smartrecruiters': {
        const id = board.externalId.split('/').pop()!;
        const got = await readSmartRecruitersJob(net, board.token, id);
        if (got.ok && got.value.title)
          return {
            source: 'smartrecruiters',
            externalId: board.externalId,
            companyName: got.value.companyName ?? board.token,
            title: got.value.title,
            locations: got.value.place ? [got.value.place] : [],
            url: got.value.url ?? url,
            postedAt: got.value.postedAt,
            text: got.value.text,
          };
        break;
      }
      case 'workable': {
        const code = board.externalId.split('/').pop()!;
        const got = await readWorkableJob(net, board.token, code);
        if (got.ok && got.value.title)
          return {
            source: 'workable',
            externalId: board.externalId,
            companyName: name,
            title: got.value.title,
            locations: got.value.place ? [got.value.place] : [],
            url,
            text: got.value.text,
          };
        break;
      }
      case 'recruitee': {
        const slug = board.externalId.split('/').pop()!;
        const got = await readRecruiteeJob(net, board.token, slug);
        if (got.ok) return got.value;
        if (got.reason === 'not_found') return { problem: 'That posting is no longer listed.' };
        break;
      }
      case 'ashby':
        break;
    }
  }
  // Ashby's job page and any other page with a JobPosting block
  return pageListing(net, url, depth);
}

/** A posting by its link: a board, Workday, LinkedIn (through the student's account) or any JobPosting page. */
export function readUrl(
  net: RoleNet,
  url: string,
  linkedin?: LinkedinJobAccess,
): Promise<JobListing | { problem: string }> {
  return readUrlWith(net as ReaderNet, url.trim(), linkedin, 0);
}

// ---- a stored role's text ----------------------------------------------------------------------------------------

type TextRow = {
  id: string;
  source: string;
  external_id: string;
  board_id: string | null;
  url: string;
  title: string;
  text: string | null;
  text_read_at: Date | string | null;
  level: string | null;
  term: string | null;
  meta: Obj | null;
  company_name: string;
  token: string | null;
};

interface Read {
  text: string;
  places?: string[];
  team?: string;
  pay?: JobPay;
  remote?: Remote;
}

async function readText(
  net: ReaderNet,
  j: TextRow,
  linkedin: LinkedinJobAccess | undefined,
): Promise<Got<Read> | { ok: false; reason: 'unreadable' }> {
  const fromUrl = boardOfUrl(j.url);
  const token = j.token ?? fromUrl?.token;
  const tail = j.external_id.split('/').pop()!;
  switch (j.source) {
    case 'greenhouse': {
      if (!token) break;
      const got = await readGreenhouseJob(net, token, j.external_id);
      return got.ok
        ? { ...got, value: { text: got.value.text, team: got.value.team, pay: got.value.pay } }
        : got;
    }
    case 'lever': {
      if (!token) break;
      const got = await readLeverJob(net, token, j.external_id, j.company_name);
      return got.ok
        ? { ...got, value: { text: got.value.text ?? '', team: got.value.team, pay: got.value.pay } }
        : got;
    }
    case 'workday': {
      const path = typeof j.meta?.path === 'string' ? j.meta.path : fromUrl?.path;
      if (!token || !path) break;
      const got = await readWorkdayJob(net, token, path);
      return got.ok
        ? { ...got, value: { text: got.value.text, places: got.value.places, remote: got.value.remote } }
        : got;
    }
    case 'smartrecruiters': {
      if (!token) break;
      const got = await readSmartRecruitersJob(net, token, tail);
      return got.ok ? { ...got, value: { text: got.value.text } } : got;
    }
    case 'workable': {
      if (!token) break;
      const got = await readWorkableJob(net, token, tail);
      return got.ok ? { ...got, value: { text: got.value.text } } : got;
    }
    case 'recruitee': {
      if (!token) break;
      const got = await readRecruiteeJob(net, token, tail);
      return got.ok ? { ...got, value: { text: got.value.text ?? '', pay: got.value.pay } } : got;
    }
    case 'linkedin': {
      if (!linkedin) return { ok: false, reason: 'unreadable' };
      const got = await linkedinJob(net, linkedin, j.external_id);
      if (!got.ok) return got;
      if (got.value.state && got.value.state !== 'active')
        return { ok: false, reason: 'not_found', message: 'closed' };
      return { ok: true, value: { text: got.value.text }, bytes: got.bytes };
    }
    default:
      break;
  }
  // Ashby, SimplifyJobs and pasted postings: the posting's own page
  const l = await readUrlWith(net, j.url, linkedin, 0);
  if ('problem' in l)
    return {
      ok: false,
      reason: /no longer listed/.test(l.problem) ? 'not_found' : 'unreadable',
      message: l.problem,
    } as Got<Read>;
  return {
    ok: true,
    value: { text: l.text ?? '', places: l.locations.length ? l.locations : undefined, pay: l.pay },
    bytes: 0,
  };
}

/** The posting's text for a stored role, read from its source when not kept yet or older than 7 days. */
export async function text(
  db: Db,
  net: RoleNet,
  jobId: string,
  linkedin?: LinkedinJobAccess,
): Promise<string | undefined> {
  const now = net.now();
  const [j] = await db.sql<TextRow>`
    select j.id, j.source, j.external_id, j.board_id, j.url, j.title, j.text, j.text_read_at, j.level, j.term, j.meta,
           j.company_name, b.token
      from orbit_private.jobs j left join orbit_private.job_boards b on b.id = j.board_id
     where j.id = ${jobId}::uuid`;
  if (!j) return undefined;
  if (j.text && j.text_read_at && now.getTime() - new Date(j.text_read_at).getTime() < TEXT_FRESH_MS)
    return j.text;
  const got = await readText(net as ReaderNet, j, linkedin).catch(() => ({
    ok: false as const,
    reason: 'unreadable' as const,
  }));
  if (!got.ok) {
    // the source says the role is gone: it leaves the open roles (saved matches keep it as "No longer listed")
    if (got.reason === 'not_found')
      await db.sql`update orbit_private.jobs set closed_at = coalesce(closed_at, ${now}::timestamptz) where id = ${j.id}::uuid`;
    return j.text ?? undefined;
  }
  const cleaned = cleanText(got.value.text);
  if (!cleaned) return j.text ?? undefined;
  const hash = await sha256(cleaned);
  const places = got.value.places?.length ? splitPlaces(got.value.places) : undefined;
  await db.sql`
    update orbit_private.jobs
       set text = ${cleaned}, text_hash = ${hash}, text_read_at = ${now}::timestamptz,
           level = coalesce(level, ${j.level ? null : (roleLevel(j.title, cleaned) ?? null)}),
           term = coalesce(term, ${j.term ? null : (termOf(j.title, cleaned) ?? null)}),
           team = coalesce(team, ${got.value.team ?? null}),
           pay = coalesce(pay, ${got.value.pay ?? payFromText(cleaned) ?? null}::jsonb),
           remote = coalesce(remote, ${got.value.remote ?? null}),
           places = coalesce(${places ?? null}::text[], places),
           countries = coalesce(${places ? countriesOf(places) : null}::text[], countries)
     where id = ${j.id}::uuid`;
  await count(db, now, 'texts_read');
  return cleaned;
}

/** One LinkedIn job search through the student's own account; nothing on a failure. */
export async function linkedinSearch(
  net: RoleNet,
  access: LinkedinJobAccess,
  q: Parameters<RoleSources['linkedinSearch']>[2],
): Promise<JobListing[]> {
  const got = await linkedinJobSearch(net as ReaderNet, access, q);
  return got.ok ? got.value : [];
}

export const roleSources: RoleSources = { keep, text, linkedinSearch, readUrl };
