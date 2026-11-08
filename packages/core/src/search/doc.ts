/**
 * The person document network search reads (plan 32 §6.1, lean per §18.11): everything Orbit knows about one person's
 * work, schools and place, each value with where it came from. Relationship data and company facts are not in it;
 * they are joined at query time, so nightly rescoring does not rebuild documents.
 */
import type { ProfileExperienceWire, ProfileReadingWire } from '../server/api';
import type { Affiliation, Person } from '../types';
import { orgKey } from './companies';
import { readHeadline, type SchoolLookup } from './headline';
import type { PlaceIndex, PlaceRead } from './places';
import { readTitle, type SearchSeniority, type TitleFamily } from './titles';

/** Where a value came from, best first. */
export type EvidenceSource =
  | 'manual'
  | 'profile'
  | 'title_field'
  | 'affiliation'
  | 'linkedin_facet'
  | 'extraction'
  | 'headline'
  /** the judge read the person's text and quoted the words its answer rests on */
  | 'judge';

export const EVIDENCE_RANK: Record<EvidenceSource, number> = {
  manual: 6,
  profile: 5,
  title_field: 5,
  affiliation: 5,
  linkedin_facet: 4,
  extraction: 3,
  headline: 2,
  judge: 2,
};

export interface DocRole {
  title?: string;
  org?: string;
  orgKey: string;
  families: TitleFamily[];
  maybe: TitleFamily[];
  seniority?: SearchSeniority;
  founder: boolean;
  earlyEmployee: boolean;
  club: boolean;
  current: boolean;
  /** not held yet ("Incoming SWE @ Google"): neither current nor past */
  future?: boolean;
  /** ISO dates when known */
  start?: string;
  end?: string;
  source: EvidenceSource;
  /** "Building X": a founder said less plainly */
  weak?: boolean;
  /** the YC badge written next to this role ("(YC S25)") */
  ycBatch?: string;
  saysYc?: boolean;
  /** LinkedIn's id for the company, from the person's own profile: names its page exactly (plan 33) */
  linkedinCompanyId?: string;
  /** the text this came from, shown as evidence */
  evidence: string;
}

/** A person's LinkedIn profile as the reading job left it (plan 33). */
export interface DocProfile {
  about?: string;
  experience: readonly ProfileExperienceWire[];
  reading?: ProfileReadingWire;
}

export interface DocSchool {
  /** canonical school name when the school list knows it, else as written */
  name: string;
  gradYear?: number;
  field?: string;
  degree?: string;
  source: EvidenceSource;
  evidence: string;
}

export interface DocPlace extends PlaceRead {
  source: EvidenceSource;
  evidence: string;
}

/** A fact LinkedIn's own search established for this person (plan 32 §7.3, §18.3). */
export interface FacetAssertion {
  kind: 'place' | 'school' | 'company' | 'past_company';
  /** the value searched: a metro label, a school or company name */
  value: string;
  /** true when the person was in the results; false when a completed partition did not include them */
  positive: boolean;
  at: string;
}

/** What the extraction job read from a headline the parser could not (plan 32 §7.2). */
export interface ExtractLabel {
  roles?: { title?: string; org?: string; current: boolean }[];
  schools?: { name: string; gradYear?: number; field?: string }[];
  place?: string;
}

export interface PersonDoc {
  id: string;
  name: string;
  headline?: string;
  roles: DocRole[];
  schools: DocSchool[];
  place?: DocPlace;
  facets: FacetAssertion[];
  known: { current: boolean; place: boolean; schools: boolean; pastJobs: boolean };
  /** searchable text, by field */
  text: {
    headline: string;
    title: string;
    org: string;
    location: string;
    tags: string;
    notes: string;
    summary: string;
    topics: string;
    /** what the person wrote under their jobs on LinkedIn */
    jobs: string;
  };
  tags: string[];
  linkedinMemberId?: string;
  /** what the reading step understood from their About and job descriptions, each fact with its quote */
  reading?: ProfileReadingWire;
  /** their LinkedIn profile was read (so its jobs and About are complete, not guessed from a headline) */
  profileRead?: boolean;
  /** a stable hash of everything above, for the judge cache */
  hash: string;
}

export type DocPerson = Pick<
  Person,
  | 'id'
  | 'displayName'
  | 'headline'
  | 'currentTitle'
  | 'currentOrganizationRaw'
  | 'location'
  | 'school'
  | 'tags'
  | 'notes'
  | 'summary'
  | 'linkedinMemberId'
  | 'fieldSources'
>;

export interface DocDeps {
  isSchool?: SchoolLookup;
  places?: PlaceIndex;
  /** organization names by id, for affiliations that point at one */
  orgName?: (id: string) => string | undefined;
}

function yearOf(date: string | undefined): number | undefined {
  const m = date ? /^(\d{4})/.exec(date) : null;
  return m ? Number(m[1]) : undefined;
}

export function buildPersonDoc(
  person: DocPerson,
  affiliations: readonly Affiliation[],
  deps: DocDeps,
  facets: readonly FacetAssertion[] = [],
  label?: ExtractLabel,
  profile?: DocProfile,
): PersonDoc {
  const roles: DocRole[] = [];
  const schools: DocSchool[] = [];
  const add = (
    r: Omit<DocRole, 'families' | 'maybe' | 'seniority' | 'founder' | 'earlyEmployee' | 'club' | 'orgKey'> & {
      orgKey?: string;
    },
  ) => {
    const read = readTitle(r.title, r.org);
    const key = r.orgKey ?? orgKey(r.org);
    const same = roles.find(
      (x) => x.orgKey && x.orgKey === key && x.current === r.current && !!x.future === !!r.future,
    );
    if (same) {
      // one job seen twice (title field and headline): keep the better source, fill in what it lacks
      if (EVIDENCE_RANK[r.source] > EVIDENCE_RANK[same.source]) {
        same.source = r.source;
        same.evidence = r.evidence;
      }
      if (!same.title && r.title) {
        same.title = r.title;
        Object.assign(same, pickRead(readTitle(r.title, r.org ?? same.org)));
      }
      same.ycBatch ??= r.ycBatch;
      same.saysYc ||= r.saysYc;
      same.start ??= r.start;
      same.end ??= r.end;
      same.linkedinCompanyId ??= r.linkedinCompanyId;
      if (!r.weak) same.weak = false;
      return;
    }
    if (!key && !read.families.length && !read.founder) return;
    roles.push({ ...r, orgKey: key, ...pickRead(read) });
  };

  const fs = person.fieldSources ?? {};
  const titleSource: EvidenceSource =
    fs.currentTitle === 'manual'
      ? 'manual'
      : fs.currentTitle === 'linkedin_profile'
        ? 'profile'
        : 'title_field';
  if (person.currentTitle || person.currentOrganizationRaw)
    add({
      title: person.currentTitle,
      org: person.currentOrganizationRaw,
      // a title field that says so ("prev SWE intern", "Former PM") is a past job, whatever the field is called
      current: !/^\s*(?:ex[\s-]|former(?:ly)?\b|prev(?:ious(?:ly)?)?\.?\s|past\b|retired\b)/i.test(
        person.currentTitle ?? '',
      ),
      source: titleSource,
      evidence: [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at '),
    });

  for (const a of affiliations) {
    const org = a.nameRaw || (a.organizationId ? deps.orgName?.(a.organizationId) : undefined);
    if (a.kind === 'employment') {
      add({
        title: a.title,
        org,
        current: a.isCurrent,
        start: a.startDate,
        end: a.endDate,
        source: a.source === 'manual' ? 'manual' : 'affiliation',
        evidence: [a.title, org].filter(Boolean).join(' at '),
      });
    } else if (org) {
      schools.push({
        name: deps.isSchool?.(org) ?? org,
        gradYear: yearOf(a.endDate),
        field: a.field,
        degree: a.degree,
        source: a.source === 'manual' ? 'manual' : 'affiliation',
        evidence: [a.degree, a.field, org].filter(Boolean).join(', '),
      });
    }
  }

  // the jobs on their LinkedIn profile, with dates and the company's LinkedIn id
  for (const e of profile?.experience ?? []) {
    if (!e.title && !e.company) continue;
    add({
      title: e.title,
      org: e.company,
      current: e.current,
      start: e.start,
      end: e.end,
      source: 'profile',
      linkedinCompanyId: e.companyId,
      evidence: `LinkedIn: ${[e.title, e.company].filter(Boolean).join(' at ')}`,
    });
  }
  // "I angel invest in pre-seed founders": an investing role in their own words
  const angel = profile?.reading?.signals?.find((x) => x.value === 'angel_investing');
  if (angel)
    add({
      title: 'Angel investor',
      current: true,
      source: 'profile',
      evidence: `"${angel.quote}"`,
    });

  const h = readHeadline(person.headline, deps.isSchool);
  const badgeFor = (text: string) => h.yc.find((y) => y.text === text);
  for (const r of h.roles) {
    const badge = badgeFor(r.text);
    add({
      title: r.title,
      org: r.org,
      current: r.current,
      future: r.future,
      source: 'headline',
      weak: r.weak,
      ycBatch: badge?.batch,
      saysYc: !!badge,
      evidence: r.text,
    });
  }
  // a badge on a part with no parsed org ("YC W25") belongs to the current org
  for (const y of h.yc)
    if (!h.roles.some((r) => r.text === y.text)) {
      const cur = roles.find((r) => r.current && r.orgKey && (!y.org || r.orgKey === orgKey(y.org)));
      if (cur) {
        cur.ycBatch ??= y.batch;
        cur.saysYc = true;
      } else if (y.org)
        add({
          org: y.org,
          current: !/\b(ex|prev|former|previously)\b/i.test(y.text),
          source: 'headline',
          ycBatch: y.batch,
          saysYc: true,
          evidence: y.text,
        });
    }
  for (const s of h.schools)
    if (!schools.some((x) => x.name === s.name))
      schools.push({
        name: s.name,
        gradYear: s.gradYear,
        field: s.field,
        source: 'headline',
        evidence: s.text,
      });
    else {
      const x = schools.find((x) => x.name === s.name)!;
      x.gradYear ??= s.gradYear;
      x.field ??= s.field;
    }
  if (person.school && !schools.some((x) => x.name === (deps.isSchool?.(person.school!) ?? person.school)))
    schools.push({
      name: deps.isSchool?.(person.school) ?? person.school,
      source: fs.school === 'manual' ? 'manual' : 'title_field',
      evidence: person.school,
    });

  for (const r of label?.roles ?? [])
    add({
      title: r.title,
      org: r.org,
      current: r.current,
      source: 'extraction',
      evidence: [r.title, r.org].filter(Boolean).join(' at '),
    });
  for (const s of label?.schools ?? []) {
    const name = deps.isSchool?.(s.name) ?? s.name;
    if (!schools.some((x) => x.name === name))
      schools.push({ name, gradYear: s.gradYear, field: s.field, source: 'extraction', evidence: s.name });
  }

  for (const f of facets) {
    if (!f.positive) continue;
    if (f.kind === 'company' || f.kind === 'past_company')
      add({
        org: f.value,
        current: f.kind === 'company',
        source: 'linkedin_facet',
        evidence: `LinkedIn: ${f.kind === 'company' ? 'works at' : 'worked at'} ${f.value}`,
      });
    if (f.kind === 'school') {
      const name = deps.isSchool?.(f.value) ?? f.value;
      if (!schools.some((x) => x.name === name))
        schools.push({ name, source: 'linkedin_facet', evidence: `LinkedIn: went to ${f.value}` });
    }
  }

  let place: DocPlace | undefined;
  const locRead = deps.places?.read(person.location);
  if (locRead && person.location)
    place = {
      ...locRead,
      source:
        fs.location === 'manual' ? 'manual' : fs.location === 'linkedin_profile' ? 'profile' : 'title_field',
      evidence: person.location,
    };
  const facetPlace = facets.find((f) => f.kind === 'place' && f.positive);
  if (!place?.metro && facetPlace) {
    const r = deps.places?.read(facetPlace.value);
    if (r) place = { ...r, source: 'linkedin_facet', evidence: `LinkedIn: in ${facetPlace.value}` };
  }
  if (!place && label?.place) {
    const r = deps.places?.read(label.place);
    if (r) place = { ...r, source: 'extraction', evidence: label.place };
  }

  const known = {
    current: !!person.currentOrganizationRaw || roles.some((r) => r.current && !!r.orgKey),
    place: !!place,
    schools: schools.length > 0,
    pastJobs: affiliations.some((a) => a.kind === 'employment' && !a.isCurrent),
  };
  const text = {
    headline: person.headline ?? '',
    title: person.currentTitle ?? '',
    org: [person.currentOrganizationRaw, ...roles.map((r) => r.org)].filter(Boolean).join(' | '),
    location: person.location ?? '',
    tags: (person.tags ?? []).join(' '),
    notes: person.notes ?? '',
    summary: person.summary || profile?.about || '',
    topics: [...h.topics, ...(profile?.reading?.focus ?? []).map((f) => f.value)].join(' | '),
    jobs: (profile?.experience ?? [])
      .map((e) => e.description)
      .filter(Boolean)
      .join(' | '),
  };
  const doc: Omit<PersonDoc, 'hash'> = {
    id: person.id,
    name: person.displayName,
    headline: person.headline,
    roles,
    schools,
    place,
    facets: [...facets],
    known,
    text,
    tags: person.tags ?? [],
    linkedinMemberId: person.linkedinMemberId,
    ...(profile?.reading ? { reading: profile.reading } : {}),
    ...(profile ? { profileRead: true } : {}),
  };
  return {
    ...doc,
    hash: hashString(
      JSON.stringify([
        text.headline,
        text.title,
        text.org,
        text.location,
        roles.length,
        schools.map((s) => s.name),
        facets.length,
        // a new About or reading changes what the judge reads, so it is asked again
        text.summary.length,
        text.jobs.length,
        profile?.reading ? JSON.stringify(profile.reading).length : 0,
      ]),
    ),
  };
}

function pickRead(r: ReturnType<typeof readTitle>) {
  return {
    families: r.families,
    maybe: r.maybe,
    seniority: r.seniority,
    founder: r.founder,
    earlyEmployee: r.earlyEmployee,
    club: r.club,
  };
}

/** FNV-1a, 32 bits, as hex: a cache key, not a security hash. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** All of a doc's text in one lowercase string, for hint checks and lexical fallback. */
export function docText(d: PersonDoc): string {
  const t = d.text;
  return `${d.name} ${t.headline} ${t.title} ${t.org} ${t.location} ${t.tags} ${t.summary} ${t.topics} ${t.jobs}`.toLowerCase();
}

export { yearOf as isoYear };
