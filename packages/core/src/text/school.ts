/**
 * Telling whether two ways of writing a school name are the same school (plan 17 E/F: alumni status comes from
 * education evidence, so "UC Berkeley" on a LinkedIn profile has to meet "University of California, Berkeley" in the
 * student's settings). Structural only: case, accents, punctuation, "The", "at", University of California campuses,
 * and a business/law/graduate school written after its university. Aliases ("Cal", "UMich") come from the caller
 * (the web app's school list) through `alias`.
 *
 * Deliberately strict: "Cornell University" and "Cornell College" are two schools, as are "Boston University" and
 * "Boston College"; a wrong alum is worse than a missed one.
 */
import { stripDiacritics } from './normalize';

/** A sub-school written after (or before) its university: "Haas School of Business", "School of Law". */
const SUB_SCHOOL =
  /\b(school of [a-z ]+|college of [a-z ]+|business school|law school|graduate school(?: of [a-z ]+)?|medical school|[a-z]+ school of [a-z ]+)\b/;

function fold(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The comparable form of one school name: folded, without a leading "the", University of California campuses as
 * "uc <campus>", "X at Y" as "X Y".
 */
export function schoolKey(raw: string | undefined | null): string {
  let k = fold(raw ?? '');
  if (!k) return '';
  k = k.replace(/^the /, '');
  k = k.replace(/^university of california (?:at )?/, 'uc ');
  k = k.replace(/ at /g, ' ');
  return k.trim();
}

/**
 * The university part of a name that also names one of its schools ("UC Berkeley, Haas School of Business",
 * "University of Michigan - Stephen M. Ross School of Business"), or the name itself.
 */
export function universityPart(raw: string | undefined | null): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  // split on a dash or comma that separates the university from one of its schools
  const parts = text
    .split(/\s+[-–—|]\s+|,\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length < 2) return text;
  const kept = parts.filter((p) => !SUB_SCHOOL.test(fold(p)) || /universit|college$|institute/i.test(p));
  // "University of California, Berkeley": a campus after a comma is part of the name, not a school
  if (/^(the )?university of california$/i.test(parts[0]!)) return text;
  return kept.length && kept.length < parts.length ? kept.join(', ') : text;
}

/**
 * Whether two school names are one school. `alias` maps a name to a canonical one (the app's school list with its
 * aliases); without it only the structural forms are compared.
 */
export function sameSchool(
  a: string | undefined | null,
  b: string | undefined | null,
  alias?: (name: string) => string | undefined,
): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const fa = schoolForms(a, alias);
  for (const f of schoolForms(b, alias)) if (fa.has(f)) return true;
  return false;
}

/** Every comparable form of a name: as written, its university part, and the canonical name of each. */
function schoolForms(x: string, alias?: (name: string) => string | undefined): Set<string> {
  const base = universityPart(x);
  const out = new Set([schoolKey(x), schoolKey(base)]);
  for (const f of [x, base]) {
    const c = alias?.(f);
    if (c) out.add(schoolKey(c));
  }
  out.delete('');
  return out;
}
