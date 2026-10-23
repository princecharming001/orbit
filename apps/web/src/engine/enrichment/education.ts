/**
 * Where someone studied, from education evidence only (plan 17 E/F): the education rows of their affiliations, which
 * the LinkedIn profile step fills from the Education section of their profile (and the demo seeds). Never a headline
 * mention, an employer's domain or a guess. `studiedAt` is what alumni status should rest on.
 *
 * School names are compared with the web app's school list (names and the aliases students use: "Cal", "UMich"),
 * on top of core's structural comparison (sameSchool), so "UC Berkeley" on LinkedIn meets "University of California,
 * Berkeley" in the student's settings while "Cornell College" never meets "Cornell University".
 */
import type { Affiliation, Person, PersonSource } from '@orbit/core';
import { sameSchool, schoolKey } from '@orbit/core';
import { loadSchools, type School } from '../../data/schools';
import { db } from '../../db/schema';

export interface EducationEvidence {
  /** the school as the evidence names it */
  school: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  /** still studying there (an end date ahead) */
  current: boolean;
  source: PersonSource;
  affiliationId: string;
}

export type SchoolAlias = (name: string) => string | undefined;

/**
 * Canonical school names by every way of writing them in the list: the name, each alias that names only that school,
 * and a campus-less name ("University of Michigan" for "University of Michigan - Ann Arbor") given to the main
 * campus, which has the shortest web address of the campuses sharing it.
 */
export function buildSchoolAlias(schools: School[]): SchoolAlias {
  const map = new Map<string, string | null>();
  const add = (written: string, canonical: string) => {
    const k = schoolKey(written);
    if (!k) return;
    const cur = map.get(k);
    if (cur === undefined) map.set(k, canonical);
    else if (cur !== canonical) map.set(k, null);
  };
  const names = new Set(schools.map((s) => schoolKey(s.name)));
  for (const s of schools) {
    add(s.name, s.name);
    for (const a of s.aliases) if (a.length >= 3) add(a, s.name);
  }
  // campus-less names: only when no school is called that already, given to the main campus
  const byBase = new Map<string, School[]>();
  for (const s of schools) {
    const m = /^(.+?)\s*[-–]\s*[A-Z][\w.' ]+$/.exec(s.name);
    // a campus after a university's name, not a hyphenated name ("Winston-Salem State University")
    if (!m || !/universit|college|institute|state/i.test(m[1]!)) continue;
    const base = schoolKey(m[1]);
    if (!base || names.has(base)) continue;
    byBase.set(base, [...(byBase.get(base) ?? []), s]);
  }
  for (const [base, group] of byBase) {
    const sorted = [...group].sort((a, b) => a.domain.length - b.domain.length);
    const main = sorted[0]!;
    if (sorted.length > 1 && sorted[1]!.domain.length === main.domain.length) continue;
    if (!map.has(base)) map.set(base, main.name);
  }
  return (name) => map.get(schoolKey(name)) ?? undefined;
}

let aliasLoaded: Promise<SchoolAlias> | undefined;

/** The school list's aliases, loaded once (the list itself is loaded only when needed). */
export function schoolAlias(): Promise<SchoolAlias> {
  aliasLoaded ??= loadSchools()
    .then(buildSchoolAlias)
    .catch(() => () => undefined);
  return aliasLoaded;
}

/** The education rows that say this person studied at `school`, best first (LinkedIn's own, then the latest). */
export function studiedAtFrom(
  affiliations: Pick<
    Affiliation,
    'id' | 'kind' | 'nameRaw' | 'degree' | 'field' | 'startDate' | 'endDate' | 'source'
  >[],
  school: string | undefined,
  alias?: SchoolAlias,
  now = new Date(),
): EducationEvidence | undefined {
  if (!school?.trim()) return undefined;
  const hits = affiliations
    .filter((a) => a.kind === 'education' && sameSchool(a.nameRaw, school, alias))
    .sort(
      (a, b) =>
        Number(b.source === 'linkedin_profile') - Number(a.source === 'linkedin_profile') ||
        (b.endDate ?? b.startDate ?? '').localeCompare(a.endDate ?? a.startDate ?? ''),
    );
  const a = hits[0];
  if (!a) return undefined;
  const end = a.endDate ? Date.parse(a.endDate) : Number.NaN;
  return {
    school: a.nameRaw,
    degree: a.degree,
    field: a.field,
    startDate: a.startDate,
    endDate: a.endDate,
    current: Number.isFinite(end) && end > now.getTime(),
    source: a.source,
    affiliationId: a.id,
  };
}

/**
 * Whether this person studied at `school`, with the evidence: their education rows (from their LinkedIn profile or
 * an import), compared with the school list's aliases. Undefined when nothing on record says so.
 */
export async function studiedAt(
  person: Pick<Person, 'id'>,
  school: string | undefined,
  now = new Date(),
): Promise<EducationEvidence | undefined> {
  if (!school?.trim()) return undefined;
  const affs = await db.affiliations.where('personId').equals(person.id).toArray();
  if (!affs.some((a) => a.kind === 'education')) return undefined;
  return studiedAtFrom(affs, school, await schoolAlias(), now);
}
