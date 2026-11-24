/**
 * Plan 44 §4.5 and §4.7: one listing from any source read into the shared `orbit_private.jobs` row, with no model.
 * Level (roleLevel), family (the title, then the team or category), places split out of multi-city strings,
 * countries, remote, the student term, pay when the source or the text says it plainly, language, and the text
 * cleaned and capped at 8,000 characters with its sha256.
 *
 * One role, listed once:
 * - the same title, team and text on one board (one entry per city) is one role: the first is shown, the others
 *   point at it (`dupe_of`) and their places are merged into it;
 * - a repost (the same title and text under a new id) keeps the first-seen and posted dates of the one it replaces;
 * - a SimplifyJobs or LinkedIn listing that is a board's role (its link names it, or the same company and title with
 *   a place in common) points at the board's role, which has the full text and is the one shown.
 *
 * English postings only in this build: a listing in another language is not stored.
 */

import { employmentOf, roleLevel, termOf } from '@orbit/core/roles/level';
import { buildPlaceIndex, foldPlace, type PlaceIndex } from '@orbit/core/search/places';
import { PLACES_DATA } from '@orbit/core/search/places.data';
import { readTitle, type TitleFamily } from '@orbit/core/search/titles';
import { normalizeCompany } from '@orbit/core/text/normalize';
import type {
  BoardService,
  Job,
  JobLevel,
  JobListing,
  JobPay,
  JobSource,
  Remote,
} from '../../../../packages/core/src/roles/types.ts';
import type { Db } from '../db.ts';
import { pageText } from '../postings.ts';

export const TEXT_CAP = 8000;
export const BOARD_SOURCES: readonly BoardService[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'workable',
  'recruitee',
];
const isBoardSource = (s: JobSource) => (BOARD_SOURCES as readonly string[]).includes(s);

let index: PlaceIndex | undefined;
const places = () => (index ??= buildPlaceIndex(PLACES_DATA));

// ---- words ---------------------------------------------------------------------------------------------------------

/** A title for matching and dedupe: lower case, accents and punctuation gone, "&" as "and". */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The company's key, the one every other part of Orbit uses. */
export function companyKey(name: string): string {
  return normalizeCompany(name) || name.trim().toLowerCase();
}

const FAMILY_ORDER: TitleFamily[] = [
  'data_ml',
  'research',
  'product',
  'design',
  'engineering',
  'investing',
  'banking',
  'consulting',
  'finance',
  'sales',
  'marketing',
  'growth',
  'operations',
  'legal',
  'people_recruiting',
  'customer',
  'healthcare',
  'life_sciences',
  'education_academia',
  'policy_government',
  'media',
  'creator',
  'real_estate',
  'military',
  'executive',
];

/** A department or category's family, when its name says it ("Engineering", "AI/ML/Data", "People"). */
const DEPARTMENT: [RegExp, TitleFamily][] = [
  [/\b(data|analytics|machine learning|ml|ai|quant)\b/i, 'data_ml'],
  [/\bresearch\b/i, 'research'],
  [/\bproduct\b(?! (marketing|sales))/i, 'product'],
  [/\bdesign\b/i, 'design'],
  [/\b(engineering|software|infrastructure|platform|hardware|security|it|technology|r&d)\b/i, 'engineering'],
  [/\b(sales|business development|revenue|go to market|gtm|partnerships)\b/i, 'sales'],
  [/\bmarketing\b/i, 'marketing'],
  [/\b(finance|accounting|treasury|tax)\b/i, 'finance'],
  [/\blegal\b/i, 'legal'],
  [/\b(people|talent|recruiting|hr|human resources)\b/i, 'people_recruiting'],
  [/\b(support|success|customer|services)\b/i, 'customer'],
  [/\b(operations|ops|strategy)\b/i, 'operations'],
];

function firstFamily(fams: readonly TitleFamily[]): TitleFamily | undefined {
  return FAMILY_ORDER.find((f) => fams.includes(f));
}

/** The family: the title's own words first, then the team or department, then the source's category. */
export function familyOf(title: string, team?: string, category?: string): TitleFamily | undefined {
  const fromTitle = firstFamily(readTitle(title).families);
  if (fromTitle) return fromTitle;
  for (const side of [team, category]) {
    if (!side) continue;
    const read = firstFamily(readTitle(side).families);
    if (read) return read;
    const dept = DEPARTMENT.find(([re]) => re.test(side));
    if (dept) return dept[1];
  }
  return undefined;
}

// ---- places --------------------------------------------------------------------------------------------------------

/** A part after a comma that names a region or a country ("CA", "California", "United States"), not another city. */
function regionish(part: string): boolean {
  const p = part.trim();
  if (/^[A-Z]{2}$/.test(p)) return p in PLACES_DATA.usAbbr || p in PLACES_DATA.countries || p === 'UK';
  if (/^(USA|UAE)$/.test(p)) return true;
  if (/^[A-Z]{3,}$/.test(p)) return false;
  if (/^(remote|hybrid|on-?site|hq|headquarters)$/i.test(p)) return true;
  const t = places().target(p);
  if (!t || t.metro) return false;
  const f = foldPlace(p);
  if (t.country && !t.region) return true;
  return t.region === f;
}

function isCountry(part: string): boolean {
  const t = places().target(part);
  return !!t?.country && !t.region && !t.metro;
}

function cleanPlace(p: string): string {
  if (/^\s*(n\/?a|tbd|tba|various|multiple locations|none)\s*$/i.test(p)) return '';
  return p
    .replace(/\((?:hq|headquarters|on-?site|onsite|in[- ]office|office)\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')
    .trim();
}

/**
 * Places split out of the strings a source writes: "San Francisco, CA; New York, NY", "Seattle, San Francisco, New
 * York City" (Greenhouse's way), "San Francisco, CA, New York, NY", "Remote - US". A place with its region stays one.
 */
export function splitPlaces(locations: string[]): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const c = cleanPlace(p);
    if (c && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  for (const raw of locations) {
    for (const piece of raw.split(/\s*(?:;|\||•|·|\n|\s\/\s|\s+or\s+)\s*/)) {
      const parts = cleanPlace(piece)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length <= 1) {
        if (parts[0]) add(parts[0]);
        continue;
      }
      // "City, ST, City, ST": pairs; "City, Region, Country": one place; "City, City, City": each its own
      const tail = parts.slice(1);
      // "Israel, Tel Aviv" (Workday's way): the country first, then the city
      if (tail.every(regionish) || (parts.length === 2 && isCountry(parts[0]!))) {
        add(parts.join(', '));
        continue;
      }
      let cur: string[] = [];
      for (const part of parts) {
        if (cur.length && regionish(part)) cur.push(part);
        else {
          if (cur.length) add(cur.join(', '));
          cur = [part];
        }
      }
      if (cur.length) add(cur.join(', '));
    }
  }
  return out;
}

/** Country codes of the places (and of the source's own country field). */
export function countriesOf(placeList: string[], extra?: unknown): string[] {
  const out = new Set<string>();
  for (const p of placeList) {
    const clean =
      p
        .replace(/\bremote\b[\s:-]*/i, '')
        .replace(/[()]/g, ' ')
        .trim() || p;
    const r = places().read(clean) ?? places().read(clean.split(',').reverse().join(','));
    if (r?.country) out.add(r.country);
  }
  if (typeof extra === 'string') {
    const cc = extra.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) out.add(cc === 'UK' ? 'GB' : cc);
    else {
      const t = places().target(extra);
      if (t?.country && !t.region && !t.metro) out.add(t.country);
    }
  }
  return [...out];
}

/** How the role is worked: the source's word, else "hybrid" or "remote" in the places or title. */
export function remoteOf(given: Remote | undefined, placeList: string[], title: string): Remote | undefined {
  if (given) return given;
  const all = `${placeList.join(' | ')} | ${title}`;
  if (/\bhybrid\b/i.test(all)) return 'hybrid';
  if (/\bremote\b/i.test(all)) return 'remote';
  return undefined;
}

/** A key per place for "a place in common": the city, folded ("San Francisco, CA" and "San Francisco" agree). */
export function placeKeys(placeList: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of placeList) {
    const f = foldPlace(p.split(',')[0] ?? '');
    if (!f) continue;
    out.add(
      /\bremote\b/.test(f) ? 'remote' : f.replace(/^greater /, '').replace(/ (metropolitan )?area$/, ''),
    );
  }
  return out;
}

const shareAPlace = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return true;
  const kb = placeKeys(b);
  for (const k of placeKeys(a)) if (kb.has(k)) return true;
  return false;
};

// ---- pay, language, text -------------------------------------------------------------------------------------------

/** A pay range written plainly in the text ("$120,000 - $150,000", "$45 to $55 per hour", "$120K–$160K"). */
export function payFromText(text: string | undefined): JobPay | undefined {
  if (!text) return undefined;
  const re =
    /(\$|USD\s?|US\$)\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?\s*(?:USD)?\s*(?:-|–|—|to)\s*(?:\$|USD\s?|US\$)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?(?:\s*USD)?(?:\s*(?:\/|per|an|a)\s*(hour|hr|year|yr|annum|month))?/;
  const m = re.exec(text);
  if (!m) return undefined;
  const n = (s: string, k?: string) => Number(s.replace(/,/g, '')) * (k ? 1000 : 1);
  const min = n(m[2]!, m[3]);
  const max = n(m[4]!, m[5] ?? m[3]);
  if (!(min > 0) || !(max >= min)) return undefined;
  const unit = (m[6] ?? '').toLowerCase();
  const per: JobPay['per'] = /^h/.test(unit)
    ? 'hour'
    : /^m/.test(unit)
      ? 'month'
      : unit
        ? 'year'
        : min < 500
          ? 'hour'
          : 'year';
  if (per === 'year' && (min < 15_000 || max > 3_000_000)) return undefined;
  if (per === 'hour' && (min < 7 || max > 1000)) return undefined;
  return { min, max, currency: 'USD', per };
}

const EN = new Set(
  'the and to of a in you for with our we will is are on as your be this or an at by from that have team work experience'.split(
    ' ',
  ),
);
const OTHER = new Set(
  'de la el und der die das le les et des para con für mit wir sie nous vous une il los las della di che per zu ist ein eine du het van een och att är sind pour dans sur una del al em um uma não você auf bei zur zum oder'.split(
    ' ',
  ),
);
const NOT_ENGLISH_TITLE =
  /\b(ingeniero|ingeniera|desarrollador|desarrolladora|entwickler|entwicklerin|praktikant|praktikantin|werkstudent|werkstudentin|stagiaire|ingénieur|ingenieur|développeur|developpeur|analista|becario|becaria|estagiário|estagiario|pasante|mitarbeiter|mitarbeiterin|vertrieb|kaufmann|kauffrau|sachbearbeiter|leiter|leiterin|técnico|tecnico|gerente|responsable|chargé|chargée|consultor|consultora|vendedor|desenvolvedor|ausbildung|duales studium|alternance|stage)\b/i;

/** "en" when the words read as English, "other" when they plainly do not, undefined when too few to tell. */
export function languageOf(title: string, text?: string): 'en' | 'other' | undefined {
  if (text) {
    const words =
      text
        .toLowerCase()
        .match(/[a-zà-ÿäöüß]+/g)
        ?.slice(0, 400) ?? [];
    if (words.length >= 40) {
      let en = 0;
      let other = 0;
      for (const w of words) {
        if (EN.has(w)) en++;
        else if (OTHER.has(w)) other++;
      }
      if (en / words.length >= 0.06 && en >= other) return 'en';
      if (other > en) return 'other';
    }
  }
  if (NOT_ENGLISH_TITLE.test(title)) return 'other';
  return text ? 'en' : undefined;
}

/** The text cleaned of markup, blank runs folded, and capped at TEXT_CAP on a word. */
export function cleanText(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const plain = /<\/?[a-z][^>]*>/i.test(raw) ? pageText(raw) : raw;
  const t = plain
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!t) return undefined;
  if (t.length <= TEXT_CAP) return t;
  const cut = t.slice(0, TEXT_CAP);
  const at = cut.lastIndexOf(' ');
  return at > TEXT_CAP - 200 ? cut.slice(0, at) : cut;
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- one listing ---------------------------------------------------------------------------------------------------

/** A listing as the jobs row stores it. */
export interface JobRow {
  source: JobSource;
  external_id: string;
  board_id: string | null;
  company_key: string;
  company_name: string;
  company_domain: string | null;
  company_linkedin_id: string | null;
  company_logo_url: string | null;
  title: string;
  title_key: string;
  team: string | null;
  family: TitleFamily | null;
  level: JobLevel | null;
  employment: string | null;
  places: string[];
  countries: string[];
  remote: Remote | null;
  term: string | null;
  pay: JobPay | null;
  sponsorship: 'offers' | 'none' | null;
  degrees: string[];
  language: string | null;
  url: string;
  apply_url: string | null;
  posted_at: string | null;
  first_seen_at: string;
  text: string | null;
  text_hash: string | null;
  dupe_of: string | null;
  meta: Record<string, unknown>;
}

const metaStr = (m: Record<string, unknown> | undefined, k: string) =>
  typeof m?.[k] === 'string' ? (m[k] as string) : undefined;

/** One listing read into its row. Undefined: not stored (not in English, or no title or link). */
export async function intake(l: JobListing, o: { now: Date; boardId?: string }): Promise<JobRow | undefined> {
  const title = l.title?.trim().replace(/\s+/g, ' ');
  if (!title || !l.url || !l.externalId || !l.companyName?.trim()) return undefined;
  const text = cleanText(l.text);
  const lang = (l.language ?? '').toLowerCase().slice(0, 2);
  if (lang && lang !== 'en') return undefined;
  if (!lang && languageOf(title, text) === 'other') return undefined;
  const placeList = splitPlaces(l.locations ?? []);
  const meta = l.meta ?? {};
  const list = metaStr(meta, 'list');
  const level =
    roleLevel(title) ??
    l.level ??
    (text ? roleLevel(title, text) : undefined) ??
    (list === 'newgrad' ? 'entry' : undefined);
  const employment =
    employmentOf(
      title,
      text,
      l.employment ??
        metaStr(meta, 'commitment') ??
        metaStr(meta, 'employmentType') ??
        metaStr(meta, 'employment') ??
        metaStr(meta, 'type') ??
        metaStr(meta, 'timeType'),
    ) ?? (level === 'intern' ? 'internship' : undefined);
  return {
    source: l.source,
    external_id: l.externalId,
    board_id: o.boardId ?? null,
    company_key: companyKey(l.companyName),
    company_name: l.companyName.trim(),
    company_domain: l.companyDomain ?? null,
    company_linkedin_id: l.companyLinkedinId ?? null,
    company_logo_url: l.companyLogoUrl ?? null,
    title,
    title_key: titleKey(title),
    team: l.team?.trim() || null,
    family: familyOf(title, l.team ?? metaStr(meta, 'department'), metaStr(meta, 'category')) ?? null,
    level: level ?? null,
    employment: employment ?? null,
    places: placeList,
    countries: countriesOf(placeList, meta.country),
    remote: remoteOf(l.remote, placeList, title) ?? null,
    term: l.term ?? (level === 'intern' ? termOf(title, text) : termOf(title)) ?? null,
    pay: l.pay ?? payFromText(text) ?? null,
    sponsorship: l.sponsorship ?? null,
    degrees: l.degrees ?? [],
    language: lang || (text ? 'en' : null),
    url: l.url,
    apply_url: l.applyUrl ?? null,
    posted_at: l.postedAt ?? null,
    first_seen_at: o.now.toISOString(),
    text: text ?? null,
    text_hash: text ? await sha256(text) : null,
    dupe_of: null,
    meta,
  };
}

// ---- keeping -------------------------------------------------------------------------------------------------------

type StoredRow = {
  id: string;
  source: JobSource;
  external_id: string;
  board_id: string | null;
  company_key: string;
  company_name: string;
  company_domain: string | null;
  company_logo_url: string | null;
  title: string;
  title_key: string;
  team: string | null;
  family: string | null;
  level: JobLevel | null;
  employment: Job['employment'] | null;
  places: string[];
  countries: string[];
  remote: Remote | null;
  term: string | null;
  pay: JobPay | null;
  sponsorship: 'offers' | 'none' | null;
  degrees: string[];
  url: string;
  apply_url: string | null;
  posted_at: Date | string | null;
  first_seen_at: Date | string;
  closed_at: Date | string | null;
  text_hash: string | null;
  dupe_of: string | null;
  inserted?: boolean;
};

const iso = (v: Date | string | null | undefined) => (v == null ? undefined : new Date(v).toISOString());

/** A stored row as the shared `Job` shape. */
export function jobOf(r: StoredRow): Job {
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    companyKey: r.company_key,
    companyName: r.company_name,
    companyDomain: r.company_domain ?? undefined,
    companyLogoUrl: r.company_logo_url ?? undefined,
    title: r.title,
    team: r.team ?? undefined,
    family: (r.family ?? undefined) as TitleFamily | undefined,
    level: r.level ?? undefined,
    employment: r.employment ?? undefined,
    places: r.places ?? [],
    countries: r.countries ?? [],
    remote: r.remote ?? undefined,
    term: r.term ?? undefined,
    pay: r.pay ?? undefined,
    sponsorship: r.sponsorship ?? undefined,
    degrees: r.degrees ?? [],
    url: r.url,
    applyUrl: r.apply_url ?? undefined,
    postedAt: iso(r.posted_at),
    firstSeenAt: iso(r.first_seen_at)!,
    closedAt: iso(r.closed_at),
  };
}

export const JOB_COLUMNS = `id, source, external_id, board_id, company_key, company_name, company_domain, company_logo_url,
  title, title_key, team, family, level, employment, places, countries, remote, term, pay, sponsorship, degrees, url,
  apply_url, posted_at, first_seen_at, closed_at, text_hash, dupe_of`;

const CHUNK = 250;

/** Upsert rows; a row seen again is opened, its last-seen time moved on, its first-seen time kept. */
async function upsert(db: Db, rows: JobRow[], now: Date): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const got = await db.query<StoredRow>(
      `insert into orbit_private.jobs as j (source, external_id, board_id, company_key, company_name, company_domain,
         company_linkedin_id, company_logo_url, title, title_key, team, family, level, employment, places, countries,
         remote, term, pay, sponsorship, degrees, language, url, apply_url, posted_at, first_seen_at, last_seen_at,
         text, text_hash, text_read_at, dupe_of, meta)
       select r.source, r.external_id, r.board_id, r.company_key, r.company_name, r.company_domain,
              r.company_linkedin_id, r.company_logo_url, r.title, r.title_key, r.team, r.family, r.level, r.employment,
              coalesce(r.places, '{}'), coalesce(r.countries, '{}'), r.remote, r.term, r.pay, r.sponsorship,
              coalesce(r.degrees, '{}'), r.language, r.url, r.apply_url, r.posted_at, r.first_seen_at, $2::timestamptz,
              r.text, r.text_hash, case when r.text is not null then $2::timestamptz end, r.dupe_of,
              coalesce(r.meta, '{}'::jsonb)
         from jsonb_to_recordset($1::jsonb) as r(source text, external_id text, board_id uuid, company_key text,
              company_name text, company_domain text, company_linkedin_id text, company_logo_url text, title text,
              title_key text, team text, family text, level text, employment text, places text[], countries text[],
              remote text, term text, pay jsonb, sponsorship text, degrees text[], language text, url text,
              apply_url text, posted_at timestamptz, first_seen_at timestamptz, text text, text_hash text,
              dupe_of uuid, meta jsonb)
       on conflict (source, external_id) do update set
         board_id = coalesce(excluded.board_id, j.board_id),
         company_key = excluded.company_key,
         company_name = excluded.company_name,
         company_domain = coalesce(excluded.company_domain, j.company_domain),
         company_linkedin_id = coalesce(excluded.company_linkedin_id, j.company_linkedin_id),
         company_logo_url = coalesce(excluded.company_logo_url, j.company_logo_url),
         title = excluded.title,
         title_key = excluded.title_key,
         team = coalesce(excluded.team, j.team),
         family = coalesce(excluded.family, j.family),
         level = coalesce(excluded.level, j.level),
         employment = coalesce(excluded.employment, j.employment),
         -- a Workday role listed as "3 Locations" keeps the places its detail named
         places = case when excluded.meta ? 'locationsText' and cardinality(j.places) > cardinality(excluded.places)
                       then j.places else excluded.places end,
         countries = case when excluded.meta ? 'locationsText' and cardinality(j.countries) > cardinality(excluded.countries)
                          then j.countries else excluded.countries end,
         remote = coalesce(excluded.remote, j.remote),
         term = coalesce(excluded.term, j.term),
         pay = coalesce(excluded.pay, j.pay),
         sponsorship = coalesce(excluded.sponsorship, j.sponsorship),
         degrees = case when cardinality(excluded.degrees) > 0 then excluded.degrees else j.degrees end,
         language = coalesce(excluded.language, j.language),
         url = excluded.url,
         apply_url = coalesce(excluded.apply_url, j.apply_url),
         posted_at = coalesce(least(j.posted_at, excluded.posted_at), j.posted_at, excluded.posted_at),
         first_seen_at = least(j.first_seen_at, excluded.first_seen_at),
         last_seen_at = excluded.last_seen_at,
         closed_at = null,
         text = coalesce(excluded.text, j.text),
         text_hash = coalesce(excluded.text_hash, j.text_hash),
         -- a role Greenhouse says was updated is read again when next needed
         text_read_at = case when excluded.text is not null then excluded.text_read_at
                             when excluded.meta->>'updatedAt' is distinct from j.meta->>'updatedAt' then null
                             else j.text_read_at end,
         dupe_of = excluded.dupe_of,
         meta = j.meta || excluded.meta
       returning ${JOB_COLUMNS}, (xmax = 0) as inserted`,
      [JSON.stringify(part), now],
    );
    out.push(...got);
  }
  return out;
}

export interface KeepResult {
  /** the role shown for each listing, in order, each once */
  jobs: Job[];
  added: number;
  updated: number;
  /** listings left out (another language, no title) */
  skipped: number;
}

/**
 * Store listings: read each, find the role it repeats, upsert, and merge the places of repeats into the role shown.
 * Returns the role shown for each listing (a repeat's is the role it points at), in order, each once.
 */
export async function keepListings(
  db: Db,
  listings: JobListing[],
  o: { boardId?: string; now?: Date } = {},
): Promise<KeepResult> {
  const now = o.now ?? new Date();
  const rows: JobRow[] = [];
  const forListing: (JobRow | undefined)[] = [];
  for (const l of listings) {
    const r = await intake(l, { now, boardId: o.boardId });
    forListing.push(r);
    if (r && !rows.some((x) => x.source === r.source && x.external_id === r.external_id)) rows.push(r);
  }
  const skipped = forListing.filter((r) => !r).length;
  if (!rows.length) return { jobs: [], added: 0, updated: 0, skipped };

  const boardRows = rows.filter((r) => isBoardSource(r.source));
  const otherRows = rows.filter((r) => !isBoardSource(r.source));
  const stored: StoredRow[] = [];

  // 1. a board's repeats: one role per title, team and text
  if (boardRows.length) {
    const keyOf = (r: { title_key: string; team: string | null; text_hash: string | null }) =>
      `${r.title_key}|${(r.team ?? '').toLowerCase()}|${r.text_hash ?? ''}`;
    const sources = [...new Set(boardRows.map((r) => r.source))];
    const existing = await db.sql<StoredRow & { meta: Record<string, unknown> }>`
      select id, source, external_id, board_id, title_key, team, text_hash, first_seen_at, posted_at, closed_at, dupe_of
        from orbit_private.jobs
       where (source = any(${sources}::text[]) and external_id = any(${boardRows.map((r) => r.external_id)}::text[]))
          or (${o.boardId ?? null}::uuid is not null and board_id = ${o.boardId ?? null}::uuid
              and title_key = any(${[...new Set(boardRows.map((r) => r.title_key))]}::text[]))`;
    const byExt = new Map(existing.map((e) => [`${e.source}:${e.external_id}`, e]));
    const groups = new Map<string, JobRow[]>();
    for (const r of boardRows) {
      const k = `${r.board_id ?? r.source}|${keyOf(r)}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const primaries: JobRow[] = [];
    const repeats: [JobRow, JobRow][] = [];
    for (const g of groups.values()) {
      // the role already shown stays shown; else the one seen first
      const shown =
        g.find((r) => {
          const e = byExt.get(`${r.source}:${r.external_id}`);
          return e && !e.dupe_of;
        }) ??
        [...g].sort((a, b) => {
          const ea = byExt.get(`${a.source}:${a.external_id}`);
          const eb = byExt.get(`${b.source}:${b.external_id}`);
          return (iso(ea?.first_seen_at) ?? '9').localeCompare(iso(eb?.first_seen_at) ?? '9');
        })[0]!;
      // a repost: the same role under another id on this board, not in this read; the dates carry over
      const ids = new Set(g.map((r) => r.external_id));
      const before = existing.filter(
        (e) =>
          e.board_id === o.boardId &&
          !ids.has(e.external_id) &&
          keyOf({ title_key: e.title_key, team: e.team, text_hash: e.text_hash }) === keyOf(shown),
      );
      for (const e of before) {
        const first = iso(e.first_seen_at)!;
        if (first < shown.first_seen_at) shown.first_seen_at = first;
        const posted = iso(e.posted_at);
        if (posted && (!shown.posted_at || posted < shown.posted_at)) shown.posted_at = posted;
      }
      for (const r of g) {
        const e = byExt.get(`${r.source}:${r.external_id}`);
        if (e && iso(e.first_seen_at)! < r.first_seen_at) r.first_seen_at = iso(e.first_seen_at)!;
      }
      primaries.push(shown);
      for (const r of g) if (r !== shown) repeats.push([r, shown]);
    }
    const first = await upsert(db, primaries, now);
    stored.push(...first);
    const idOf = new Map(first.map((s) => [`${s.source}:${s.external_id}`, s.id]));
    for (const [r, shown] of repeats) r.dupe_of = idOf.get(`${shown.source}:${shown.external_id}`) ?? null;
    if (repeats.length)
      stored.push(
        ...(await upsert(
          db,
          repeats.map(([r]) => r),
          now,
        )),
      );
    // the places of a role's repeats are the role's places
    const shownIds = [
      ...new Set(repeats.map(([, s]) => idOf.get(`${s.source}:${s.external_id}`)).filter(Boolean)),
    ] as string[];
    if (shownIds.length) {
      const merged = await db.sql<{ id: string; places: string[]; countries: string[] }>`
        update orbit_private.jobs p
           set places = array(
                 select x from (
                   select x, min((case when d.id = p.id then 0 else 1 end) * 100000 + o) as k
                     from orbit_private.jobs d, unnest(d.places) with ordinality u(x, o)
                    where (d.id = p.id or d.dupe_of = p.id) and d.closed_at is null
                    group by x) t order by k),
               countries = array(
                 select distinct x from orbit_private.jobs d, unnest(d.countries) x
                  where (d.id = p.id or d.dupe_of = p.id) and d.closed_at is null)
         where p.id = any(${shownIds}::uuid[])
        returning p.id, p.places, p.countries`;
      for (const m of merged) {
        const s = stored.find((x) => x.id === m.id);
        if (s) {
          s.places = (m.places ?? []).filter(Boolean);
          s.countries = m.countries ?? [];
        }
      }
    }
    // SimplifyJobs and LinkedIn rows that are these roles now point at them
    await linkRepeatsFromLists(db, first);
  }

  // 2. SimplifyJobs, LinkedIn and pasted postings: the board's role when they are one
  if (otherRows.length) {
    const target = await boardRolesFor(db, otherRows);
    for (const r of otherRows) r.dupe_of = target.get(`${r.source}:${r.external_id}`) ?? null;
    stored.push(...(await upsert(db, otherRows, now)));
  }

  // the role shown for each listing
  const byKey = new Map(stored.map((s) => [`${s.source}:${s.external_id}`, s]));
  const shownIds = new Set<string>();
  const order: string[] = [];
  for (const r of forListing) {
    if (!r) continue;
    const s = byKey.get(`${r.source}:${r.external_id}`);
    if (!s) continue;
    const id = s.dupe_of ?? s.id;
    if (!shownIds.has(id)) {
      shownIds.add(id);
      order.push(id);
    }
  }
  const missing = order.filter((id) => !stored.some((s) => s.id === id));
  if (missing.length)
    stored.push(
      ...(await db.query<StoredRow>(
        `select ${JOB_COLUMNS} from orbit_private.jobs where id = any($1::uuid[])`,
        [missing],
      )),
    );
  const byId = new Map(stored.map((s) => [s.id, s]));
  return {
    jobs: order.map((id) => jobOf(byId.get(id)!)),
    added: stored.filter((s) => s.inserted).length,
    updated: stored.filter((s) => s.inserted === false).length,
    skipped,
  };
}

/** For list and LinkedIn rows: the open board role each one is (by the link it names, else company, title and place). */
async function boardRolesFor(db: Db, rows: JobRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const refs = rows.map((r) => metaStr(r.meta, 'boardRef')).filter((x): x is string => !!x);
  if (refs.length) {
    const hits = await db.sql<{ ref: string; shown: string }>`
      select source || ':' || external_id as ref, coalesce(dupe_of, id) as shown from orbit_private.jobs
       where source || ':' || external_id = any(${refs}::text[]) and source = any(${[...BOARD_SOURCES]}::text[])
         and closed_at is null`;
    const byRef = new Map(hits.map((h) => [h.ref, h.shown]));
    for (const r of rows) {
      const ref = metaStr(r.meta, 'boardRef');
      const hit = ref ? byRef.get(ref) : undefined;
      if (hit) out.set(`${r.source}:${r.external_id}`, hit);
    }
  }
  const rest = rows.filter((r) => !out.has(`${r.source}:${r.external_id}`));
  if (rest.length) {
    const cands = await db.sql<{ shown: string; company_key: string; title_key: string; places: string[] }>`
      select coalesce(dupe_of, id) as shown, company_key, title_key, places from orbit_private.jobs
       where source = any(${[...BOARD_SOURCES]}::text[]) and closed_at is null
         and company_key = any(${[...new Set(rest.map((r) => r.company_key))]}::text[])
         and title_key = any(${[...new Set(rest.map((r) => r.title_key))]}::text[])`;
    for (const r of rest) {
      const hit = cands.find(
        (c) =>
          c.company_key === r.company_key &&
          c.title_key === r.title_key &&
          shareAPlace(c.places ?? [], r.places),
      );
      if (hit) out.set(`${r.source}:${r.external_id}`, hit.shown);
    }
  }
  return out;
}

/** After a board read: list and LinkedIn rows that are these roles point at them. */
async function linkRepeatsFromLists(db: Db, boardRows: StoredRow[]): Promise<void> {
  if (!boardRows.length) return;
  const refs = boardRows.map((b) => `${b.source}:${b.external_id}`);
  await db.sql`
    update orbit_private.jobs s set dupe_of = coalesce(b.dupe_of, b.id)
      from orbit_private.jobs b
     where s.source in ('simplify', 'linkedin', 'posting') and s.dupe_of is null
       and s.meta->>'boardRef' = any(${refs}::text[])
       and b.source || ':' || b.external_id = s.meta->>'boardRef'`;
  const lists = await db.sql<{ id: string; company_key: string; title_key: string; places: string[] }>`
    select id, company_key, title_key, places from orbit_private.jobs
     where source in ('simplify', 'linkedin') and dupe_of is null and closed_at is null
       and company_key = any(${[...new Set(boardRows.map((b) => b.company_key))]}::text[])
       and title_key = any(${[...new Set(boardRows.map((b) => b.title_key))]}::text[])`;
  const pairs: { id: string; to: string }[] = [];
  for (const s of lists) {
    const b = boardRows.find(
      (x) =>
        x.company_key === s.company_key &&
        x.title_key === s.title_key &&
        shareAPlace(x.places ?? [], s.places ?? []),
    );
    if (b) pairs.push({ id: s.id, to: b.dupe_of ?? b.id });
  }
  if (pairs.length)
    await db.sql`
      update orbit_private.jobs s set dupe_of = p.to_id
        from jsonb_to_recordset(${JSON.stringify(pairs.map((p) => ({ id: p.id, to_id: p.to })))}::jsonb) as p(id uuid, to_id uuid)
       where s.id = p.id`;
}

/** The RoleSources `keep`: store listings and return the roles shown for them. */
export async function keep(
  db: Db,
  listings: JobListing[],
  o?: { boardId?: string; now?: Date },
): Promise<Job[]> {
  return (await keepListings(db, listings, o)).jobs;
}

// own keys only
export const _internal = { regionish, shareAPlace };
