import type { Sector, Seniority } from '../types';

const FINANCE_TITLE =
  /\b(investment bank|banking analyst|ib analyst|analyst, (m&a|tmt|healthcare|fig|leveraged)|associate, (m&a|tmt|healthcare|fig)|vice president|managing director|\bvp\b|\bmd\b|private equity|hedge fund|equity research|capital markets|sales and trading|trading|asset management|wealth management|portfolio manager|\bm&a\b|leveraged finance|\bfig\b|\btmt\b|corporate finance|venture capital|investor)\b/i;
const FINANCE_ORG =
  /\b(goldman|morgan stanley|jpmorgan|j\.p\. morgan|bank of america|bofa|citi|barclays|ubs|credit suisse|deutsche bank|evercore|lazard|moelis|pjt|centerview|jefferies|rbc|wells fargo|houlihan|guggenheim|perella|rothschild|blackstone|kkr|apollo|carlyle|tpg|bain capital|jane street|citadel|two sigma|de shaw|point72|millennium|bridgewater|sequoia|a16z|andreessen|accel|benchmark|jump trading|hudson river trading|optiver|susquehanna|drw|imc trading|tower research|akuna|lightspeed venture|founders fund|greylock|kleiner|index ventures|general catalyst|insight partners|tiger global|coatue)\b/i;
/** An org name that says what kind of firm it is ("... Trading", "... Capital", "... Ventures"). */
const FINANCE_ORG_WORD =
  /\b(trading|securities|capital|ventures|venture partners|investments|asset management)\b/i;
const CONSULTING_TITLE =
  /\b(consultant|engagement manager|business analyst|associate consultant|case team|principal|partner|senior associate)\b/i;
const CONSULTING_ORG =
  /\b(mckinsey|bain|bcg|boston consulting|deloitte|accenture|kearney|oliver wyman|l\.?e\.?k\.?|roland berger|strategy&|pwc|ey|kpmg|ey-parthenon|alixpartners|fti)\b/i;
const TECH_TITLE =
  /\b(software|engineer|engineering|developer|\bswe\b|\bsde\b|product manager|product lead|\bpm\b|designer|\bux\b|data scientist|machine learning|\bml\b|research scientist|technical program|devops|infrastructure|platform|frontend|backend|full[- ]?stack|security engineer|solutions engineer|founder|cto)\b/i;
const TECH_ORG =
  /\b(google|meta|apple|amazon|microsoft|netflix|stripe|figma|notion|anthropic|openai|airbnb|uber|lyft|doordash|snowflake|databricks|datadog|ramp|brex|linear|vercel|coinbase|robinhood|plaid|square|block|shopify|salesforce|adobe|nvidia|palantir|scale ai|rippling|ramp)\b/i;

export function sectorOf(
  person: { title?: string; org?: string; industry?: string },
  userFunctions: string[] = [],
): Sector {
  const t = `${person.title ?? ''}`;
  const o = `${person.org ?? ''} ${person.industry ?? ''}`;
  if (
    FINANCE_ORG.test(o) ||
    FINANCE_ORG_WORD.test(person.org ?? '') ||
    /\b(fintech|investment bank|banking|private equity|trading|asset management|finance|financial)\b/i.test(
      person.industry ?? '',
    )
  ) {
    // "Associate Product Manager" is a PM; "Associate, M&A" is a banker.
    const bankingTitle =
      /\b(analyst|vice president|managing director)\b/i.test(t) ||
      /\bassociate\b(?!\s+(product|software|design|data|engineer|program))/i.test(t);
    if (TECH_TITLE.test(t) && !bankingTitle) return 'tech';
    return 'finance';
  }
  if (CONSULTING_ORG.test(o) || /\bconsulting\b/i.test(person.industry ?? '')) return 'consulting';
  // "Vice President of Engineering" at Apple is an engineer, not a banker
  if (FINANCE_TITLE.test(t) && !TECH_TITLE.test(t) && !TECH_ORG.test(o)) return 'finance';
  if (CONSULTING_TITLE.test(t) && !TECH_TITLE.test(t)) return 'consulting';
  if (
    TECH_TITLE.test(t) ||
    TECH_ORG.test(o) ||
    /\b(software|technology|tech|ai|saas|internet)\b/i.test(person.industry ?? '')
  )
    return 'tech';
  const f = userFunctions[0];
  if (f === 'ib' || f === 'finance' || f === 'vc' || f === 'quant') return 'finance';
  if (f === 'consulting') return 'consulting';
  if (f === 'swe' || f === 'pm' || f === 'design' || f === 'data') return 'tech';
  return 'general';
}

export function seniorityOf(title: string | undefined): Seniority {
  const t = (title ?? '').toLowerCase();
  if (!t) return 'mid';
  const execTitle =
    /\b(ceo|cfo|coo|cto|chief|founder|co-founder|partner|managing director|\bmd\b|managing partner|president|general partner|head of|svp|evp)\b/.test(
      t,
    );
  const onlyVicePresident =
    /\bpresident\b/.test(t) &&
    /\b(vice|assistant|associate|executive assistant to the)\s+president\b/.test(t) &&
    !/\b(ceo|cfo|coo|cto|chief|founder|co-founder|partner|managing director|\bmd\b|managing partner|general partner|head of|svp|evp)\b/.test(
      t,
    );
  if (execTitle && !onlyVicePresident) return 'exec';
  if (
    /\b(vice president|\bvp\b|director|principal|senior manager|group product manager|staff|distinguished|engineering manager|engagement manager|project leader|case team leader|lead)\b/.test(
      t,
    )
  )
    return 'senior';
  if (/\b(intern|analyst|associate|junior|new grad|graduate|entry)\b/.test(t) && !/senior/.test(t))
    return 'junior';
  return 'mid';
}

export function isRecruiter(title: string | undefined): boolean {
  return /\b(recruit\w*|talent\b|university relations|campus\b|people ops|hr\b|human resources|sourc(er|ing))\b/i.test(
    title ?? '',
  );
}

/** "junior", "sophomore", "first-year MBA student" from graduation year and degree, as of `now`. */
export function yearLabel(gradYear: number | undefined, degree: string | undefined, now: Date): string {
  const d = (degree ?? '').toUpperCase();
  const grad = /\b(MBA|MS|MSC|MENG|MA|PHD|JD|MPA|MPP|MFIN)\b/.test(d);
  if (!gradYear) return grad ? `${d.includes('MBA') ? 'MBA' : 'graduate'} student` : 'student';
  const academicYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const left = gradYear - academicYear;
  if (grad) {
    const program = d.includes('MBA') ? 'MBA' : d.includes('PHD') ? 'PhD' : "master's";
    if (left >= 1) return `first-year ${program} student`;
    return `second-year ${program} student`;
  }
  if (left <= 0) return 'senior';
  if (left === 1) return 'junior';
  if (left === 2) return 'sophomore';
  return 'first-year';
}

export function classYear(gradYear: number | undefined): string {
  return gradYear ? `'${String(gradYear).slice(2)}` : '';
}

/**
 * Playbook: one bump for everyone; a second, graceful "last word" only in finance and consulting, where two
 * follow-ups are expected. The user's setting is the ceiling.
 */
export function maxBumpsFor(sector: Sector, settingsMax: number): number {
  const cap = sector === 'finance' || sector === 'consulting' ? 2 : 1;
  return Math.max(0, Math.min(settingsMax, cap));
}

const BANK_ORG =
  /\b(goldman|morgan stanley|jpmorgan|j\.p\. morgan|bank of america|bofa|citi|barclays|ubs|credit suisse|deutsche bank|evercore|lazard|moelis|pjt|centerview|jefferies|rbc|wells fargo|houlihan|guggenheim|perella|rothschild)\b/i;
const PE_ORG = /\b(blackstone|kkr|apollo|carlyle|tpg|bain capital)\b/i;
const TRADING_ORG =
  /\b(jane street|citadel|two sigma|de shaw|point72|millennium|bridgewater|jump trading|hudson river trading|optiver|susquehanna|drw|imc trading|tower research|akuna)\b/i;
const VC_ORG =
  /\b(sequoia|a16z|andreessen|accel|benchmark|lightspeed venture|founders fund|greylock|kleiner|index ventures|general catalyst|ventures|venture partners)\b/i;

/**
 * Which kind of finance firm a known organization is. `sectorOf` calls all of these "finance", but a venture firm, a
 * buyout fund or a trading firm has no investment banking team. Undefined when the firm is not one we know.
 */
export function financeFirmKind(org: string | undefined): 'bank' | 'pe' | 'trading' | 'vc' | undefined {
  const o = org ?? '';
  if (VC_ORG.test(o)) return 'vc';
  if (PE_ORG.test(o)) return 'pe';
  if (TRADING_ORG.test(o)) return 'trading';
  if (BANK_ORG.test(o)) return 'bank';
  return undefined;
}

const BIG_TECH_ORG =
  /\b(google|alphabet|meta|facebook|apple|amazon|aws|microsoft|netflix|nvidia|salesforce|adobe|oracle|ibm|intel|uber|airbnb|linkedin|tiktok|bytedance)\b/i;

/**
 * The kind of firm, finer than the sector, for what a question to someone there can sensibly be about: a banker has a
 * group, a consultant an office and a staffing model, a trader a desk, an investor a fund, a startup founder early
 * hires. Asking a venture partner "how juniors get staffed" or a quant partner about "the office" reads as mail-merge.
 */
export type FirmKind =
  | 'bank'
  | 'pe'
  | 'trading'
  | 'vc'
  | 'consulting'
  | 'big_tech'
  | 'startup'
  | 'tech'
  | 'other';

export function firmKindOf(
  person: { title?: string; org?: string; industry?: string },
  sector: Sector,
): FirmKind {
  const t = person.title ?? '';
  // an engineer or a PM at a bank or a trading firm is asked what an engineer is asked
  const known = sector === 'tech' ? undefined : financeFirmKind(person.org);
  if (known) return known;
  if (/\b(quant\w*|trader|trading)\b/i.test(t)) return 'trading';
  if (/\b(venture|general partner)\b/i.test(t) || /\bventure/i.test(person.industry ?? '')) return 'vc';
  if (sector === 'finance')
    return /\bprivate equity\b/i.test(`${t} ${person.industry ?? ''}`) ? 'pe' : 'bank';
  if (sector === 'consulting') return 'consulting';
  if (sector === 'tech') {
    if (BIG_TECH_ORG.test(person.org ?? '')) return 'big_tech';
    if (
      /\b(founder|co-founder|cofounder|founding|ceo|cto)\b/i.test(t) ||
      /\bstartup\b/i.test(person.industry ?? '')
    )
      return 'startup';
    return 'tech';
  }
  return 'other';
}

/**
 * Peer (analyst, associate, consultant, engineer: two to six years ahead) or senior (VP, director, principal,
 * manager, partner, founder). A senior person has not had a "first year" in a long time and is asked what they look
 * for, not what their onboarding was like.
 */
export function isSeniorTitle(title: string | undefined): boolean {
  const s = seniorityOf(title);
  return s === 'senior' || s === 'exec';
}
