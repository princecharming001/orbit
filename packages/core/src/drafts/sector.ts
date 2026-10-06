import type { Sector, Seniority } from '../types';

const FINANCE_TITLE =
  /\b(investment bank|banking analyst|ib analyst|analyst, (m&a|tmt|healthcare|fig|leveraged)|associate, (m&a|tmt|healthcare|fig)|vice president|managing director|\bvp\b|\bmd\b|private equity|hedge fund|equity research|capital markets|sales and trading|trading|asset management|wealth management|portfolio manager|\bm&a\b|leveraged finance|\bfig\b|\btmt\b|corporate finance|venture capital|investor)\b/i;
const FINANCE_ORG =
  /\b(goldman|morgan stanley|jpmorgan|j\.p\. morgan|bank of america|bofa|citi|barclays|ubs|credit suisse|deutsche bank|evercore|lazard|moelis|pjt|centerview|jefferies|rbc|wells fargo|houlihan|guggenheim|perella|rothschild|blackstone|kkr|apollo|carlyle|tpg|bain capital|jane street|citadel|two sigma|de shaw|point72|millennium|bridgewater|sequoia|a16z|andreessen|accel|benchmark)\b/i;
const CONSULTING_TITLE =
  /\b(consultant|engagement manager|business analyst|associate consultant|case team|principal|partner|senior associate)\b/i;
const CONSULTING_ORG =
  /\b(mckinsey|bain|bcg|boston consulting|deloitte|accenture|kearney|oliver wyman|l\.?e\.?k\.?|roland berger|strategy&|pwc|ey|kpmg|ey-parthenon|alixpartners|fti)\b/i;
const TECH_TITLE =
  /\b(software|engineer|developer|\bswe\b|\bsde\b|product manager|product lead|\bpm\b|designer|\bux\b|data scientist|machine learning|\bml\b|research scientist|technical program|devops|infrastructure|platform|frontend|backend|full[- ]?stack|security engineer|solutions engineer|founder|cto)\b/i;
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
  if (FINANCE_TITLE.test(t)) return 'finance';
  if (CONSULTING_TITLE.test(t) && !TECH_TITLE.test(t)) return 'consulting';
  if (
    TECH_TITLE.test(t) ||
    TECH_ORG.test(o) ||
    /\b(software|technology|tech|ai|saas|internet)\b/i.test(person.industry ?? '')
  )
    return 'tech';
  const f = userFunctions[0];
  if (f === 'ib' || f === 'finance' || f === 'vc') return 'finance';
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
    /\b(vice president|\bvp\b|director|principal|senior manager|group product manager|staff|distinguished|engineering manager|lead)\b/.test(
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
