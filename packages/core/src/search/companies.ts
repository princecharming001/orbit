/**
 * Companies for network search (plan 32 §5.2, §18.6): one key per company, parent edges for brands and subsidiaries,
 * a kind, and the facts Orbit has about it (YC batch, stage, size, industries) from `company_facts`.
 *
 * Matching is on exact keys, never substrings: "Box" is not "Dropbox". Same-entity names (Facebook and Meta) share a
 * key through `normalizeCompany`; a brand or subsidiary keeps its own key and points at its parent, so "people at
 * Meta" includes Instagram (with a chip) and "people at Instagram" never widens to all of Meta.
 */
import { normalizeCompany } from '../text/normalize';
import { canonicalBatch } from './headline';

export const COMPANY_KINDS = [
  'big_tech',
  'startup',
  'bank',
  'vc_firm',
  'consulting',
  'pe',
  'hedge_fund',
  'university',
  'nonprofit',
  'government',
  'student_org',
] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const STAGES = [
  'pre_seed',
  'seed',
  'series_a',
  'series_b_plus',
  'growth',
  'public',
  'acquired',
  'inactive',
] as const;
export type Stage = (typeof STAGES)[number];

/** One row of `company_facts` as the browser receives it. */
export interface CompanyFact {
  key: string;
  name: string;
  formerNames?: string[];
  website?: string;
  linkedinHandle?: string;
  /** canonical batch: W26, S25, F24, X25 */
  ycBatch?: string;
  ycStatus?: 'Active' | 'Inactive' | 'Acquired' | 'Public';
  ycStage?: 'Early' | 'Growth';
  teamSize?: number;
  industries?: string[];
  oneLiner?: string;
  /** the name is an everyday word or a given name ("Here", "Thread", "June"): a bare name match is weak */
  ambiguousName?: boolean;
  parentKey?: string;
  kind?: CompanyKind;
  source: 'yc' | 'bigpicture' | 'curated' | 'linkedin';
  /** facts older than a year are estimates */
  asOf?: string;
  /** from the company's LinkedIn page (plan 33) */
  linkedinId?: string;
  foundedYear?: number;
  /** headcount growth over the last 12 months, in percent */
  growth12m?: number;
  /** a stage the company's own About states, with the words it rests on */
  stage?: Stage;
  stageEvidence?: string;
  /** the company's LinkedIn About, cut short */
  about?: string;
  /** team size is LinkedIn's count of members who list the company (not a payroll number) */
  sizeFromLinkedIn?: boolean;
}

/** Legal suffixes beyond core's list, ported from cleanco (MIT): matched only as the last word. */
const MORE_SUFFIXES = new Set([
  'pvt',
  'private',
  'pty',
  'bv',
  'nv',
  'oy',
  'ab',
  'srl',
  'sas',
  'spa',
  'kk',
  'kg',
  'sarl',
  'sro',
  'ug',
  'pte',
  'sdn',
  'bhd',
  'tbk',
  'ooo',
  'zao',
  'llc',
  'inc',
  'ltda',
  'sa de cv',
  'technologies',
  'technology',
  'labs',
  'hq',
  'ai',
  'io',
  'com',
]);

/** Org fields that name no company: a key of these alone is empty. */
const NO_COMPANY = new Set(
  'inc llc ltd ai labs stealth stealth startup stealth mode self self employed selfemployed freelance freelancer independent confidential various n a na none tbd startup company corp my own business own business'.split(
    ' ',
  ),
);

/** The key two spellings of one company share: "Stripe, Inc." and "stripe" give "stripe"; "Notion Labs" gives "notion". */
export function orgKey(raw: string | undefined | null): string {
  let k = normalizeCompany(raw);
  if (!k || NO_COMPANY.has(k)) return '';
  k = k.replace(/\.(com|ai|io|co|app|dev|xyz|so|gg|org|net)$/, '');
  const parts = k.split(' ');
  while (parts.length > 1 && MORE_SUFFIXES.has(parts[parts.length - 1]!)) parts.pop();
  const key = parts.join(' ');
  return NO_COMPANY.has(key) ? '' : key;
}

/**
 * Whether a company key is an everyday word or a given name, so a bare name match proves little ("Scale", "Here",
 * "June"). The worker computes this for `company_facts` with a 30k-word frequency list (Norvig, MIT) and the given
 * names list; `common` is that set.
 */
export function isAmbiguousKey(key: string, common: ReadonlySet<string>): boolean {
  if (!key) return true;
  if (key.replace(/\s/g, '').length <= 3) return true;
  if (common.has(key)) return true;
  const words = key.split(' ');
  return words.length === 2 && words.every((w) => common.has(w));
}

/** Brands and subsidiaries, keyed by orgKey, pointing at their parent's key. */
const PARENTS: Record<string, string> = {
  instagram: 'meta',
  whatsapp: 'meta',
  oculus: 'meta',
  'reality labs': 'meta',
  youtube: 'google',
  deepmind: 'google',
  'google deepmind': 'google',
  waymo: 'google',
  verily: 'google',
  fitbit: 'google',
  alphabet: 'google',
  slack: 'salesforce',
  tableau: 'salesforce',
  mulesoft: 'salesforce',
  linkedin: 'microsoft',
  github: 'microsoft',
  'microsoft research': 'microsoft',
  'cash app': 'block',
  square: 'block',
  tidal: 'block',
  'amazon web services': 'amazon',
  twitch: 'amazon',
  'whole foods market': 'amazon',
  zappos: 'amazon',
  ring: 'amazon',
  'beats by dre': 'apple',
  tiktok: 'bytedance',
  'merrill lynch': 'bank of america',
  merrill: 'bank of america',
  'bofa securities': 'bank of america',
  'citadel securities': 'citadel',
  'nvidia research': 'nvidia',
  'ibm research': 'ibm',
  'red hat': 'ibm',
  aws: 'amazon',
  gs: 'goldman sachs',
  'marcus by goldman sachs': 'goldman sachs',
  'mckinsey digital': 'mckinsey',
  quantumblack: 'mckinsey',
  'deloitte consulting': 'deloitte',
  'deloitte digital': 'deloitte',
  'pwc strategy&': 'pwc',
  'strategy&': 'pwc',
  'ey parthenon': 'ey',
  kearney: 'kearney',
  'a16z crypto': 'andreessen horowitz',
  a16z: 'andreessen horowitz',
};

export function parentOf(key: string, facts?: ReadonlyMap<string, CompanyFact>): string | undefined {
  return PARENTS[key] ?? facts?.get(key)?.parentKey;
}

/** Every key a company query covers: the company and (when asked) its subsidiaries. */
export function keysFor(name: string, withChildren = true): string[] {
  const k = orgKey(name);
  if (!k) return [];
  const out = new Set([k]);
  if (withChildren) for (const [child, parent] of Object.entries(PARENTS)) if (parent === k) out.add(child);
  return [...out];
}

/** Well-known employers by kind, keyed by orgKey. A heuristic on the name covers the rest. */
const KIND_OF: Record<string, CompanyKind> = {};
const KIND_LISTS: [CompanyKind, string[]][] = [
  [
    'big_tech',
    'google meta apple amazon microsoft netflix nvidia salesforce oracle ibm intel adobe uber airbnb linkedin bytedance tiktok tesla spacex palantir snap pinterest spotify shopify stripe openai anthropic databricks doordash instacart lyft dropbox atlassian coinbase robinhood twitter x cisco qualcomm amd samsung sony tencent alibaba baidu block paypal intuit workday servicenow snowflake'.split(
      ' ',
    ),
  ],
  [
    'bank',
    'jpmorgan chase|goldman sachs|morgan stanley|bank of america|citi|wells fargo|barclays|deutsche bank|ubs|credit suisse|hsbc|bnp paribas|rbc|rbc capital markets|td|td securities|bmo|jefferies|evercore|lazard|centerview|moelis|pjt partners|perella weinberg|guggenheim|houlihan lokey|william blair|piper sandler|raymond james|nomura|mizuho|mufg|santander|capital one|us bank|pnc|truist|state street|bny mellon|charles schwab|fidelity|vanguard|blackrock'.split(
      '|',
    ),
  ],
  [
    'consulting',
    'mckinsey|boston consulting group|bain|deloitte|pwc|ey|kpmg|accenture|oliver wyman|kearney|lek|l e k|roland berger|alixpartners|alvarez & marsal|booz allen hamilton|capgemini|zs|zs associates|huron|guidehouse|fti|cornerstone research|analysis group|charles river associates'.split(
      '|',
    ),
  ],
  [
    'vc_firm',
    'andreessen horowitz|sequoia capital|sequoia|accel|benchmark|greylock|kleiner perkins|lightspeed|index ventures|general catalyst|founders fund|khosla ventures|nea|bessemer venture|insight partners|tiger global|coatue|thrive capital|first round|first round capital|lux capital|8vc|felicis|redpoint|initialized|y combinator|techstars|500 global|sv angel|gv|google ventures|cowboy ventures|floodgate|pear vc|pear|kleiner|ivp|battery ventures|spark capital|union square ventures|craft ventures|neo|south park commons|contrary|dorm room fund|rough draft ventures|a16z'.split(
      '|',
    ),
  ],
  [
    'pe',
    'blackstone|kkr|apollo|carlyle|tpg|bain capital|warburg pincus|vista equity|thoma bravo|silver lake|advent international|hellman & friedman|general atlantic|cvc|eqt|permira|leonard green|clayton dubilier & rice|ares'.split(
      '|',
    ),
  ],
  [
    'hedge_fund',
    'citadel|jane street|two sigma|d e shaw|de shaw|bridgewater|millennium|point72|renaissance technologies|aqr|man group|elliott|tower research|hudson river trading|jump trading|optiver|imc|susquehanna|sig|drw|five rings|virtu|akuna|old mission|radix|xtx|squarepoint|balyasny|schonfeld'.split(
      '|',
    ),
  ],
  [
    'government',
    'nasa|nih|nsf|cdc|fbi|cia|nsa|darpa|department of defense|us army|us navy|us air force|white house|state department|federal reserve|sec|ftc|fda'.split(
      '|',
    ),
  ],
  [
    'nonprofit',
    'teach for america|peace corps|red cross|unicef|world bank|imf|gates foundation|wikimedia|mozilla|khan academy'.split(
      '|',
    ),
  ],
];
for (const [kind, names] of KIND_LISTS) for (const n of names) KIND_OF[orgKey(n)] ??= kind;

const KIND_WORDS: [CompanyKind, RegExp][] = [
  [
    'student_org',
    /\b(club|society|association|chapter|fraternity|sorority|hackers|hackathon|council|student government|asuc|ambassadors?|initiative|consulting group at|investment club)\b/,
  ],
  ['university', /\b(university|college|institute of technology|school of|polytechnic|academy)\b/],
  ['vc_firm', /\b(ventures?|vc|venture partners|capital partners|seed fund|angels?)\b/],
  ['pe', /\b(private equity|equity partners)\b/],
  ['hedge_fund', /\b(capital management|asset management|trading|quantitative|securities llc)\b/],
  ['bank', /\b(bank|banking|bancorp|credit union|financial group)\b/],
  ['consulting', /\b(consulting|consultants|advisory|advisors)\b/],
  [
    'government',
    /\b(department of|ministry of|city of|county of|state of|us army|government|federal|national laboratory|national lab)\b/,
  ],
  ['nonprofit', /\b(foundation|non ?profit|charity|ngo|alliance for)\b/],
];

/** The kind of an organization, from the curated lists, its facts, or words in its name. */
export function kindOfOrg(name: string | undefined, fact?: CompanyFact): CompanyKind | undefined {
  const key = orgKey(name);
  if (!key) return undefined;
  if (fact?.kind) return fact.kind;
  const listed = KIND_OF[key] ?? (PARENTS[key] ? KIND_OF[PARENTS[key]!] : undefined);
  if (listed) return listed;
  const t = ` ${(name ?? '').toLowerCase()} `;
  for (const [kind, re] of KIND_WORDS) if (re.test(t)) return kind;
  if (fact?.ycBatch) return 'startup';
  if (fact?.teamSize !== undefined && fact.teamSize <= 200) return 'startup';
  return undefined;
}

export interface StageRead {
  stage: Stage;
  /** derived from team size, not stated anywhere: caps a match at Likely */
  estimated: boolean;
  /** the words a stated stage rests on */
  evidence?: string;
}

/** The stage Orbit can say for a company: stated (acquired, public, YC growth) or estimated from team size. */
export function stageOf(fact: CompanyFact | undefined): StageRead | undefined {
  if (!fact) return undefined;
  // the company's own About says it ("our Series B")
  if (fact.stage) return { stage: fact.stage, estimated: false, evidence: fact.stageEvidence };
  if (fact.ycStatus === 'Acquired') return { stage: 'acquired', estimated: false };
  if (fact.ycStatus === 'Public') return { stage: 'public', estimated: false };
  if (fact.ycStatus === 'Inactive') return { stage: 'inactive', estimated: false };
  if (fact.ycStage === 'Growth') return { stage: 'growth', estimated: false };
  const n = fact.teamSize;
  if (n === undefined) return fact.ycStage === 'Early' ? { stage: 'seed', estimated: true } : undefined;
  if (n <= 3) return { stage: 'pre_seed', estimated: true };
  if (n <= 15) return { stage: 'seed', estimated: true };
  if (n <= 60) return { stage: 'series_a', estimated: true };
  if (n <= 500) return { stage: 'series_b_plus', estimated: true };
  return { stage: 'growth', estimated: true };
}

/** yc-oss writes "Winter 2026"; Orbit uses "W26". */
export function ycBatchOf(raw: string | undefined): string | undefined {
  if (!raw || raw === 'Unspecified') return undefined;
  return canonicalBatch(raw);
}

/** Batches as a student says them: "W26", "winter 26", "the latest batch" is resolved by the caller. */
export function batchesFrom(words: readonly string[]): string[] {
  return [...new Set(words.map((w) => canonicalBatch(w)).filter((b): b is string => !!b))];
}

export interface FactsIndex {
  byKey: ReadonlyMap<string, CompanyFact>;
  /** former names and websites to the current key */
  alias: ReadonlyMap<string, string>;
  /** companies by their LinkedIn id (plan 33): a person's job names its page exactly */
  byLinkedinId?: ReadonlyMap<string, CompanyFact>;
}

export function buildFactsIndex(facts: readonly CompanyFact[]): FactsIndex {
  const byKey = new Map<string, CompanyFact>();
  const alias = new Map<string, string>();
  const byLinkedinId = new Map<string, CompanyFact>();
  const clash = new Set<string>();
  // LinkedIn pages last: each is laid over the directory row it is the same company as
  const ordered = [...facts].sort(
    (a, b) => Number(a.source === 'linkedin') - Number(b.source === 'linkedin'),
  );
  for (const f of ordered) {
    const prev = byKey.get(f.key);
    if (f.source === 'linkedin') {
      if (f.linkedinId) byLinkedinId.set(f.linkedinId, f);
      if (prev && prev.source !== 'linkedin') {
        // the same company when the websites or LinkedIn handles agree; otherwise two companies sharing a name, and
        // the directory row keeps the name (the page is still found by its LinkedIn id)
        if (sameCompany(prev, f)) {
          const merged = layLinkedIn(prev, f);
          byKey.set(f.key, merged);
          if (f.linkedinId) byLinkedinId.set(f.linkedinId, merged);
        }
        continue;
      }
      if (prev && prev.source === 'linkedin' && prev.linkedinId !== f.linkedinId && !sameCompany(prev, f))
        clash.add(f.key);
      if (!prev) byKey.set(f.key, f);
    } else {
      // two YC companies with one key ("Clear", "Clear"): keep neither as a bare-name match
      if (prev && prev.source === 'yc' && f.source === 'yc' && prev.name !== f.name) clash.add(f.key);
      if (!prev || rankSource(f.source) > rankSource(prev.source)) byKey.set(f.key, { ...prev, ...f });
    }
    for (const n of f.formerNames ?? []) {
      const k = orgKey(n);
      if (k && k !== f.key && !alias.has(k)) alias.set(k, f.key);
    }
    const host = domainKey(f.website);
    if (host && !alias.has(`@${host}`)) alias.set(`@${host}`, f.key);
  }
  for (const k of clash) {
    const f = byKey.get(k);
    if (f) byKey.set(k, { ...f, ambiguousName: true });
  }
  return { byKey, alias, byLinkedinId };
}

function sameCompany(a: CompanyFact, b: CompanyFact): boolean {
  const da = domainKey(a.website)?.replace(/^www\./, '');
  const db = domainKey(b.website)?.replace(/^www\./, '');
  if (da && db) return da === db;
  if (a.linkedinHandle && b.linkedinHandle)
    return a.linkedinHandle.toLowerCase() === b.linkedinHandle.toLowerCase();
  // no website on one side: the same name is taken as the same company only when neither is ambiguous
  return !a.ambiguousName && !b.ambiguousName && a.name.toLowerCase() === b.name.toLowerCase();
}

/** A directory row with what its LinkedIn page adds: current headcount, founding year, growth, a stated stage. */
function layLinkedIn(dir: CompanyFact, li: CompanyFact): CompanyFact {
  return {
    ...dir,
    linkedinId: li.linkedinId ?? dir.linkedinId,
    linkedinHandle: dir.linkedinHandle ?? li.linkedinHandle,
    website: dir.website ?? li.website,
    teamSize: li.teamSize ?? dir.teamSize,
    sizeFromLinkedIn: li.teamSize !== undefined || dir.sizeFromLinkedIn,
    foundedYear: li.foundedYear ?? dir.foundedYear,
    growth12m: li.growth12m ?? dir.growth12m,
    stage: li.stage ?? dir.stage,
    stageEvidence: li.stage ? li.stageEvidence : dir.stageEvidence,
    about: li.about ?? dir.about,
    industries: dir.industries?.length ? dir.industries : li.industries,
    kind: dir.kind ?? li.kind,
  };
}

function rankSource(s: CompanyFact['source']): number {
  return s === 'yc' ? 4 : s === 'curated' ? 3 : s === 'linkedin' ? 2 : 1;
}

/** "https://www.knowlify.ai/x" gives "knowlify.ai". */
export function domainKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#:]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase();
}

export type Confidence = 'strong' | 'medium' | 'weak';

export interface FactMatch {
  fact: CompanyFact;
  confidence: Confidence;
  /** why: 'badge' (headline says YC and the batch agrees), 'domain', 'name', 'former_name' */
  basis: 'badge' | 'domain' | 'name' | 'former_name' | 'linkedin';
}

/**
 * The company facts for an org a person names. A YC company is strong when the headline's own YC badge agrees with
 * the batch (or the person's email domain is the company's), medium on an exact distinctive name, weak on an
 * everyday-word name with nothing else to go on ("Here", "Thread").
 */
export function matchFacts(
  org: string | undefined,
  index: FactsIndex,
  evidence: {
    badgeBatch?: string;
    saysYc?: boolean;
    emailDomains?: readonly string[];
    /** the company's LinkedIn id from the person's own profile: names the page exactly */
    linkedinId?: string;
  } = {},
): FactMatch | undefined {
  const byId = evidence.linkedinId ? index.byLinkedinId?.get(evidence.linkedinId) : undefined;
  if (byId) return { fact: byId, confidence: 'strong', basis: 'linkedin' };
  const key = orgKey(org);
  for (const d of evidence.emailDomains ?? []) {
    const viaDomain = index.alias.get(`@${d}`);
    const f = viaDomain ? index.byKey.get(viaDomain) : undefined;
    if (f && (!key || f.key === key || orgKey(f.name) === key))
      return { fact: f, confidence: 'strong', basis: 'domain' };
  }
  if (!key) return undefined;
  let basis: FactMatch['basis'] = 'name';
  let fact = index.byKey.get(key);
  if (!fact) {
    // a former name is too easy to collide with ("Motion" was once Ashby's name): only with the person's own YC badge
    if (!evidence.saysYc) return undefined;
    const k = index.alias.get(key);
    fact = k ? index.byKey.get(k) : undefined;
    basis = 'former_name';
  }
  if (!fact) return undefined;
  // a famous employer that shares a name with a small YC company ("Meta", S13) is the famous one unless a badge says otherwise
  if (fact.source === 'yc' && KIND_OF[key] && (fact.teamSize ?? 0) < 500 && !evidence.saysYc)
    return undefined;
  if (fact.ycBatch && evidence.badgeBatch && evidence.badgeBatch === fact.ycBatch)
    return { fact, confidence: 'strong', basis: 'badge' };
  if (fact.ycBatch && evidence.badgeBatch && evidence.badgeBatch !== fact.ycBatch)
    // the person's badge names another batch: a different company with the same name
    return { fact, confidence: 'weak', basis };
  if (fact.ycBatch && evidence.saysYc)
    return { fact, confidence: fact.ambiguousName ? 'medium' : 'strong', basis };
  const short = key.replace(/\s/g, '').length <= 3;
  if ((fact.teamSize ?? 0) >= 500) return { fact, confidence: 'medium', basis };
  return { fact, confidence: fact.ambiguousName || short ? 'weak' : 'medium', basis };
}

/** Words students use for industries, mapped to the tags and words a company's facts and headlines use. */
export const INDUSTRY_WORDS: Record<string, string[]> = {
  fintech: [
    'fintech',
    'payments',
    'banking',
    'lending',
    'insurance',
    'insurtech',
    'neobank',
    'credit',
    'finance',
  ],
  ai: [
    'ai',
    'artificial intelligence',
    'machine learning',
    'ml',
    'llm',
    'generative ai',
    'agents',
    'ai agents',
    'nlp',
    'computer vision',
  ],
  climate: [
    'climate',
    'climate tech',
    'clean energy',
    'renewable',
    'solar',
    'carbon',
    'energy',
    'sustainability',
    'battery',
    'ev',
  ],
  health: [
    'health',
    'healthcare',
    'health tech',
    'digital health',
    'medical',
    'medtech',
    'telehealth',
    'clinic',
  ],
  bio: ['biotech', 'bio', 'biology', 'drug discovery', 'therapeutics', 'genomics', 'life sciences'],
  crypto: ['crypto', 'web3', 'blockchain', 'defi', 'ethereum', 'bitcoin', 'solana'],
  devtools: [
    'developer tools',
    'devtools',
    'infrastructure',
    'api',
    'open source',
    'devops',
    'observability',
  ],
  edtech: ['edtech', 'education', 'learning', 'tutoring'],
  consumer: ['consumer', 'social', 'marketplace', 'e commerce', 'ecommerce', 'retail', 'd2c'],
  enterprise: ['b2b', 'saas', 'enterprise', 'productivity', 'sales', 'hr tech', 'legal tech'],
  hardware: [
    'hardware',
    'robotics',
    'hard tech',
    'manufacturing',
    'semiconductors',
    'drones',
    'aerospace',
    'space',
  ],
  security: ['security', 'cybersecurity', 'infosec', 'identity', 'fraud'],
  defense: ['defense', 'defence', 'national security', 'govtech', 'dual use'],
  gaming: ['gaming', 'games', 'esports'],
  realestate: ['real estate', 'proptech', 'construction'],
  media: ['media', 'creator economy', 'content', 'entertainment', 'music'],
};

/** All the words an industry ask covers: "fintech" gives payments, lending, insurance and the rest. */
export function industryTerms(words: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of words) {
    const w = raw.toLowerCase().trim();
    if (!w) continue;
    out.add(w);
    for (const [k, list] of Object.entries(INDUSTRY_WORDS))
      if (k === w || list.includes(w)) for (const t of list) out.add(t);
  }
  return [...out];
}
