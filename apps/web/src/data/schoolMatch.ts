/**
 * Is this the same school? "UC Berkeley", "Cal", "University of California-Berkeley" and "University of California,
 * Berkeley" are one school; "Boston College" and "Boston University" are two. Names are compared by the school they
 * name in the school list (schools.json: names and the names students use), else by their folded text.
 *
 * The list is large and loaded on demand: `loadSchoolIndex()` once (the alumni repair does), after which
 * `sameSchool` and `schoolKey` answer synchronously. Before it is loaded they compare folded text only.
 */
import { loadSchools } from './schools';

let index: Map<string, string> | undefined;
/** the list's school name -> its web domain ("berkeley.edu") */
let domains: Map<string, string> | undefined;
let loading: Promise<void> | undefined;

/** "The University of Texas at Austin" -> "universityoftexasaustin"; "U.C. Berkeley" -> "ucberkeley". */
export function foldSchool(name: string | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ at /g, ' ')
    .replace(/ /g, '');
}

/** Build the lookup from every school's name and the names students use for it. Safe to call many times. */
export function loadSchoolIndex(): Promise<void> {
  loading ??= loadSchools().then((schools) => {
    const map = new Map<string, string>();
    // four-year US schools first, so a shared nickname goes to the school students mean
    const ordered = [...schools].sort((a, b) => a.kind - b.kind);
    for (const s of ordered) map.set(foldSchool(s.name), s.name);
    for (const s of ordered)
      for (const a of s.aliases) {
        const k = foldSchool(a);
        if (k.length >= 2 && !map.has(k)) map.set(k, s.name);
      }
    // "University of Michigan" for "University of Michigan - Ann Arbor": the campus with the most names students use
    const campuses = new Map<string, { name: string; names: number }>();
    for (const s of ordered) {
      const m = s.name.match(/^(.+?)\s*[-–]\s*\S.*$/);
      if (!m || s.kind !== 1) continue;
      const base = foldSchool(m[1]);
      const best = campuses.get(base);
      if (!best || s.aliases.length > best.names)
        campuses.set(base, { name: s.name, names: s.aliases.length });
    }
    for (const [base, { name }] of campuses) if (!map.has(base)) map.set(base, name);
    domains = new Map(
      ordered.filter((s) => s.domain).map((s) => [s.name, s.domain.replace(/^(www|web)\./, '')]),
    );
    index = map;
  });
  return loading;
}

/** The school a name refers to, as a comparable key: the list's name when it knows the school, else folded text. */
export function schoolKey(name: string | undefined): string {
  const k = foldSchool(name);
  if (!k) return '';
  const canonical = index?.get(k);
  return canonical ? foldSchool(canonical) : k;
}

export function sameSchool(a: string | undefined, b: string | undefined): boolean {
  const ka = schoolKey(a);
  return !!ka && ka === schoolKey(b);
}

/** The school's email domain ("berkeley.edu"), once the list is loaded. */
export function schoolDomainOf(name: string | undefined): string | undefined {
  const canonical = index?.get(foldSchool(name));
  return canonical ? domains?.get(canonical) : undefined;
}

/**
 * An address only a graduate has: the school's alumni mail ("@alumni.stanford.edu", "@alum.mit.edu"). A plain school
 * address ("@berkeley.edu") is not one: staff, professors and current students have those too.
 */
export function isAlumniAddress(email: string | undefined, schoolDomain: string | undefined): boolean {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  const base = schoolDomain
    ?.trim()
    .toLowerCase()
    .replace(/^(www|web)\./, '');
  if (!domain || !base) return false;
  return new RegExp(
    `^(?:[a-z0-9-]+\\.)*(?:alumni|alum|alumnae|alumnus|alumni-[a-z]+)\\.${base.replace(/\./g, '\\.')}$`,
  ).test(domain);
}
