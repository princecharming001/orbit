/**
 * Telling a school from an employer in a resume line or a chat message ("University of Michigan" vs "Amma Health
 * Inc."), so an employer never becomes the student's school. Deliberately conservative: a name is a school only with a
 * school word, a well-known school's short name, or "X University"; a name with a company word or a legal suffix is
 * never one.
 */

export const SCHOOL_WORDS =
  /\b(university|universit[àáä]t|universidad|université|college|institute|school|academy|polytechnic|conservatory|seminary)\b/i;

/** Well-known schools students write without a school word ("MIT", "Penn", "Georgia Tech"). */
const KNOWN_SCHOOLS = new Set(
  [
    'mit',
    'caltech',
    'cmu',
    'carnegie mellon',
    'nyu',
    'ucla',
    'usc',
    'uc berkeley',
    'berkeley',
    'uc san diego',
    'ucsd',
    'uc davis',
    'uc irvine',
    'uci',
    'ucsb',
    'unc',
    'unc chapel hill',
    'umich',
    'uiuc',
    'ut austin',
    'upenn',
    'penn',
    'wharton',
    'harvard',
    'yale',
    'princeton',
    'columbia',
    'cornell',
    'dartmouth',
    'brown',
    'stanford',
    'duke',
    'northwestern',
    'georgetown',
    'vanderbilt',
    'rice',
    'emory',
    'tufts',
    'notre dame',
    'georgia tech',
    'virginia tech',
    'texas a&m',
    'purdue',
    'uva',
    'umd',
    'bu',
    'bc',
    'wellesley',
    'barnard',
    'williams',
    'amherst',
    'swarthmore',
    'pomona',
    'harvey mudd',
    'oxford',
    'cambridge',
    'lse',
    'eth zurich',
    'insead',
    'baruch',
    'cuny',
    'suny',
  ].map((s) => s.toLowerCase()),
);

/** Company words and legal suffixes: a name with one of these is an employer, not a school. */
const COMPANY_WORDS =
  /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|technologies|technology|labs?|capital|partners|group|holdings|ventures|bank|health|healthcare|systems|solutions|consulting|studios?|media|software|analytics|therapeutics|pharmaceuticals|logistics|motors|energy|securities|advisors|associates|agency|foundation|fund|ai)\b\.?/i;

/** "High school", "secondary school", "prep": the student's school is their college, not where they went before. */
export const HIGH_SCHOOL = /\b(high school|secondary school|preparatory|prep school|hs)\b/i;

const clean = (s: string) =>
  s
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '')
    .trim();

/** A name that reads as an employer: a legal suffix or a company word, and no school word. */
export function looksLikeCompany(name: string | undefined): boolean {
  const n = clean(name ?? '');
  if (!n) return false;
  if (SCHOOL_WORDS.test(n)) return false;
  return COMPANY_WORDS.test(n);
}

/** A name that reads as a school (and not as a company). */
export function looksLikeSchool(name: string | undefined): boolean {
  const n = clean(name ?? '');
  if (!n || n.length > 120) return false;
  if (SCHOOL_WORDS.test(n)) return true;
  if (looksLikeCompany(n)) return false;
  const l = n.toLowerCase();
  if (KNOWN_SCHOOLS.has(l)) return true;
  // "UC Berkeley, Haas" / "Cornell, Ithaca": the part before the comma
  const head = l.split(',')[0]!.trim();
  if (KNOWN_SCHOOLS.has(head)) return true;
  // "Penn State", "Ohio State", "Michigan State", "Arizona State"
  if (/^[a-z .'-]+ state$/i.test(head) && head.split(' ').length <= 4) return true;
  // "UC Santa Barbara", "UT Dallas", "SUNY Binghamton"
  if (/^(uc|ut|suny|cuny|cal) [a-z ]+$/i.test(head) && head.split(' ').length <= 4) return true;
  return false;
}
