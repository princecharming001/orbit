/**
 * The student's school, degree, majors and graduation year as their resume states them, for Orbit to offer (never to
 * set on its own) when the profile says something else. Only an education line whose place reads as a college counts:
 * an employer, a high school or a line the student unticked never becomes the school.
 */
import type { ResumeFacet, User } from '../types';
import { HIGH_SCHOOL, looksLikeCompany, looksLikeSchool, SCHOOL_WORDS } from './schools';

export interface ResumeProfile {
  school?: string;
  degree?: string;
  majors?: string[];
  graduationYear?: number;
}

const DEGREE_HEAD =
  /^(b\.?\s?s\.?\s?e\.?|b\.?\s?s\.?|b\.?\s?a\.?|a\.?\s?b\.?|s\.?\s?b\.?|b\.?\s?sc\.?|b\.?\s?eng\.?|b\.?\s?f\.?\s?a\.?|b\.?\s?b\.?\s?a\.?|bsba|m\.?\s?s\.?|m\.?\s?a\.?|m\.?\s?eng\.?|m\.?\s?b\.?\s?a\.?|m\.?\s?f\.?\s?a\.?|ph\.?\s?d\.?|(?:bachelor|master)(?:'s)?(?: of (?:science|arts|engineering|business administration|fine arts|applied science))?|associate(?:'s)?(?: of (?:science|arts))?)(?=[\s,.;:]|$)/i;

/** "B.S.E. in Computer Science" → degree "B.S.E.", majors ["Computer Science"]. */
export function degreeAndMajors(title: string | undefined): { degree?: string; majors: string[] } {
  if (!title) return { majors: [] };
  const t = title.replace(/\s+/g, ' ').trim();
  const head = t.match(DEGREE_HEAD);
  const degree = head ? head[0].replace(/[\s,]+$/, '').trim() : undefined;
  let rest = head ? t.slice(head[0].length) : t;
  rest = rest
    .replace(/^[\s,.:;-]*(?:degree\s+)?(?:(?:in|of)\s+)?/i, '')
    // minors, concentrations, honors and GPAs are not majors
    .replace(
      /[,;(]?\s*(?:with\s+)?(?:a\s+)?(?:minors?|concentrations?|specializations?|focus|track|emphasis|honors|cum laude|magna|summa|gpa)\b.*$/i,
      '',
    )
    .replace(/[,;.\s]+$/, '')
    .trim();
  if (!rest || rest.length > 80) return { degree, majors: [] };
  const majors = rest
    .replace(/^double major in\s+/i, '')
    .split(/\s*(?:,|;|&|\band\b|\/)\s*/i)
    .map((m) => m.replace(/\s+(?:major|majors)$/i, '').trim())
    .filter((m) => m.length >= 2 && m.split(/\s+/).length <= 5 && !/\d/.test(m) && !SCHOOL_WORDS.test(m));
  return { degree, majors };
}

/** The university itself, without a sub-school after a comma ("Boston University, Questrom School of Business"). */
function mainSchool(org: string): string {
  const parts = org.split(/\s*,\s*/);
  if (parts.length > 1 && looksLikeSchool(parts[0]) && SCHOOL_WORDS.test(parts.slice(1).join(' ')))
    return parts[0]!;
  return org.trim();
}

/** What the resume says about the student's college, from its education lines. */
export function profileFromResume(
  facets: Pick<ResumeFacet, 'kind' | 'title' | 'organizationName' | 'endDate' | 'excluded'>[],
  now = new Date(),
): ResumeProfile {
  const colleges = facets.filter(
    (f) =>
      f.kind === 'education' &&
      !f.excluded &&
      !!f.organizationName &&
      // a school by its name, or a place with a degree that is not an employer ("Wesleyan", "B.A. Economics")
      (looksLikeSchool(f.organizationName) || !!degreeAndMajors(f.title).degree) &&
      !looksLikeCompany(f.organizationName) &&
      !HIGH_SCHOOL.test(f.organizationName),
  );
  if (!colleges.length) return {};
  // the latest (or the only) one: an MBA after a BA, the current school after a transfer
  const pick = [...colleges].sort((a, b) => (b.endDate ?? '9999').localeCompare(a.endDate ?? '9999'))[0]!;
  const { degree, majors } = degreeAndMajors(pick.title);
  const year = pick.endDate ? Number(pick.endDate.slice(0, 4)) : undefined;
  const thisYear = now.getUTCFullYear();
  return {
    school: mainSchool(pick.organizationName!),
    degree,
    majors: majors.length ? majors : undefined,
    graduationYear: year && year >= thisYear - 10 && year <= thisYear + 8 ? year : undefined,
  };
}

const norm = (s: string | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|of|at)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** What the resume says that the profile does not: only the fields that differ, or undefined when none do. */
export function resumeProfileChanges(
  user: Pick<User, 'school' | 'majors' | 'graduationYear' | 'degree'>,
  resume: ResumeProfile,
): ResumeProfile | undefined {
  const out: ResumeProfile = {};
  if (resume.school) {
    const a = norm(user.school);
    const b = norm(resume.school);
    if (!a || (a !== b && !a.includes(b) && !b.includes(a))) out.school = resume.school;
  }
  if (resume.majors?.length) {
    const have = new Set((user.majors ?? []).map(norm));
    if (resume.majors.some((m) => !have.has(norm(m)))) out.majors = resume.majors;
  }
  if (resume.graduationYear && resume.graduationYear !== user.graduationYear)
    out.graduationYear = resume.graduationYear;
  if (resume.degree && norm(resume.degree).replace(/\s/g, '') !== norm(user.degree).replace(/\s/g, ''))
    out.degree = resume.degree;
  // a degree alone is not worth asking about
  if (!out.school && !out.majors && !out.graduationYear) return undefined;
  return out;
}
