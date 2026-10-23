/**
 * "Cornell alum" means Orbit has evidence the person studied at the student's school and finished there:
 *
 * - the student said so (they marked the person as an alum);
 * - an education record at that school that has ended (LinkedIn's education section, a resume-style record);
 * - an alumni address of that school ("@alumni.cornell.edu"), which only graduates get.
 *
 * The same school written on their record is not enough on its own: a classmate the student added with their school,
 * a professor, staff and current students (a plain "@cornell.edu" address) are "at your school", not alumni.
 */
import type { Affiliation, Person, User } from '@orbit/core';
import { isAlumniAddress, loadSchoolIndex, sameSchool, schoolDomainOf } from '../data/schoolMatch';
import { db } from '../db/schema';

export type SchoolTie = 'alum' | 'same_school';

const STUDENT_TITLE =
  /\b(student|undergrad\w*|candidate|freshman|sophomore|junior|senior|class of|phd|mba)\b/i;

/** How the person is tied to the student's school, from what Orbit holds about them. */
export function schoolTie(
  person: Pick<
    Person,
    'relationshipType' | 'school' | 'emails' | 'primaryEmail' | 'fieldSources' | 'currentTitle'
  >,
  education: Pick<Affiliation, 'nameRaw' | 'isCurrent' | 'endDate'>[],
  user: Pick<User, 'school' | 'schoolDomain'>,
  now = new Date(),
): SchoolTie | undefined {
  if (!user.school?.trim()) return undefined;
  if (person.relationshipType === 'alumni') return 'alum';
  const today = now.toISOString().slice(0, 10);
  const there = education.filter((a) => sameSchool(a.nameRaw, user.school));
  if (there.some((a) => !a.isCurrent && (!a.endDate || a.endDate.slice(0, 10) <= today))) return 'alum';
  const domain = user.schoolDomain || schoolDomainOf(user.school);
  if ([person.primaryEmail, ...(person.emails ?? [])].some((e) => isAlumniAddress(e, domain))) return 'alum';
  if (there.length) return 'same_school';
  if (sameSchool(person.school, user.school)) {
    // a school read from their LinkedIn profile, with a job that is not a student's: they studied there and left
    const fromProfile = person.fieldSources?.school === 'enrichment';
    return fromProfile && person.currentTitle && !STUDENT_TITLE.test(person.currentTitle)
      ? 'alum'
      : 'same_school';
  }
  return undefined;
}

/**
 * Set every person's alum label from the evidence above. Returns the people whose label changed, so what was said
 * because of it (a summary, a recommendation reason, a card, a draft) can be written again.
 */
export async function recomputeAlumni(
  user: Pick<User, 'id' | 'school' | 'schoolDomain'>,
  now = new Date(),
): Promise<{ lost: string[]; gained: string[] }> {
  await loadSchoolIndex().catch(() => undefined);
  const [people, affiliations] = await Promise.all([
    db.people.where('userId').equals(user.id).toArray(),
    db.affiliations.where('userId').equals(user.id).toArray(),
  ]);
  const education = new Map<string, Affiliation[]>();
  for (const a of affiliations)
    if (a.kind === 'education') education.set(a.personId, [...(education.get(a.personId) ?? []), a]);
  const lost: string[] = [];
  const gained: string[] = [];
  for (const p of people) {
    const alum = schoolTie(p, education.get(p.id) ?? [], user, now) === 'alum';
    if (alum === !!p.isAlumni) continue;
    await db.people.update(p.id, { isAlumni: alum });
    (alum ? gained : lost).push(p.id);
  }
  return { lost, gained };
}
