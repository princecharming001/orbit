import { PERSONAL_EMAIL_DOMAINS } from '../entity/resolve';
import { normalizeCompany, stripDiacritics } from './normalize';
import { SUB_SCHOOLS, UNIVERSITIES } from './universities';

/**
 * The web domain of a company, for its logo. Orbit rarely stores one, so it is found from what it has: a domain on
 * the organisation, a list of the companies students aim for most, the universities and their schools
 * (universities.ts), a work address of someone there, and for a one-word name its .com. Returns undefined when none
 * of those gives a confident answer.
 */
const KNOWN: Record<string, string> = {
  // tech
  google: 'google.com',
  alphabet: 'abc.xyz',
  meta: 'meta.com',
  apple: 'apple.com',
  amazon: 'amazon.com',
  'amazon web services': 'aws.amazon.com',
  aws: 'aws.amazon.com',
  microsoft: 'microsoft.com',
  netflix: 'netflix.com',
  nvidia: 'nvidia.com',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  stripe: 'stripe.com',
  figma: 'figma.com',
  notion: 'notion.so',
  linear: 'linear.app',
  ramp: 'ramp.com',
  vercel: 'vercel.com',
  datadog: 'datadoghq.com',
  airbnb: 'airbnb.com',
  uber: 'uber.com',
  lyft: 'lyft.com',
  doordash: 'doordash.com',
  instacart: 'instacart.com',
  shopify: 'shopify.com',
  salesforce: 'salesforce.com',
  oracle: 'oracle.com',
  ibm: 'ibm.com',
  intel: 'intel.com',
  amd: 'amd.com',
  adobe: 'adobe.com',
  atlassian: 'atlassian.com',
  slack: 'slack.com',
  dropbox: 'dropbox.com',
  snowflake: 'snowflake.com',
  databricks: 'databricks.com',
  palantir: 'palantir.com',
  scale: 'scale.com',
  'scale ai': 'scale.com',
  plaid: 'plaid.com',
  brex: 'brex.com',
  robinhood: 'robinhood.com',
  coinbase: 'coinbase.com',
  square: 'squareup.com',
  block: 'block.xyz',
  spotify: 'spotify.com',
  pinterest: 'pinterest.com',
  snap: 'snap.com',
  'snap inc': 'snap.com',
  linkedin: 'linkedin.com',
  twitter: 'x.com',
  x: 'x.com',
  tesla: 'tesla.com',
  spacex: 'spacex.com',
  github: 'github.com',
  gitlab: 'gitlab.com',
  cloudflare: 'cloudflare.com',
  twilio: 'twilio.com',
  hubspot: 'hubspot.com',
  asana: 'asana.com',
  canva: 'canva.com',
  duolingo: 'duolingo.com',
  discord: 'discord.com',
  reddit: 'reddit.com',
  roblox: 'roblox.com',
  zoom: 'zoom.us',
  retool: 'retool.com',
  rippling: 'rippling.com',
  gusto: 'gusto.com',
  deel: 'deel.com',
  mercury: 'mercury.com',
  airtable: 'airtable.com',
  webflow: 'webflow.com',
  replit: 'replit.com',
  cursor: 'cursor.com',
  anysphere: 'cursor.com',
  perplexity: 'perplexity.ai',
  'hugging face': 'huggingface.co',
  cohere: 'cohere.com',
  mistral: 'mistral.ai',
  'mistral ai': 'mistral.ai',
  'character ai': 'character.ai',
  waymo: 'waymo.com',
  deepmind: 'deepmind.google',
  'google deepmind': 'deepmind.google',
  bytedance: 'bytedance.com',
  tiktok: 'tiktok.com',
  // finance
  'goldman sachs': 'goldmansachs.com',
  'morgan stanley': 'morganstanley.com',
  'jp morgan': 'jpmorganchase.com',
  'jpmorgan chase': 'jpmorganchase.com',
  jpmorgan: 'jpmorganchase.com',
  'bank of america': 'bankofamerica.com',
  citi: 'citi.com',
  'wells fargo': 'wellsfargo.com',
  blackrock: 'blackrock.com',
  blackstone: 'blackstone.com',
  kkr: 'kkr.com',
  carlyle: 'carlyle.com',
  citadel: 'citadel.com',
  'citadel securities': 'citadelsecurities.com',
  'jane street': 'janestreet.com',
  'two sigma': 'twosigma.com',
  'd e shaw': 'deshaw.com',
  'de shaw': 'deshaw.com',
  'hudson river trading': 'hudsonrivertrading.com',
  'jump trading': 'jumptrading.com',
  optiver: 'optiver.com',
  'imc trading': 'imc.com',
  imc: 'imc.com',
  sig: 'sig.com',
  'susquehanna international group': 'sig.com',
  bridgewater: 'bridgewater.com',
  'bridgewater associates': 'bridgewater.com',
  evercore: 'evercore.com',
  lazard: 'lazard.com',
  'centerview partners': 'centerviewpartners.com',
  'pjt partners': 'pjtpartners.com',
  moelis: 'moelis.com',
  'moelis & company': 'moelis.com',
  barclays: 'barclays.com',
  ubs: 'ubs.com',
  'deutsche bank': 'db.com',
  'credit suisse': 'credit-suisse.com',
  fidelity: 'fidelity.com',
  'fidelity investments': 'fidelity.com',
  vanguard: 'vanguard.com',
  visa: 'visa.com',
  mastercard: 'mastercard.com',
  'american express': 'americanexpress.com',
  amex: 'americanexpress.com',
  paypal: 'paypal.com',
  'capital one': 'capitalone.com',
  // venture
  'andreessen horowitz': 'a16z.com',
  a16z: 'a16z.com',
  sequoia: 'sequoiacap.com',
  'sequoia capital': 'sequoiacap.com',
  'y combinator': 'ycombinator.com',
  accel: 'accel.com',
  benchmark: 'benchmark.com',
  'kleiner perkins': 'kleinerperkins.com',
  greylock: 'greylock.com',
  'lightspeed venture partners': 'lsvp.com',
  'general catalyst': 'generalcatalyst.com',
  'index ventures': 'indexventures.com',
  'founders fund': 'foundersfund.com',
  // consulting
  mckinsey: 'mckinsey.com',
  'mckinsey & company': 'mckinsey.com',
  bain: 'bain.com',
  'bain & company': 'bain.com',
  'boston consulting group': 'bcg.com',
  bcg: 'bcg.com',
  deloitte: 'deloitte.com',
  pwc: 'pwc.com',
  pricewaterhousecoopers: 'pwc.com',
  ey: 'ey.com',
  'ernst & young': 'ey.com',
  kpmg: 'kpmg.com',
  accenture: 'accenture.com',
  'oliver wyman': 'oliverwyman.com',
  'l e k consulting': 'lek.com',
  'lek consulting': 'lek.com',
  // other
  disney: 'disney.com',
  'the walt disney company': 'disney.com',
  nike: 'nike.com',
  'procter & gamble': 'pg.com',
  'p&g': 'pg.com',
  pepsico: 'pepsico.com',
  'coca cola': 'coca-colacompany.com',
  'johnson & johnson': 'jnj.com',
  pfizer: 'pfizer.com',
  boeing: 'boeing.com',
  'lockheed martin': 'lockheedmartin.com',
  walmart: 'walmart.com',
  target: 'target.com',
  'teach for america': 'teachforamerica.org',
};

/** A host as a domain: no scheme, no www, no path. */
function bare(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

/** The list keyed the way Orbit keys companies, so "McKinsey & Company" and "McKinsey" find the same entry. */
const BY_NAME = new Map(Object.entries(KNOWN).map(([k, v]) => [normalizeCompany(k), v]));

const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// ---- schools -----------------------------------------------------------------------------------------------------

/** A school name folded for lookup: "U.C. Berkeley", "UC-Berkeley" and "The University of Texas at Austin" alike. */
function schoolFold(raw: string): string {
  return stripDiacritics(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ at /g, ' ')
    .replace(/ main campus$/, '');
}

const indexNames = (rows: [string, ...string[]][]) => {
  const m = new Map<string, string>();
  for (const [domain, ...names] of rows) for (const n of names) m.set(schoolFold(n), domain);
  return m;
};
const UNIVERSITY = indexNames(UNIVERSITIES);
const SUB_SCHOOL = indexNames(SUB_SCHOOLS);
/** The schools named with two words or more, which can be found inside a longer name. */
const SUB_PHRASES = [...SUB_SCHOOL.entries()].filter(([k]) => k.includes(' '));
/** The full name of a university (not a short form like "Columbia" or "Duke", which also name companies). */
const FULL_UNIVERSITY = new Set(
  UNIVERSITIES.flatMap(([, ...names]) => names.map(schoolFold)).filter((k) =>
    /\b(university|college|institute|school)\b/.test(k),
  ),
);
/** Words that say a name is a part of a university: its school, college, department or lab. */
const SCHOOL_PART =
  /\b(school|college|business|law|engineering|medicine|medical|management|graduate|sciences?|arts|institute|department|dept|faculty|program|center|centre|lab|laboratory|eecs|mba|health|nursing|design|policy|public)\b/;

/** What follows a university's name when the thing is not the university: its press, its credit union. */
const NOT_THE_SCHOOL = /\b(press|publishing|publishers|credit union|bookstore|bookshop)\b/;

/** Where the separators in "Haas School of Business, UC Berkeley" or "School of Law at Duke" split a name. */
const SEPARATOR = /\s+[-–—|@]\s+|,\s+|\s+at\s+|\s*\(\s*|\s*\)\s*/i;

const schoolCache = new Map<string, string | undefined>();

/**
 * The domain of a university or one of its schools, from the name as people write it: the full name or a short form
 * ("UIUC", "UT Austin"), a school of it ("NYU Stern", "Stanford GSB", "Haas School of Business, UC Berkeley"), or a
 * part of it named after the university ("Stanford School of Medicine", "School of Engineering at Tufts University").
 * A school with its own site wins over its university. Undefined when the name is not a school Orbit knows.
 */
export function schoolDomain(name: string | undefined): string | undefined {
  if (!name?.trim()) return undefined;
  if (schoolCache.has(name)) return schoolCache.get(name);
  const found = findSchool(name);
  schoolCache.set(name, found);
  return found;
}

function findSchool(name: string): string | undefined {
  const k = schoolFold(name);
  if (!k) return undefined;
  const exact = SUB_SCHOOL.get(k) ?? UNIVERSITY.get(k);
  if (exact) return exact;
  // "UC Berkeley, Haas School of Business": a school among the parts first, then the university
  const parts = name
    .split(SEPARATOR)
    .map(schoolFold)
    .filter((p) => p && p !== k);
  for (const p of parts) if (SUB_SCHOOL.has(p)) return SUB_SCHOOL.get(p);
  // "University of Michigan Stephen M. Ross School of Business": a school named inside a longer name
  const padded = ` ${k} `;
  for (const [phrase, domain] of SUB_PHRASES) if (padded.includes(` ${phrase} `)) return domain;
  if (parts.length > 1) for (const p of parts) if (UNIVERSITY.has(p)) return UNIVERSITY.get(p);
  // "Stanford School of Medicine" (the university, then a part of it) and "School of Engineering of the University
  // of Pennsylvania" (a part, then the university)
  const words = k.split(' ');
  for (let i = words.length - 1; i >= 1; i--) {
    const head = words.slice(0, i).join(' ');
    const rest = words.slice(i).join(' ');
    const domain = UNIVERSITY.get(head);
    // a short form is a school only with a word that says so ("Columbia Sportswear" is not Columbia University);
    // a full name takes any part after it ("Boston University Questrom") except its press or its credit union
    if (domain && !NOT_THE_SCHOOL.test(rest) && (SCHOOL_PART.test(rest) || FULL_UNIVERSITY.has(head)))
      return domain;
  }
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    const rest = words
      .slice(i)
      .join(' ')
      .replace(/^((of|in)\s+)?(the\s+)?/, '');
    const domain = UNIVERSITY.get(rest);
    if (domain && SCHOOL_PART.test(head)) return domain;
  }
  return undefined;
}

// ---- the domain --------------------------------------------------------------------------------------------------

export function companyDomain(
  name: string | undefined,
  hints: { domains?: string[]; emails?: (string | undefined)[] } = {},
): string | undefined {
  for (const d of hints.domains ?? []) {
    const b = bare(d);
    if (DOMAIN.test(b)) return b;
  }
  const norm = normalizeCompany(name);
  if (norm && BY_NAME.has(norm)) return BY_NAME.get(norm);
  const school = schoolDomain(name);
  if (school) return school;
  // a work address (not a free mailbox, not a school) names the employer's domain
  for (const e of hints.emails ?? []) {
    const d = e?.split('@')[1]?.toLowerCase().trim();
    if (d && DOMAIN.test(d) && !PERSONAL_EMAIL_DOMAINS.has(d) && !d.endsWith('.edu')) return d;
  }
  if (!norm) return undefined;
  // a one-word name is usually its own .com ("Ramp", "Figma"); longer names are too often wrong to guess
  if (/^[a-z0-9]{3,}$/.test(norm)) return `${norm}.com`;
  return undefined;
}

// ---- the logo image ----------------------------------------------------------------------------------------------

/** The logo image for a domain: the site's own icon, from DuckDuckGo's icon service. */
export function companyLogoUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

export type LogoSourceKind = 'duckduckgo' | 'google' | 'touch' | 'favicon';

export interface LogoSource {
  kind: LogoSourceKind;
  url: string;
}

/**
 * Where a domain's logo is looked for, in order: DuckDuckGo's icon service, Google's (larger icons, 128 px when the
 * site has one), then the site's own touch icon and favicon. The two services answer a site they have no icon for
 * with a stand-in picture rather than an error, so each answer is judged by its size (judgeLogo) before it is shown.
 */
export function logoSources(domain: string): LogoSource[] {
  const d = encodeURIComponent(bare(domain));
  return [
    { kind: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${d}.ico` },
    { kind: 'google', url: `https://www.google.com/s2/favicons?domain=${d}&sz=128` },
    { kind: 'touch', url: `https://${d}/apple-touch-icon.png` },
    { kind: 'favicon', url: `https://${d}/favicon.ico` },
  ];
}

/** DuckDuckGo's stand-in for a site without an icon: a grey circle with an arrow, 48 by 48. */
export const DUCKDUCKGO_PLACEHOLDER = { width: 48, height: 48 } as const;

/**
 * What a loaded logo image is worth, from its natural size: `ok` to show, `weak` (a real but tiny icon, shown only
 * when nothing better turns up) or `missing` (a stand-in picture, or nothing). DuckDuckGo's stand-in is 48 by 48 and
 * Google's is a 16 px globe; neither says so any other way a page can read. A real 48 px icon from DuckDuckGo is
 * found again from Google or the site itself.
 */
export function judgeLogo(kind: LogoSourceKind, width: number, height: number): 'ok' | 'weak' | 'missing' {
  if (!width || !height) return 'missing';
  if (kind === 'duckduckgo') {
    if (width === DUCKDUCKGO_PLACEHOLDER.width && height === DUCKDUCKGO_PLACEHOLDER.height) return 'missing';
    return Math.max(width, height) <= 16 ? 'weak' : 'ok';
  }
  if (kind === 'google' || kind === 'touch') return Math.max(width, height) <= 16 ? 'missing' : 'ok';
  return 'ok';
}

/** A company's initials for a tile when no logo is found: "Blue Harbor Partners" is BH, "Datadog" is D. */
export function companyInitials(name: string | undefined, max = 2): string {
  const words = stripDiacritics(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s\-–—/,&+.]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);
  const STOP = new Set(['the', 'of', 'and', 'at', 'for', 'in', 'a', 'inc', 'llc', 'ltd', 'co', 'corp']);
  const kept = words.filter((w) => !STOP.has(w.toLowerCase()));
  const use = kept.length ? kept : words;
  // the first letter of each of the first words that matter ("NYU Stern" is NS, "University of Chicago" UC)
  return use
    .slice(0, max)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
