/**
 * Research guards that run in code, not only in the prompt (§5.4, §5.5, §14.6): identity matching for web results,
 * the "appears to be in high school" stop, and removal of anything touching a sensitive category.
 */

/** Lowercase, accents stripped, whitespace collapsed. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const ORG_SUFFIX = /[,.]?\s+(inc|inc\.|llc|ltd|ltd\.|corp|corporation|co|gmbh|plc|sa|ag)\.?$/i;

/** An org name for matching: normalized, legal suffix removed. */
export function normOrg(s: string | null | undefined): string {
  return norm(s).replace(ORG_SUFFIX, '').trim();
}

const PUBLIC_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

/** Work email domains from the person's addresses (public mail providers prove nothing about identity). */
export function workDomains(emails: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const e of emails ?? []) {
    const d = norm(e.split('@')[1]);
    if (d && !PUBLIC_MAIL.has(d)) out.add(d);
  }
  return [...out];
}

export interface IdentityAnchors {
  fullName: string;
  /** any one of these must also appear */
  anchors: string[];
}

/** §5.2 step 4: the page text contains the full name and (the org, the LinkedIn slug, or a known email domain). */
export function passesIdentity(text: string, a: IdentityAnchors): boolean {
  const t = norm(text);
  if (!a.fullName || !t.includes(norm(a.fullName))) return false;
  return a.anchors.some((x) => x.length >= 2 && t.includes(x));
}

/** The org a people-search page title names, e.g. "Jane Doe - Partner at Acme | LinkedIn" → "Acme". */
export function orgFromTitle(title: string | null | undefined, name: string): string | undefined {
  if (!title) return undefined;
  const cleaned = title.replace(/\s*[|·]\s*linkedin.*$/i, '').trim();
  const parts = cleaned
    .split(/\s+[-–—|·]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && norm(p) !== norm(name));
  for (const p of parts) {
    const at = p.match(/\b(?:at|@)\s+(.+)$/i);
    if (at) return at[1]!.trim();
  }
  return parts.length >= 2 ? parts[parts.length - 1] : parts[0];
}

const HS_PHRASE =
  /\b(high[- ]school|secondary school)\s+(student|junior|senior|sophomore|freshman)\b|\b(student|junior|senior|sophomore|freshman)\s+(at|in)\s+[\w .'-]{0,40}\bhigh[- ]school\b|\b(9th|10th|11th|12th)[- ]grader?\b/i;

/** §5.5 minors: the person appears to be in high school (headline, title, current schooling or a profile page). */
export function appearsMinor(input: {
  title?: string;
  headline?: string | null;
  education?: { school?: string | null; end?: unknown }[] | null;
  profileTexts?: string[];
  year: number;
}): boolean {
  if (HS_PHRASE.test(input.title ?? '') || HS_PHRASE.test(input.headline ?? '')) return true;
  for (const e of input.education ?? []) {
    if (!/\bhigh[- ]school\b|\bsecondary school\b/i.test(e.school ?? '')) continue;
    const end = yearOf(e.end);
    if (end === undefined || end >= input.year) return true;
  }
  return (input.profileTexts ?? []).some((t) => HS_PHRASE.test(t));
}

function yearOf(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v > 3000 ? new Date(v).getUTCFullYear() : v;
  if (typeof v === 'string') {
    const m = v.match(/(19|20)\d\d/);
    return m ? Number(m[0]) : undefined;
  }
  if (typeof v === 'object') {
    const y = (v as { year?: unknown }).year;
    return typeof y === 'number' ? y : undefined;
  }
  return undefined;
}

// ---- sources research never reads ------------------------------------------------------------------------------

/**
 * Sites research never reads or cites (docs/plan/20 §5): people-search and background-check sites, property records,
 * political donations, court records, crowdfunding, obituaries and personal social accounts. A subdomain of any of
 * them is blocked too. The same list goes to the web search provider as `excludeDomains` / `blocked_domains`.
 */
export const BLOCKED_SOURCE_DOMAINS: readonly string[] = [
  // people search and background checks
  'spokeo.com',
  'whitepages.com',
  'beenverified.com',
  'truepeoplesearch.com',
  'fastpeoplesearch.com',
  'radaris.com',
  'intelius.com',
  'peoplefinders.com',
  'mylife.com',
  'instantcheckmate.com',
  'truthfinder.com',
  'thatsthem.com',
  'ussearch.com',
  'peekyou.com',
  'zabasearch.com',
  'clustrmaps.com',
  'nuwber.com',
  'familytreenow.com',
  'publicrecordsnow.com',
  'peoplelooker.com',
  'searchpeoplefree.com',
  'idcrawl.com',
  // property
  'zillow.com',
  'redfin.com',
  'realtor.com',
  'trulia.com',
  'propertyshark.com',
  'blockshopper.com',
  // political donations
  'fec.gov',
  'opensecrets.org',
  'followthemoney.org',
  'campaignmoney.com',
  // court records
  'unicourt.com',
  'courtlistener.com',
  'judyrecords.com',
  'pacermonitor.com',
  'casetext.com',
  'trellis.law',
  'plainsite.org',
  'dockets.justia.com',
  'law.justia.com',
  'arrests.org',
  'mugshots.com',
  // crowdfunding
  'gofundme.com',
  'givesendgo.com',
  'fundly.com',
  'ketto.org',
  // obituaries
  'legacy.com',
  'obittree.com',
  'tributearchive.com',
  'echovita.com',
  'dignitymemorial.com',
  'everloved.com',
  // personal social accounts
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'snapchat.com',
  'pinterest.com',
  'reddit.com',
  'tumblr.com',
  'vk.com',
  'ok.ru',
  'myspace.com',
  'threads.net',
  'venmo.com',
];

/**
 * LinkedIn itself and the sites that copy its profiles (sales-lead databases). Research may see them, but they never
 * count as a strong match: the real profile already comes from the student's own LinkedIn connection.
 */
export const LINKEDIN_COPY_DOMAINS: readonly string[] = [
  'linkedin.com',
  'zoominfo.com',
  'rocketreach.co',
  'contactout.com',
  'signalhire.com',
  'lusha.com',
  'apollo.io',
  'leadiq.com',
  'seamless.ai',
  'adapt.io',
  'datanyze.com',
  'theorg.com',
  'crunchbase.com',
  'cbinsights.com',
  'pitchbook.com',
  'craft.co',
  'golden.com',
  'peoplebyname.com',
  'wiza.co',
  'kaspr.io',
];

function hostIn(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return domains.some((d) => {
    // a path-scoped entry such as dockets.justia.com stays a host check; "x.com/…" style entries are not used
    return host === d || host.endsWith(`.${d}`) || (d.includes('/') && `${host}${path}`.startsWith(d));
  });
}

/** True for a page research must never read or cite. */
export function isBlockedSource(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  return hostIn(url, BLOCKED_SOURCE_DOMAINS);
}

/** True for LinkedIn and the people-search copies of it. */
export function isLinkedInCopy(url: string): boolean {
  return hostIn(url, LINKEDIN_COPY_DOMAINS);
}

/**
 * Sensitive categories the brief must never include (§5.4): age, ethnicity, religion, health, family, sexuality,
 * politics. Deliberately narrow phrases, so a person who works at a health or civic organization is not erased.
 * Research adds what docs/plan/20 §5 never writes: home location finer than a city, salary and pay, personality or
 * "communication style", legal matters and immigration.
 */
export const SENSITIVE: { category: string; re: RegExp }[] = [
  {
    category: 'age',
    re: /\b\d{1,3}[- ]years?[- ]old\b|\baged \d{1,3}\b|\bborn in (19|20)\d\d\b|\bage \d{1,3}\b/i,
  },
  {
    category: 'ethnicity',
    re: /\b(ethnicity|ethnic background|racial|race is|caucasian|african[- ]american|asian[- ]american|hispanic|latino|latina|latinx)\b/i,
  },
  {
    category: 'religion',
    re: /\b(christian|muslim|jewish|hindu|buddhist|sikh|atheist|catholic|protestant|mormon|religious|religion|his faith|her faith|their faith|attends church)\b/i,
  },
  {
    category: 'health',
    re: /\b(diagnos(ed|is)|illness|cancer survivor|chronic (illness|condition)|disabilit(y|ies)|pregnan(t|cy)|surgery|mental illness|in recovery)\b/i,
  },
  {
    category: 'family',
    re: /\b(married|divorced|widow(ed|er)?|spouse|wedding|(his|her|their|your) (wife|husband|kids|children|daughter|son|family)|(father|mother|parent) of (two|three|four|\d))\b/i,
  },
  { category: 'sexuality', re: /\b(gay|lesbian|bisexual|transgender|queer|lgbtq?\+?|sexual orientation)\b/i },
  {
    category: 'politics',
    re: /\b(democrat(ic)? (voter|supporter)|republican (voter|supporter)|political views?|voted for|votes for|campaigned for|donated to (the )?(campaign|party)|political donations?)\b/i,
  },
  {
    // a street address, as written ("1200 Market Street"): case kept, so "5 years to drive growth" is not one
    category: 'home',
    re: /\b\d{1,6}\s+[A-Z][a-z]+(\s+[A-Z][a-z]+){0,2}\s+(Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Circle)\b/,
  },
  {
    category: 'home',
    re: /\b(home address|lives (at|on) \d|zip code|apartment \d|apt\.? \d|neighbou?rhood (where|in which) (he|she|they) lives?|(his|her|their) (house|home) (in|on|at))\b/i,
  },
  {
    category: 'pay',
    re: /\b(salary|salaries|compensation package|total compensation|base pay|net worth|earns? \$|makes \$|paid \$|\$\s?\d[\d,.]*\s?k?\s+(a|per) year|annual pay|stock (grants?|options?) worth)\b/i,
  },
  {
    category: 'personality',
    re: /\b(personality|communication style|introvert(ed)?|extrovert(ed)?|myers[- ]briggs|mbti|enneagram|(intj|intp|entj|entp|infj|infp|enfj|enfp|istj|isfj|estj|esfj|istp|isfp|estp|esfp)\b|temperament|(is|seems|comes across as) (shy|arrogant|abrasive|difficult|blunt|awkward|cold|aloof|intense))\b/i,
  },
  {
    category: 'legal',
    // what happened to someone in court, not the practice area of a lawyer ("litigation associate" stays)
    re: /\b(lawsuits?|sued|suing|indicted|indictment|arrested|arrest record|convicted|conviction|charged with|felony|misdemeanou?r|dui|restraining order|filed for bankruptcy|pleaded guilty|settled (a|the) (suit|case))\b/i,
  },
  {
    category: 'immigration',
    re: /\b(visa status|green card|immigration status|h-?1b status|undocumented|deport(ed|ation)|citizenship status)\b/i,
  },
  {
    category: 'job_loss',
    re: /\b((he|she|they) (was|were|got) (laid off|fired|let go)|lost (his|her|their) job|on (parental|maternity|paternity|medical|family) leave)\b/i,
  },
];

/** Categories that may appear in the "careful" section when they are about the company, never the person. */
const COMPANY_OK = new Set(['job_loss']);

/**
 * The "careful" section is company context only (recent layoffs, a reorganization, a product shut down): a line about
 * the person's own life never stays, whatever its source.
 */
export function carefulAllowed(text: string): boolean {
  const cat = sensitiveCategory(text);
  if (cat && !COMPANY_OK.has(cat)) return false;
  // about them, not their company: "she", "he", "his", "her", "their family"
  if (/\b(she|he|his|her|hers|him)\b/i.test(text)) return false;
  return !/\b(personal|private life|relationship|partner|dating)\b/i.test(text);
}

export function sensitiveCategory(text: string): string | undefined {
  return SENSITIVE.find((s) => s.re.test(text))?.category;
}

/** Drop the sentences of a paragraph that touch a sensitive category. */
export function stripSensitiveSentences(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !sensitiveCategory(s))
    .join(' ')
    .trim();
}
