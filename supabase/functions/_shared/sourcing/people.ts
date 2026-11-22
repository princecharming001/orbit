/**
 * A people search (Find people): what the search's own filters ask, as queries for each provider and as statements
 * each person found is checked against; and a person's profile as the web search returns it, read into the fields a
 * row shows (headline, current title and company, where they worked and studied, where they live).
 *
 * The web search answers a people query with a structured profile for each person (work history, education, place,
 * photo) beside the text it matched. Orbit used to keep only a snippet of that text, so a row had no title, no
 * company, and nothing a filter or a warm path could be checked against.
 *
 * Everything here is pure.
 */
import type { ExaResult } from '../providers/exa';
import { norm } from '../research/guards';

// ---- the filters of a search --------------------------------------------------------------------------------------

export type Need = 'must' | 'nice';

/** The filters of one people search, as the student set them. */
export interface PeopleFilters {
  titles?: string[];
  seniority?: string[];
  /** where they work now */
  currentOrgs?: string[];
  /** where they work or worked */
  everOrgs?: string[];
  schools?: string[];
  places?: string[];
  keywords?: string[];
  roleNeed?: Need;
  placesNeed?: Need;
  everOrgsNeed?: Need;
  keywordsNeed?: Need;
}

const clean = (xs: string[] | undefined, max: number): string[] => {
  const out: string[] = [];
  for (const x of xs ?? []) {
    const t = x.replace(/\s+/g, ' ').trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= max) break;
  }
  return out;
};

/** The filters with nothing empty, nothing twice and nothing past what a query can carry. */
export function tidyFilters(f: PeopleFilters | undefined): PeopleFilters {
  return {
    titles: clean(f?.titles, 12),
    seniority: clean(f?.seniority, 6),
    currentOrgs: clean(f?.currentOrgs, 8),
    everOrgs: clean(f?.everOrgs, 8),
    schools: clean(f?.schools, 4),
    places: clean(f?.places, 4),
    keywords: clean(f?.keywords, 8),
    roleNeed: f?.roleNeed === 'nice' ? 'nice' : 'must',
    placesNeed: f?.placesNeed === 'nice' ? 'nice' : 'must',
    everOrgsNeed: f?.everOrgsNeed === 'nice' ? 'nice' : 'must',
    keywordsNeed: f?.keywordsNeed === 'must' ? 'must' : 'nice',
  };
}

export function filtersEmpty(f: PeopleFilters): boolean {
  return ![f.titles, f.seniority, f.currentOrgs, f.everOrgs, f.schools, f.places, f.keywords].some(
    (x) => x?.length,
  );
}

const SENIORITY_WORDS: Record<string, string> = {
  intern: 'intern',
  entry: 'junior',
  senior: 'senior',
  manager: 'manager',
  director: 'director',
  vp: 'vice president',
  c_suite: 'executive',
  owner: 'owner',
  founder: 'founder',
  partner: 'partner',
};
Object.setPrototypeOf(SENIORITY_WORDS, null);

const list = (xs: string[], word = 'or'): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;

/** A filter group as one statement about a person, checked against each person found. */
export interface FilterCheck {
  /** which filter it stands for */
  key: 'role' | 'current' | 'ever' | 'school' | 'place' | 'keywords';
  text: string;
  need: Need;
}

/**
 * The filters as statements, one per group in use. A must-have answered "no" leaves a person out, so a filter the
 * student set is one the results keep to; "unknown" (the profile does not say) keeps them, lower down.
 */
export function filterChecks(filters: PeopleFilters | undefined): FilterCheck[] {
  const f = tidyFilters(filters);
  const out: FilterCheck[] = [];
  const level = (f.seniority ?? []).map((s) => SENIORITY_WORDS[s] ?? s.replace(/_/g, ' '));
  if (f.titles?.length || level.length) {
    const what = f.titles?.length
      ? `Their current job is ${list(f.titles.slice(0, 8))}, or another wording of the same kind of work`
      : 'Their current job';
    out.push({
      key: 'role',
      text: level.length
        ? f.titles?.length
          ? `${what}, at ${list(level)} level`
          : `Their current job is at ${list(level)} level`
        : what,
      need: f.roleNeed ?? 'must',
    });
  }
  if (f.currentOrgs?.length)
    out.push({
      key: 'current',
      text: `Works now at ${list(f.currentOrgs)} (a part or a later name of it counts)`,
      need: 'must',
    });
  if (f.everOrgs?.length)
    out.push({
      key: 'ever',
      text: `Works or has worked at ${list(f.everOrgs)} (a part or a later name of it counts)`,
      need: f.everOrgsNeed ?? 'must',
    });
  if (f.schools?.length)
    out.push({
      key: 'school',
      text: `Studied at ${list(f.schools)} (any of its schools or its usual short names count)`,
      need: 'must',
    });
  if (f.places?.length)
    out.push({
      key: 'place',
      text: `Is based in or around ${list(f.places)} (a city inside a named region or country counts)`,
      need: f.placesNeed ?? 'must',
    });
  if (f.keywords?.length && f.keywordsNeed === 'must')
    out.push({
      key: 'keywords',
      text: `Their work has to do with ${list(f.keywords.slice(0, 6))}`,
      need: 'must',
    });
  return out;
}

/** What can be left out of the queries when nobody is found, the least telling first. */
export interface QueryRelax {
  place?: boolean;
  seniority?: boolean;
}

const roleWords = (f: PeopleFilters, relax: QueryRelax): string => {
  const titles = (f.titles ?? []).slice(0, 4);
  // a title says its own level ("vp of engineering"): the level is only said when no title is
  if (titles.length) return list(titles);
  const level = relax.seniority ? [] : (f.seniority ?? []).map((s) => SENIORITY_WORDS[s] ?? s);
  return level.length ? `${list(level)} people` : '';
};

/**
 * The search as one sentence a profile index can match: who, where they work, where they worked, where they studied,
 * where they live, and what about. The student's own sentence is used when the filters say nothing more than it does.
 */
export function describePeople(filters: PeopleFilters | undefined, relax: QueryRelax = {}): string {
  const f = tidyFilters(filters);
  const parts: string[] = [];
  const role = roleWords(f, relax);
  const rest =
    (f.currentOrgs?.length ?? 0) +
    (f.everOrgs?.length ?? 0) +
    (f.schools?.length ?? 0) +
    (f.keywords?.length ?? 0);
  // "people" stands where no job is named, so the sentence still reads as one
  parts.push(role || (rest || (!relax.place && f.places?.length) ? 'people' : ''));
  if (f.currentOrgs?.length) parts.push(`at ${list(f.currentOrgs.slice(0, 4))}`);
  if (f.everOrgs?.length) parts.push(`who worked at ${list(f.everOrgs.slice(0, 4))}`);
  if (f.schools?.length) parts.push(`who studied at ${list(f.schools.slice(0, 3))}`);
  if (!relax.place && f.places?.length) parts.push(`based in ${list(f.places.slice(0, 3))}`);
  if (f.keywords?.length) parts.push(`working on ${list(f.keywords.slice(0, 4), 'and')}`);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Every word of `b` that tells something is already in `a`. */
function covers(a: string, b: string): boolean {
  const have = new Set(norm(a).split(/[^a-z0-9+#]+/));
  const need = norm(b)
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !QUERY_STOP.has(w));
  return need.every((w) => have.has(w) || have.has(`${w}s`) || have.has(w.replace(/s$/, '')));
}

const QUERY_STOP = new Set(
  'the and for with who that are from into any has have based people working worked studied find looking'.split(
    ' ',
  ),
);

/** Words in a company's, school's or place's name that do not tell it from another. */
const NAME_FILLER = new Set(
  'university college school institute business company capital partners ventures group area city greater region state united states kingdom san new los north south east west'.split(
    ' ',
  ),
);
/** How a sentence says a place without its name. */
const PLACE_SAID: [RegExp, RegExp][] = [
  [/\bnew york\b/, /\b(nyc|new york|manhattan|brooklyn)\b/],
  [/\bsan francisco\b|\bbay area\b/, /\b(sf|san francisco|bay area|silicon valley)\b/],
  [/\blos angeles\b/, /\b(la|los angeles)\b/],
  [/\bunited kingdom\b/, /\b(uk|britain|united kingdom)\b/],
  [/\bunited states\b/, /\b(us|usa|america|united states)\b/],
];

/** The sentence already names this company, school or place, in its own words. */
function mentions(said: string, name: string): boolean {
  const s = norm(said);
  const n = norm(name);
  if (!n) return true;
  if (s.includes(n)) return true;
  for (const [is, how] of PLACE_SAID) if (is.test(n) && how.test(s)) return true;
  const have = new Set(s.split(/[^a-z0-9+#]+/));
  return n
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 4 && !NAME_FILLER.has(w))
    .some((w) => have.has(w));
}

/** How many words of a sentence tell something. */
const telling = (q: string) =>
  norm(q)
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !QUERY_STOP.has(w) && w !== 'or').length;

/**
 * The queries for a profile index, at most three: the filters as a sentence, the student's own sentence when it says
 * more, and one per company when several are named (a sentence naming four companies finds mostly the first).
 */
export function peopleQueries(
  ask: string | undefined,
  filters: PeopleFilters | undefined,
  relax: QueryRelax = {},
): string[] {
  const f = tidyFilters(filters);
  const out: string[] = [];
  const add = (q: string | undefined) => {
    const t = (q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (t && !out.some((o) => norm(o) === norm(t))) out.push(t);
  };
  const described = describePeople(f, relax);
  const orgs = f.currentOrgs?.length ? f.currentOrgs : (f.everOrgs ?? []);
  if (orgs.length >= 2) {
    // one company a query: the rest of the filters ride along
    const rest: PeopleFilters = f.currentOrgs?.length ? { ...f, currentOrgs: [] } : { ...f, everOrgs: [] };
    for (const o of orgs.slice(0, 3))
      add(
        describePeople(
          f.currentOrgs?.length ? { ...rest, currentOrgs: [o] } : { ...rest, everOrgs: [o] },
          relax,
        ),
      );
    return out.slice(0, 3);
  }
  const said = (ask ?? '').replace(/\s+/g, ' ').trim();
  const more = !!said && (!described || !covers(described, said));
  // a bare job title ("founder") finds anyone with it: the student's own sentence says who, so it goes alone
  if (!(more && telling(described) <= 1)) add(described);
  // the sentence as typed, when it holds words the filters do not (a topic, a turn of phrase the index can match)
  if (more) {
    const place =
      !relax.place && f.places?.length && !mentions(said, f.places[0]!) ? ` in ${f.places[0]}` : '';
    const school =
      f.schools?.length && !mentions(said, f.schools[0]!) ? ` who studied at ${f.schools[0]}` : '';
    add(`${said}${school}${place}`);
  }
  return out.slice(0, 3);
}

/** LinkedIn's keyword box: the titles as alternatives, then the first topic, or the sentence itself. */
export function linkedInKeywords(
  ask: string | undefined,
  filters: PeopleFilters | undefined,
): string | undefined {
  const f = tidyFilters(filters);
  const quote = (x: string) => (/\s/.test(x) ? `"${x}"` : x);
  const titles = (f.titles ?? []).slice(0, 4).map(quote);
  const topic = (f.keywords ?? []).slice(0, 2).map(quote);
  if (titles.length) return [titles.length > 1 ? `(${titles.join(' OR ')})` : titles[0], ...topic].join(' ');
  if (topic.length) return topic.join(' ');
  // companies, schools and places go in their own fields: with only those, no keyword is needed
  if (f.currentOrgs?.length || f.everOrgs?.length || f.schools?.length) return undefined;
  const said = (ask ?? '').replace(/\s+/g, ' ').trim();
  return said ? said.slice(0, 120) : undefined;
}

// ---- a profile as the web search returns it -----------------------------------------------------------------------

export interface Job {
  title?: string;
  org?: string;
  current: boolean;
  /** the years, when the profile gives them */
  from?: number;
  to?: number;
  location?: string;
}

export interface Study {
  school: string;
  degree?: string;
}

export interface ReadProfile {
  name?: string;
  firstName?: string;
  lastName?: string;
  /** the line under their name on LinkedIn */
  headline?: string;
  location?: string;
  /** newest first; the current ones lead */
  jobs: Job[];
  schools: Study[];
  /** what they wrote about themselves, a few lines */
  about?: string;
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t || undefined;
};
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const yearOf = (v: unknown): number | undefined => {
  const y = typeof v === 'string' ? Number(v.slice(0, 4)) : typeof v === 'number' ? v : Number.NaN;
  return Number.isInteger(y) && y >= 1950 && y <= 2100 ? y : undefined;
};

/** A title without its own company tacked on ("Investor - Salesforce Ventures", "PM @ Stripe"). */
export function cleanTitle(title: string | undefined, org: string | undefined): string | undefined {
  if (!title) return undefined;
  if (!org) return title;
  const o = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = title
    .replace(new RegExp(`\\s*(?:[-–—|,@]|\\bat\\b)\\s*${o}\\s*$`, 'i'), '')
    .replace(new RegExp(`^${o}\\s*[-–—|:]\\s*`, 'i'), '')
    .trim();
  return t || title;
}

/** Markdown from a profile page as plain words: links keep their text, marks go. */
export function plain(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s*\.\.\.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line that is a place, a date range or a field label, not something a person says about themselves. */
const NOT_A_HEADLINE =
  /^(?:about|experience|education|skills|activity|\.\.\.|…)$|^\w{3} \d{4} - |\(current\)\s*$|^department:|united states|\((?:us|uk|gb|ca|in|de|fr|au)\)\s*$/i;

/**
 * The headline from the text the search matched: the line right under "# Their Name". The text is a cut of the page,
 * so the line is often not there; then the current job stands in ("Partner at Seedcamp").
 */
export function headlineFrom(
  text: string | undefined,
  name: string | undefined,
  location?: string,
): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex(
    (l) => /^#\s+\S/.test(l) && (!name || norm(l.replace(/^#\s+/, '')) === norm(name)),
  );
  if (at < 0) return undefined;
  const next = lines[at + 1];
  if (!next || next.startsWith('#') || NOT_A_HEADLINE.test(next)) return undefined;
  if (location && norm(next).startsWith(norm(location).slice(0, 12))) return undefined;
  const h = plain(next);
  return h.length >= 3 && h.length <= 300 ? h : undefined;
}

/** What they wrote under "About", a few lines of it. */
export function aboutFrom(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/##\s*About\s*\n+([\s\S]*?)(?=\n#{1,6}\s|\n\.\.\.\s*\n|$)/i);
  const body = plain(m?.[1] ?? '');
  return body.length >= 20 ? body.slice(0, 400) : undefined;
}

/**
 * One result of a people search read into a profile. Undefined when the result carries no person (a company's page,
 * an article).
 */
export function readExaPerson(r: ExaResult): ReadProfile | undefined {
  const entities = (r as { entities?: unknown }).entities;
  const person = (Array.isArray(entities) ? entities : [])
    .map(obj)
    .find((e) => e?.type === 'person' && obj(e.properties));
  const p = obj(person?.properties);
  if (!p) return undefined;
  const jobs: Job[] = [];
  for (const raw of Array.isArray(p.workHistory) ? p.workHistory : []) {
    const w = obj(raw);
    if (!w) continue;
    const dates = obj(w.dates);
    const org = str(obj(w.company)?.name);
    // "Investor - Salesforce Ventures" at Salesforce Ventures: the company is said once
    const title = cleanTitle(str(w.title), org);
    if (!title && !org) continue;
    const from = yearOf(dates?.from);
    const to = yearOf(dates?.to);
    // an open end is a job they hold now; no dates at all says nothing either way
    const current = !!dates && (dates.to === null || dates.to === undefined) && from !== undefined;
    if (jobs.some((j) => norm(j.title) === norm(title) && norm(j.org) === norm(org) && j.from === from))
      continue;
    jobs.push({
      ...(title ? { title } : {}),
      ...(org ? { org } : {}),
      current,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(str(w.location) ? { location: str(w.location) } : {}),
    });
  }
  // a profile with no dates anywhere: the first job listed is the one they show first, taken as current
  if (jobs.length && !jobs.some((j) => j.current) && jobs.every((j) => !j.from && !j.to))
    jobs[0]!.current = true;
  // the profile's own order is the person's: the job they list first is their main one, whatever started later (a
  // board seat, a lecture, an angel cheque). Jobs they hold now lead, each group in the order the profile had.
  const order = new Map(jobs.map((j, i) => [j, i]));
  jobs.sort((a, b) => Number(b.current) - Number(a.current) || order.get(a)! - order.get(b)!);
  const schools: Study[] = [];
  for (const raw of Array.isArray(p.educationHistory) ? p.educationHistory : []) {
    const e = obj(raw);
    const school = str(obj(e?.institution)?.name);
    if (!school || schools.some((s) => norm(s.school) === norm(school))) continue;
    schools.push({ school, ...(str(e?.degree) ? { degree: str(e?.degree) } : {}) });
  }
  const text = (r.highlights ?? []).join('\n\n');
  const name = str(p.name) ?? str(r.title);
  const location = str(p.location);
  const now = jobs.find((j) => j.current);
  const headline =
    headlineFrom(text, name, location) ??
    (now?.title && now.org ? `${now.title} at ${now.org}` : (now?.title ?? now?.org));
  return {
    ...(name ? { name } : {}),
    ...(str(p.firstName) ? { firstName: str(p.firstName) } : {}),
    ...(str(p.lastName) ? { lastName: str(p.lastName) } : {}),
    ...(headline ? { headline } : {}),
    ...(location ? { location } : {}),
    jobs: jobs.slice(0, 12),
    schools: schools.slice(0, 6),
    ...(aboutFrom(text) ? { about: aboutFrom(text) } : {}),
  };
}

/**
 * The job to show for someone who holds several now: the one at a company the search asked for, else the one whose
 * title the search asked for, else the one their profile lists first.
 */
export function leadJob(jobs: Job[], filters?: PeopleFilters): Job | undefined {
  const now = jobs.filter((j) => j.current);
  if (now.length <= 1) return now[0];
  const has = (hay: string | undefined, needle: string) => {
    const h = norm(hay);
    const n = norm(needle);
    return !!h && !!n && (h === n || h.startsWith(`${n} `) || h.includes(` ${n}`) || n.startsWith(`${h} `));
  };
  const orgs = filters?.currentOrgs ?? [];
  const atAsked = orgs.length ? now.find((j) => orgs.some((o) => has(j.org, o))) : undefined;
  if (atAsked) return atAsked;
  const titles = filters?.titles ?? [];
  const first = now[0]!;
  // only when the first listed is not what was asked and another is
  if (titles.length && !titles.some((t) => has(first.title, t))) {
    const asked = now.find((j) => titles.some((t) => has(j.title, t)));
    if (asked) return asked;
  }
  return first;
}

/** "Partner at Seedcamp (2017 to now)", for the reader that checks a person against the search. */
export function jobLine(j: Job): string {
  const what = j.title && j.org ? `${j.title} at ${j.org}` : (j.title ?? j.org ?? '');
  const when = j.current
    ? j.from
      ? ` (${j.from} to now)`
      : ' (now)'
    : j.from || j.to
      ? ` (${j.from ?? '?'} to ${j.to ?? '?'})`
      : '';
  return `${what}${when}`;
}
