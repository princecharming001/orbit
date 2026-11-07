/**
 * Schools in free text (plan 32 §5.4). The school list (apps/web schools.json: every US degree-granting college plus
 * universities elsewhere, with the names students use) is passed in; this module builds a lookup strict enough for
 * headlines, where a wrong school is worse than none: "IIT Madras" is not Indiana Institute of Technology, "Tech" is
 * not Arkansas Tech, "Brooklyn Tech" is not Brooklyn College.
 *
 * Rules: a name or nickname that two schools share goes to neither (unless an override below decides); a nickname of
 * three letters or fewer counts only when it is a well-known one; common words ("State", "Western") never count alone.
 * The base name of a multi-campus system ("University of Michigan") goes to the campus students mean.
 */

export interface SchoolRow {
  name: string;
  aliases: string[];
  /** 1 US four-year, 2 US two-year, 3 outside the US */
  kind: 1 | 2 | 3;
  domain?: string;
}

export interface SchoolIndex {
  /** the canonical school a name refers to, when it surely refers to one */
  lookup(text: string): string | undefined;
  /** every name that refers to a canonical school, for query expansion and display */
  namesOf(canonical: string): string[];
  size: number;
}

export function foldSchoolText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Short names students use that surely mean one school. Keys are folded. */
const OVERRIDES: Record<string, string> = {
  mit: 'Massachusetts Institute of Technology',
  cmu: 'Carnegie Mellon University',
  nyu: 'New York University',
  usc: 'University of Southern California',
  ucb: 'University of California, Berkeley',
  cal: 'University of California, Berkeley',
  'uc berkeley': 'University of California, Berkeley',
  haas: 'University of California, Berkeley',
  'berkeley haas': 'University of California, Berkeley',
  'berkeley met': 'University of California, Berkeley',
  'uc berkeley met': 'University of California, Berkeley',
  ucla: 'University of California, Los Angeles',
  uci: 'University of California, Irvine',
  ucr: 'University of California, Riverside',
  ucsd: 'University of California, San Diego',
  ucsb: 'University of California, Santa Barbara',
  ucsc: 'University of California, Santa Cruz',
  'uc davis': 'University of California, Davis',
  asu: 'Arizona State University',
  unc: 'University of North Carolina at Chapel Hill',
  umd: 'University of Maryland, College Park',
  uva: 'University of Virginia',
  uw: 'University of Washington',
  ut: 'The University of Texas at Austin',
  'ut austin': 'The University of Texas at Austin',
  bu: 'Boston University',
  gt: 'Georgia Institute of Technology',
  'georgia tech': 'Georgia Institute of Technology',
  byu: 'Brigham Young University',
  rit: 'Rochester Institute of Technology',
  rpi: 'Rensselaer Polytechnic Institute',
  wpi: 'Worcester Polytechnic Institute',
  ucf: 'University of Central Florida',
  fiu: 'Florida International University',
  fsu: 'Florida State University',
  lsu: 'Louisiana State University',
  tcu: 'Texas Christian University',
  smu: 'Southern Methodist University',
  uga: 'University of Georgia',
  psu: 'Pennsylvania State University',
  'penn state': 'Pennsylvania State University',
  upenn: 'University of Pennsylvania',
  penn: 'University of Pennsylvania',
  wharton: 'University of Pennsylvania',
  columbia: 'Columbia University',
  northeastern: 'Northeastern University',
  'michigan ross': 'University of Michigan - Ann Arbor',
  umich: 'University of Michigan - Ann Arbor',
  kellogg: 'Northwestern University',
  'stanford gsb': 'Stanford University',
  hbs: 'Harvard University',
  'harvard business school': 'Harvard University',
  'harvard college': 'Harvard University',
  tuck: 'Dartmouth College',
  fuqua: 'Duke University',
  'mit sloan': 'Massachusetts Institute of Technology',
  rutgers: 'Rutgers University, New Brunswick',
  'rutgers university': 'Rutgers University, New Brunswick',
  lse: 'London School of Economics and Political Science, University of London',
  ucl: 'University College London, University of London',
  eth: 'ETHZ - ETH Zurich',
  'eth zurich': 'ETHZ - ETH Zurich',
  nus: 'National University of Singapore',
  ubc: 'University of British Columbia',
  uoft: 'University of Toronto',
  'u of t': 'University of Toronto',
  waterloo: 'University of Waterloo',
  uwaterloo: 'University of Waterloo',
  oxford: 'University of Oxford',
  cambridge: 'University of Cambridge',
  caltech: 'California Institute of Technology',
  'cal poly': 'California Polytechnic State University, San Luis Obispo',
  'cal poly slo': 'California Polytechnic State University, San Luis Obispo',
  'nc state': 'North Carolina State University',
  'ohio state': 'Ohio State University - Columbus',
  'michigan state': 'Michigan State University',
  'iowa state': 'Iowa State University',
  'arizona state': 'Arizona State University',
  'texas a and m': 'Texas A&M University - College Station',
  tamu: 'Texas A&M University - College Station',
  'virginia tech': 'Virginia Tech',
  uiuc: 'University of Illinois Urbana-Champaign',
  sjsu: 'San Jose State University',
};

/** Words too common to name a school by themselves. Folded. */
const GENERIC = new Set(
  'tech state western eastern northern southern central northeast northwest southeast southwest trinity union national american christian community city metropolitan pacific atlantic mount the mount saint st inc wesleyan university college institute school academy polytechnic global international international school grad graduate alumni scholar honors'.split(
    ' ',
  ),
);

/** Cities a school's nickname may share ("Boston", "Miami"): never a school by themselves. Folded. */
const CITY_WORDS = new Set([
  'boston',
  'new york',
  'nyc',
  'chicago',
  'phoenix',
  'miami',
  'denver',
  'houston',
  'dallas',
  'austin',
  'atlanta',
  'seattle',
  'portland',
  'san francisco',
  'sf',
  'los angeles',
  'la',
  'philadelphia',
  'detroit',
  'baltimore',
  'nashville',
  'memphis',
  'louisville',
  'pittsburgh',
  'cleveland',
  'columbus',
  'cincinnati',
  'toledo',
  'dayton',
  'akron',
  'tulsa',
  'omaha',
  'richmond',
  'rochester',
  'hartford',
  'charlotte',
  'orlando',
  'tampa',
  'san diego',
  'san jose',
  'sacramento',
  'las vegas',
  'salt lake city',
  'minneapolis',
  'st louis',
  'kansas city',
  'indianapolis',
  'milwaukee',
  'buffalo',
  'albany',
  'london',
  'paris',
  'toronto',
  'montreal',
  'vancouver',
  'sydney',
  'melbourne',
  'singapore',
  'hong kong',
  'dubai',
  'berlin',
  'munich',
  'delhi',
  'new delhi',
  'mumbai',
  'bangalore',
  'bengaluru',
  'washington',
  'dc',
  'oakland',
  'brooklyn',
  'manhattan',
  'palo alto',
  'menlo park',
  'mountain view',
]);

/** "Indian Institute of Technology, Delhi" also reads as "IIT Delhi"; "National Institute of Technology, Trichy" as "NIT Trichy". */
function acronymForms(name: string): string[] {
  const m = /^([A-Z][\w]*(?:\s+(?:of|and|for|&)?\s*[A-Z][\w]*)+)\s*[,–-]\s*(.+)$/.exec(name);
  if (!m) return [];
  const initials = m[1]!
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .join('');
  if (initials.length < 3) return [];
  return [`${initials} ${m[2]}`];
}

export function buildSchoolIndex(rows: readonly SchoolRow[]): SchoolIndex {
  const exact = new Map<string, string>();
  const claims = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const known = new Set(rows.map((r) => r.name));
  const claim = (key: string, school: string) => {
    if (!key) return;
    let set = claims.get(key);
    if (!set) claims.set(key, (set = new Set()));
    set.add(school);
  };
  for (const r of rows) {
    exact.set(foldSchoolText(r.name), r.name);
    names.set(r.name, new Set([r.name, ...r.aliases]));
    for (const a of r.aliases) claim(foldSchoolText(a), r.name);
    for (const a of acronymForms(r.name)) {
      claim(foldSchoolText(a), r.name);
      names.get(r.name)!.add(a);
    }
    // "Stanford University" -> "Stanford" when its site is stanford.edu: the short name students use. The domain
    // check keeps "Boston University" from claiming "Boston" (bu.edu) and NYU from claiming "New York"
    // ("University of Miami" is left alone: "University of X" names a place far more often than a nickname does)
    const short = /^(?:the\s+)?([a-z][\w'-]+)\s+(?:university|college)$/i.exec(r.name);
    const stem = r.domain
      ?.toLowerCase()
      .replace(/^www\./, '')
      .split('.')[0];
    const word = short?.[1]?.toLowerCase();
    if (word && stem && word === stem && !GENERIC.has(word)) claim(foldSchoolText(word), r.name);
    // "University of Minnesota, Twin Cities" -> "University of Minnesota", "Northeastern University Oakland" -> no
    const base = /^(.+?)\s*(?:,|\s[-–]\s)\s*\S.*$/.exec(r.name)?.[1];
    if (base && r.kind === 1) claim(`base:${foldSchoolText(base)}`, r.name);
  }
  const map = new Map<string, string>(exact);
  for (const [key, set] of claims) {
    if (key.startsWith('base:')) continue;
    if (map.has(key) || set.size !== 1) continue;
    if (GENERIC.has(key) || CITY_WORDS.has(key)) continue;
    // a three-letter-or-shorter nickname is too easy to collide with ("GCC", "CCS", "GHC")
    if (key.replace(/\s/g, '').length <= 3) continue;
    map.set(key, [...set][0]!);
  }
  // a multi-campus base name goes to the campus with the most names students use, when one clearly leads
  const bases = new Map<string, string[]>();
  for (const [key, set] of claims) if (key.startsWith('base:')) bases.set(key.slice(5), [...set]);
  for (const [base, campuses] of bases) {
    if (map.has(base) || GENERIC.has(base)) continue;
    const ranked = campuses.map((c) => ({ c, n: names.get(c)?.size ?? 0 })).sort((a, b) => b.n - a.n);
    if (ranked.length === 1 || ranked[0]!.n >= ranked[1]!.n + 2) map.set(base, ranked[0]!.c);
  }
  for (const [k, v] of Object.entries(OVERRIDES)) if (known.has(v)) map.set(k, v);
  for (const [k, v] of map) names.get(v)?.add(k);

  return {
    lookup(text: string) {
      const k = foldSchoolText(text);
      if (!k) return undefined;
      const hit = map.get(k) ?? map.get(k.replace(/^university of california /, 'uc '));
      if (hit) return hit;
      // "UC Berkeley College of Engineering", "Stanford Graduate School of Business": the school, then a unit of it
      const unit =
        /^(.+?)\s+(?:college|school|graduate school|grad school|department|dept|faculty|division)\s+(?:of|for)\b/.exec(
          k,
        );
      return unit
        ? (map.get(unit[1]!) ?? map.get(unit[1]!.replace(/^university of california /, 'uc ')))
        : undefined;
    },
    namesOf(canonical: string) {
      return [...(names.get(canonical) ?? [])];
    },
    size: map.size,
  };
}
