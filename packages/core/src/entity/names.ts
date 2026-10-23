/**
 * One way to tell whether two written names are one person's name, used by every place Orbit matches people by name:
 * resolution (entity/resolve.ts), filling in someone from LinkedIn (enrich), binding a LinkedIn chat to a person when
 * LinkedIn gives no id (the inbox reader), and naming mutual connections.
 *
 * What it forgives, and why:
 * - writing systems and accents: every name is transliterated to Latin letters first (any-ascii, see translit.ts), so
 *   "José"/"Jose", "Łukasz"/"Lukasz", "Søren"/"Soren", "Иван Петров"/"Ivan Petrov" and "王伟"/"Wei Wang" compare equal;
 * - nicknames: Bill/William and Liz/Elizabeth (text/normalize.ts and the vendored carltonnorthern/nicknames table);
 * - middle names and initials: "Mary Ann Smith"/"Mary Smith", "J. Robert Smith"/"Robert Smith" (goes by the middle
 *   name), "P. Patel"/"Priya Patel" (a weak match);
 * - multi-part surnames: "Gabriel García Márquez"/"Gabriel García", "Núñez-García"/"Nunez Garcia";
 * - order: names written in CJK or Hangul are surname first ("王伟" is Wang Wei, given name Wei), and East Asian
 *   names are often swapped in Latin letters ("Wang Wei"/"Wei Wang");
 * - Korean and Chinese surnames' usual spellings ("김" is Gim in transliteration and Kim on LinkedIn);
 * - spelling that sounds the same (Steven/Stephen, Thomson/Thompson), only when the spellings are already close: a
 *   phonetic code (double metaphone, doubleMetaphone.ts) breaks ties, it never makes two different names one.
 * A name that folds to nothing (a script the table does not cover, emoji) never equals anything.
 *
 * Every relation here is about names only. Whether two records are one person also needs evidence that is not the
 * name (entity/resolve.ts): namesakes are common.
 */
import { jaroWinkler } from '../text/jaro';
import { firstNameRelation, NAME_PARTICLES, type NameParts, parseName } from '../text/normalize';
import { doubleMetaphone } from './doubleMetaphone';
import { isFirstNameVariant } from './nicknames';
import { transliterate, writtenSurnameFirst } from './translit';

/** A name folded for comparison: lower-case ASCII words. */
export interface FoldedName {
  /** the given name, its parts run together ("Min-Jun" → minjun, "Mary-Jane" → maryjane) */
  given: string;
  /** the given name's own parts when it had several ("Min-Jun" → min, jun) */
  givenParts: string[];
  /** middle names and initials */
  middles: string[];
  /** surname words without particles ("de la Cruz" → cruz; "Núñez-García" → nunez, garcia) */
  surnames: string[];
  /** written in CJK ideographs or Hangul (so surname first, and spelled by its syllables) */
  eastAsian: boolean;
}

export type GivenRelation =
  /** the same given name once folded */
  | 'same'
  /** a common nickname of it (Bill/William, Liz/Elizabeth) */
  | 'nickname'
  /** related in the vendored nicknames table only (Kit/Christopher; also Ron/Aaron, so weaker) */
  | 'variant'
  /** a short form shared by several names (Alex: Alexander or Alexandra) */
  | 'ambiguous'
  /** one is the other's initial (P./Priya) */
  | 'initial'
  /** one goes by their middle name (J. Robert / Robert) */
  | 'middle'
  /** spelled differently, sounds the same, and the spellings are close (Steven/Stephen) */
  | 'phonetic'
  | 'different';

export type SurnameRelation =
  | 'same'
  /** one surname is part of the other's (García / García Márquez) */
  | 'partial'
  /** sounds the same and the spellings are close, or one letter apart in a long surname (Thomson/Thompson) */
  | 'phonetic'
  /** one side has no surname at all ("Priya") */
  | 'missing'
  | 'different';

export interface NameComparison {
  given: GivenRelation;
  surname: SurnameRelation;
  /** matched with given name and surname swapped ("Wang Wei" / "Wei Wang") */
  swapped: boolean;
  /** 0–1: how strongly the names alone say "one person" (1: the same name; 0.6: an initial; 0: different names) */
  score: number;
}

const NONE: NameComparison = { given: 'different', surname: 'different', swapped: false, score: 0 };

/** Lower-case ASCII letters only: accents, apostrophes, dots and hyphens dropped. */
function foldWord(s: string): string {
  return transliterate(s)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/** Words of a name part: split on spaces and hyphens, folded, empty ones dropped. */
function foldWords(s: string): string[] {
  return transliterate(s)
    .toLowerCase()
    .split(/[\s\-‐–—_]+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter(Boolean);
}

const cache = new Map<string, FoldedName>();

/** Fold a name (as written, or already parsed) for comparison. */
export function foldName(name: string | NameParts | undefined | null): FoldedName {
  // a written name is cached as written (parsing it is the slow part); parsed parts by their fields
  const key =
    typeof name === 'string' || !name
      ? `w\u0000${name ?? ''}`
      : `p\u0000${name.first}\u0000${name.last}\u0000${name.full}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const folded = fold(typeof name === 'string' || !name ? parseName(name) : name);
  if (cache.size > 50_000) cache.clear();
  cache.set(key, folded);
  return folded;
}

function fold(parts: NameParts): FoldedName {
  if (writtenSurnameFirst(parts.full)) {
    // "王伟", "김민준", "王 小明": one syllable per character, the first is the surname, the rest the given name
    const syl = transliterate(parts.full, { syllables: true })
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean);
    if (syl.length < 2)
      return { given: syl[0] ?? '', givenParts: syl, middles: [], surnames: [], eastAsian: true };
    return {
      given: syl.slice(1).join(''),
      givenParts: syl.slice(1),
      middles: [],
      surnames: [syl[0]!],
      eastAsian: true,
    };
  }
  const givenParts = foldWords(parts.first);
  const lastWords = parts.last ? parts.last.split(/\s+/).filter(Boolean) : [];
  const all = parts.full.split(/\s+/).filter(Boolean);
  // the words between the given name and the surname
  const middles =
    all.length > 1 + lastWords.length
      ? all
          .slice(1, all.length - lastWords.length)
          .map(foldWord)
          .filter(Boolean)
      : [];
  const surnameWords = foldWords(parts.last);
  const core = surnameWords.filter((w) => !NAME_PARTICLES.has(w));
  return {
    given: givenParts.join(''),
    givenParts,
    middles,
    surnames: core.length ? core : surnameWords,
    eastAsian: false,
  };
}

/**
 * Usual Latin spellings of Korean and Chinese surnames, keyed by the transliteration of the character (any-ascii's
 * Revised Romanization for Hangul, pinyin for Chinese). Only used when one of the two names is written in Hangul or
 * Chinese characters: "김" is Gim in transliteration and Kim on LinkedIn, "이" is I and Lee, "陳" is Chen and Chan.
 */
const EAST_ASIAN_SURNAMES: Record<string, readonly string[]> = {
  // Korean (Revised Romanization → common spellings)
  gim: ['kim'],
  i: ['lee', 'yi', 'rhee', 'li', 'rhie'],
  bag: ['park', 'pak', 'bak', 'bahk'],
  bak: ['park', 'pak'],
  choe: ['choi', 'choy', 'chey'],
  jeong: ['jung', 'chung', 'jeung', 'cheong'],
  jo: ['cho', 'joe'],
  gang: ['kang'],
  yun: ['yoon', 'youn'],
  jang: ['chang'],
  im: ['lim', 'yim', 'rim'],
  sin: ['shin', 'sheen'],
  o: ['oh'],
  seo: ['suh', 'seoh', 'so'],
  gwon: ['kwon'],
  an: ['ahn'],
  yu: ['yoo', 'you', 'ryu', 'yoo'],
  jeon: ['jun', 'chun', 'chon'],
  go: ['ko', 'koh'],
  mun: ['moon'],
  son: ['sohn'],
  baeg: ['baek', 'paik', 'baik', 'back'],
  heo: ['huh', 'hur', 'her'],
  sim: ['shim'],
  no: ['noh', 'roh'],
  gu: ['koo', 'ku'],
  gwag: ['kwak'],
  seong: ['sung'],
  ju: ['joo', 'chu'],
  u: ['woo', 'wu'],
  ryu: ['ryu', 'yoo', 'yu'],
  jin: ['chin'],
  gil: ['kil'],
  eom: ['um', 'uhm'],
  hyeon: ['hyun'],
  byeon: ['byun'],
  gong: ['kong'],
  // Chinese (pinyin → Cantonese, Wade-Giles and other common spellings)
  chen: ['chan', 'tan', 'chin'],
  zhang: ['chang', 'cheung', 'cheong', 'teo'],
  huang: ['wong', 'hwang', 'ng', 'ooi'],
  wang: ['wong', 'ong'],
  li: ['lee', 'lei', 'lai', 'ly'],
  zhou: ['chow', 'chou', 'chau', 'chew'],
  liu: ['lau', 'lew', 'lowe', 'liew'],
  wu: ['ng', 'woo', 'goh', 'ong'],
  he: ['ho', 'hoh', 'hor'],
  lin: ['lam', 'lim', 'ling'],
  xu: ['hsu', 'tsui', 'hui', 'koh'],
  zheng: ['cheng', 'chang', 'tay', 'teh'],
  guo: ['kwok', 'kuo', 'kok', 'quek'],
  xie: ['tse', 'hsieh', 'chia', 'seah'],
  cai: ['tsai', 'choi', 'chua', 'tsoi'],
  yang: ['yeung', 'yong', 'yeo'],
  liang: ['leung', 'liong', 'neo'],
  luo: ['law', 'lo', 'loh'],
  zhu: ['chu', 'chew', 'choo', 'gee'],
  hu: ['woo', 'hoo', 'oh'],
  gao: ['ko', 'kao', 'koh'],
  ye: ['yip', 'yeh', 'yap'],
  deng: ['tang', 'teng'],
  zeng: ['tsang', 'tseng', 'chan'],
  peng: ['pang', 'phang'],
  cao: ['tsao', 'cho', 'tso'],
  jiang: ['chiang', 'kong', 'keung'],
  su: ['so', 'soh'],
  lu: ['lo', 'lui', 'loo', 'lou'],
  xiao: ['siu', 'hsiao', 'seow'],
  qiu: ['yau', 'chiu', 'khoo'],
  feng: ['fung', 'foong'],
  tang: ['tong', 'teng'],
  du: ['to', 'tu', 'doo'],
  shen: ['shum', 'sham', 'sim'],
  zhao: ['chiu', 'chao', 'chew'],
  sun: ['suen', 'soon'],
  han: ['hon'],
  ma: ['mah'],
  song: ['sung'],
  wei: ['ngai'],
  ou: ['au', 'ow'],
  ouyang: ['auyeung', 'auyang', 'owyang'],
};

function eastAsianSurnamesAgree(a: string, b: string): boolean {
  return a === b || !!EAST_ASIAN_SURNAMES[a]?.includes(b) || !!EAST_ASIAN_SURNAMES[b]?.includes(a);
}

const dmCache = new Map<string, [string, string]>();
function dm(w: string): [string, string] {
  let codes = dmCache.get(w);
  if (!codes) {
    codes = doubleMetaphone(w);
    if (dmCache.size > 20_000) dmCache.clear();
    dmCache.set(w, codes);
  }
  return codes;
}

/**
 * True when two words sound alike (a double metaphone code in common) and are spelled close (Jaro-Winkler ≥ 0.8):
 * the sound alone would join Ellen and Allan.
 */
export function soundsAlike(a: string, b: string): boolean {
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  if (jaroWinkler(a, b) < 0.8) return false;
  const [p1, s1] = dm(a);
  const [p2, s2] = dm(b);
  return !!p1 && (p1 === p2 || p1 === s2 || (!!s1 && (s1 === p2 || s1 === s2)));
}

function compareGiven(x: FoldedName, y: FoldedName): GivenRelation {
  const a = x.given;
  const b = y.given;
  if (!a || !b) return 'different';
  if (a === b) return 'same';
  // "Min Jun" and "Minjun", "Mary Ann" and "Maryann": the given name written in parts
  if (a + x.middles.join('') === b || b + y.middles.join('') === a) return 'same';
  if (a.length === 1 || b.length === 1) {
    const [initial, full] = a.length === 1 ? [a, b] : [b, a];
    if (full.length > 1 && full.startsWith(initial)) return 'initial';
  }
  const rel = firstNameRelation(a, b);
  if (rel === 'nickname') return 'nickname';
  if (rel === 'ambiguous') return 'ambiguous';
  if (isFirstNameVariant(a, b)) return 'variant';
  // "J. Robert Smith" and "Robert Smith": someone who goes by their middle name
  if ((b.length > 1 && x.middles.includes(b)) || (a.length > 1 && y.middles.includes(a))) return 'middle';
  if (soundsAlike(a, b)) return 'phonetic';
  return 'different';
}

function compareSurname(x: FoldedName, y: FoldedName): SurnameRelation {
  if (!x.surnames.length || !y.surnames.length) return 'missing';
  const a = x.surnames.join('');
  const b = y.surnames.join('');
  if (a === b) return 'same';
  if ((x.eastAsian || y.eastAsian) && eastAsianSurnamesAgree(a, b)) return 'same';
  // double surnames: García / García Márquez, Johnson-Miller / Miller (a middle name may hold the other part)
  const inOther = (s: string[], o: FoldedName) =>
    s.every((w) => o.surnames.includes(w) || o.middles.includes(w));
  if (inOther(x.surnames, y) || inOther(y.surnames, x)) return 'partial';
  const la = x.surnames[x.surnames.length - 1]!;
  const lb = y.surnames[y.surnames.length - 1]!;
  if (soundsAlike(la, lb) || soundsAlike(a, b)) return 'phonetic';
  // one letter apart in a long surname (Thomson/Thompson, Johnston/Johnson): a typo or a spelling, never more than
  // a near match
  if (Math.min(a.length, b.length) >= 5 && jaroWinkler(a, b) >= 0.93) return 'phonetic';
  return 'different';
}

/** How much the names alone say, by how the given names and surnames relate. */
const SCORES: Record<SurnameRelation, Partial<Record<GivenRelation, number>>> = {
  same: {
    same: 1,
    nickname: 1,
    variant: 0.8,
    ambiguous: 0.8,
    phonetic: 0.8,
    middle: 0.75,
    initial: 0.6,
  },
  partial: {
    same: 0.85,
    nickname: 0.8,
    variant: 0.65,
    ambiguous: 0.65,
    phonetic: 0.65,
    middle: 0.6,
    initial: 0.5,
  },
  phonetic: {
    same: 0.85,
    nickname: 0.8,
    variant: 0.6,
    ambiguous: 0.6,
    phonetic: 0.6,
    middle: 0.55,
    initial: 0.5,
  },
  // a lone first name ("Priya") is a name, but a weak one
  missing: { same: 0.5, nickname: 0.45 },
  different: {},
};

const runCache = new WeakMap<FoldedName, string[]>();

/** All the words of a name, run together in each order its parts can be written in. */
function runTogether(n: FoldedName): string[] {
  let hit = runCache.get(n);
  if (!hit) {
    hit = permutations(n);
    runCache.set(n, hit);
  }
  return hit;
}

function permutations(n: FoldedName): string[] {
  const parts = [n.given, ...n.middles, n.surnames.join('')].filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return [parts.join('')];
  const out = new Set<string>();
  const permute = (rest: string[], acc: string) => {
    if (!rest.length) out.add(acc);
    for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], acc + rest[i]);
  };
  permute(parts, '');
  return [...out];
}

/** How two names relate (see the module comment). Either side may be written or already folded. */
export function compareNames(
  a: string | NameParts | FoldedName | undefined | null,
  b: string | NameParts | FoldedName | undefined | null,
): NameComparison {
  const x = isFolded(a) ? a : foldName(a);
  const y = isFolded(b) ? b : foldName(b);
  if (!x.given && !x.surnames.length) return NONE;
  if (!y.given && !y.surnames.length) return NONE;
  const given = compareGiven(x, y);
  const surname = compareSurname(x, y);
  const straight = SCORES[surname][given] ?? 0;
  if (straight >= 0.95) return { given, surname, swapped: false, score: straight };
  // written the other way round: "Wang Wei" / "Wei Wang"; strong when one of them was written in CJK or Hangul,
  // where surname first is the rule, weaker between two Latin spellings
  const east = x.eastAsian || y.eastAsian;
  const xs = x.surnames.join('');
  const ys = y.surnames.join('');
  const swappedGiven = !!x.given && !!ys && x.given === ys;
  const swappedSurname =
    !!xs && !!y.given && (xs === y.given || (east && eastAsianSurnamesAgree(xs, y.given)));
  let swapped = swappedGiven && swappedSurname ? (east ? 0.95 : 0.8) : 0;
  // the same letters in another split or order ("Ouyang Nana" / "欧阳娜娜", "Mary Ann Smith" / "Maryann Smith")
  if (!swapped) {
    const ay = new Set(runTogether(y));
    const same = runTogether(x).some((s) => s.length >= 4 && ay.has(s));
    if (same) swapped = east ? 0.9 : 0.8;
  }
  if (swapped > straight) return { given: 'same', surname: 'same', swapped: true, score: swapped };
  return { given, surname, swapped: false, score: straight };
}

function isFolded(v: unknown): v is FoldedName {
  return !!v && typeof v === 'object' && 'givenParts' in v;
}

/**
 * Whether two written names are one name, for looking a person up by name (a LinkedIn chat with no id, a mutual
 * connection, a search result): 'same' (the same name, however it is written: accents, scripts, middle names, a
 * surname in two parts, surname first), 'nickname' (one given name is a nickname of the other's: Bill/William), or
 * undefined. Initials, sound-alikes and shared short forms (Alex) never count here; callers still require that the
 * name points at one person only.
 */
export function nameAgreement(
  a: string | NameParts | undefined | null,
  b: string | NameParts | undefined | null,
): 'same' | 'nickname' | undefined {
  const c = compareNames(a, b);
  if (c.surname !== 'same' && c.surname !== 'partial') return undefined;
  if (c.given === 'same') return 'same';
  if (c.given === 'nickname' || c.given === 'variant') return c.surname === 'same' ? 'nickname' : undefined;
  return undefined;
}

/** The people whose name agrees with `name` (see nameAgreement), exact spellings first. */
export function peopleNamed<T extends { displayName: string }>(
  people: readonly T[],
  name: string | undefined,
): T[] {
  if (!name?.trim()) return [];
  const target = foldName(name);
  const same: T[] = [];
  const nick: T[] = [];
  for (const p of people) {
    const c = compareNames(target, foldName(p.displayName));
    if (c.surname !== 'same' && c.surname !== 'partial') continue;
    if (c.given === 'same') same.push(p);
    else if ((c.given === 'nickname' || c.given === 'variant') && c.surname === 'same') nick.push(p);
  }
  return same.length ? same : nick;
}

/**
 * Whether two given names can be one person's (the same, written in parts, an initial, a nickname, a shared short
 * form, a middle name gone by): the cheap part of `compareNames`, without the sound-alike check, for blocking.
 */
export function givenNamesRelated(x: FoldedName, y: FoldedName): boolean {
  const g = compareGivenCheap(x, y);
  return g !== 'different';
}

function compareGivenCheap(x: FoldedName, y: FoldedName): GivenRelation {
  const a = x.given;
  const b = y.given;
  if (!a || !b) return 'different';
  if (a === b) return 'same';
  if (a[0] !== b[0] && a.length > 1 && b.length > 1 && !x.middles.length && !y.middles.length) {
    // different first letters rule out the same name, an initial and a middle name; only nicknames are left
    const rel = firstNameRelation(a, b);
    if (rel === 'nickname' || rel === 'ambiguous') return rel;
    return isFirstNameVariant(a, b) ? 'variant' : 'different';
  }
  const g = compareGiven(x, y);
  return g === 'phonetic' ? 'different' : g;
}

const keyCache = new Map<FoldedName, string[]>();

/**
 * Keys under which a name is filed for finding look-alikes cheaply (duplicate detection, resolution): its surname,
 * the usual spellings of an East Asian surname, the surname's sound, and its words in sorted order (for names
 * written either way round). Two names that can match share at least one key.
 */
export function nameBlockKeys(n: FoldedName): string[] {
  const hit = keyCache.get(n);
  if (hit) return hit;
  const out = blockKeys(n);
  if (keyCache.size > 50_000) keyCache.clear();
  keyCache.set(n, out);
  return out;
}

function blockKeys(n: FoldedName): string[] {
  const keys = new Set<string>();
  const sur = n.surnames.join('');
  if (sur) {
    keys.add(`s:${sur}`);
    for (const w of n.surnames) keys.add(`s:${w}`);
    const [p] = dm(n.surnames[n.surnames.length - 1]!);
    if (p) keys.add(`d:${p}`);
    if (n.eastAsian) for (const v of EAST_ASIAN_SURNAMES[sur] ?? []) keys.add(`s:${v}`);
  }
  // either way round: "Wang Wei" and "Wei Wang" share this one
  if (n.given && sur) keys.add(`w:${[n.given, sur].sort().join(' ')}`);
  return [...keys];
}
