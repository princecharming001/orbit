import { functionPhrase } from '../labels';
import { normalizeCompany } from '../text/normalize';
import type {
  CoffeeChat,
  Person,
  Recommendation,
  RecruitingGoals,
  ResumeFacet,
  TargetCompany,
} from '../types';

const FUNCTION_TITLE: Record<string, RegExp> = {
  swe: /\b(software|engineer|developer|swe|sde|backend|frontend|full[- ]?stack|ml engineer|infrastructure|platform)\b/i,
  pm: /\b(product manager|product lead|\bpm\b|head of product|product owner|associate product)\b/i,
  ib: /\b(investment bank(ing|er)?|m&a|mergers|capital markets|leveraged finance|ecm|dcm|restructuring)\b/i,
  consulting:
    /\b(consult(ant|ing)?|strategy|bain|mckinsey|bcg|boston consulting|deloitte|accenture|oliver wyman|kearney|engagement manager)\b/i,
  data: /\b(data (scientist|analyst|engineer)|analytics|machine learning|ml|ai research|quant)\b/i,
  design: /\b(designer|design lead|ux|product design|ui)\b/i,
  finance:
    /\b(finance|fp&a|treasury|controller|accounting|private equity|hedge fund|asset management|wealth)\b/i,
  marketing: /\b(marketing|growth|brand|content|communications|demand gen)\b/i,
  research: /\b(research|scientist|lab|phd|postdoc)\b/i,
  vc: /\b(venture|vc|investor|principal|partner)\b/i,
  ops: /\b(operations|ops|chief of staff|bizops|strategy & operations)\b/i,
};
/**
 * Titles that only hint at a function. "Analyst" or "Associate" is a banking title at a bank, but a McKinsey
 * "Business Analyst" is a consultant and a Bain "Associate Consultant" too, so a hint counts only when nothing in the
 * title or company points at another function.
 */
const FUNCTION_HINT: Record<string, RegExp> = {
  ib: /\b(analyst|associate|banker)\b/i,
};
/** Titles a hint never covers: a "Business Analyst" outside a bank is operations or consulting work. */
const NOT_A_HINT = /\bbusiness analyst\b/i;

/** The student's target function this person works in, from their title and company (undefined when none). */
export function matchedFunction(text: string | undefined, functions: string[]): string | undefined {
  if (!text) return undefined;
  const strong = functions.find((f) => FUNCTION_TITLE[f]?.test(text));
  if (strong) return strong;
  // a hint only when the title is not plainly another function (a consulting "Business Analyst" is not banking)
  const other = Object.entries(FUNCTION_TITLE).some(([f, re]) => !functions.includes(f) && re.test(text));
  if (other) return undefined;
  if (NOT_A_HINT.test(text)) return undefined;
  return functions.find((f) => FUNCTION_HINT[f]?.test(text));
}

export function functionMatch(text: string | undefined, functions: string[]): number {
  return matchedFunction(text, functions) ? 1 : 0;
}

export function keywordOverlap(a: string[], b: string[]): number {
  const A = new Set(a.map((x) => x.toLowerCase()));
  const B = new Set(b.map((x) => x.toLowerCase()));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.sqrt(A.size * B.size);
}

export function responsePrior(
  p: Person,
  user: { school: string; majors: string[]; gradYear?: number },
): number {
  let z = -0.4;
  if (p.isAlumni) z += 0.8;
  if (p.school && user.majors.some((m) => (p.headline ?? '').toLowerCase().includes(m.toLowerCase())))
    z += 0.5;
  const title = (p.currentTitle ?? '').toLowerCase();
  if (/\b(ceo|cfo|coo|cto|partner|managing director|md|founder|chief)\b/.test(title)) z -= 0.6;
  else if (title) z += 0.3;
  if (p.lastInteractionAt && Date.now() - new Date(p.lastInteractionAt).getTime() < 180 * 86_400_000)
    z += 0.3;
  if (p.linkedinConnectedOn) z += 0.2;
  return 1 / (1 + Math.exp(-z));
}

export interface RecommendInput {
  userId: string;
  user: { school: string; majors: string[]; gradYear?: number };
  goals: RecruitingGoals;
  targetCompanies: TargetCompany[];
  resumeFacets: ResumeFacet[];
  people: Person[];
  chats: CoffeeChat[];
  /** best path strength from the graph, 0..1; build it once per batch (bestPathsFrom), not one search per call */
  pathStrength: (personId: string) => number;
  recentlyRecommended: Set<string>;
  now: Date;
  batchSize?: number;
}

export function recommendPeople(inp: RecommendInput): Recommendation[] {
  const batchDate = inp.now.toISOString().slice(0, 10);
  const activeChatPeople = new Set(
    inp.chats.filter((c) => !['archived', 'no_response'].includes(c.stage)).map((c) => c.personId),
  );
  const declined = new Set(
    inp.chats
      .filter(
        (c) =>
          c.stage === 'declined' && inp.now.getTime() - new Date(c.updatedAt).getTime() < 180 * 86_400_000,
      )
      .map((c) => c.personId),
  );
  const resumeKeywords = inp.resumeFacets.flatMap((f) => f.keywords);
  const targetNames = new Map(inp.targetCompanies.map((t) => [normalizeCompany(t.nameRaw), t]));
  const industries = inp.goals.targetIndustries.map((i) => i.toLowerCase());
  const out: Recommendation[] = [];
  for (const p of inp.people) {
    if (
      !p.isHuman ||
      p.hiddenAt ||
      activeChatPeople.has(p.id) ||
      declined.has(p.id) ||
      inp.recentlyRecommended.has(p.id)
    )
      continue;
    const orgNorm = normalizeCompany(p.currentOrganizationRaw);
    const tc =
      (p.currentOrganizationId &&
        inp.targetCompanies.find((t) => t.organizationId === p.currentOrganizationId)) ||
      (orgNorm ? targetNames.get(orgNorm) : undefined);
    const companyMatch = tc ? (tc.priority === 1 ? 1 : 0.8) : 0;
    // the company counts too: an "Analyst" at McKinsey is consulting, at Evercore banking
    const roleText = `${p.currentTitle ?? ''} ${p.headline ?? ''} ${p.currentOrganizationRaw ?? ''}`;
    const fnKey = matchedFunction(roleText, inp.goals.targetFunctions);
    const fnMatch = fnKey ? 1 : 0;
    const indMatch = industries.some(
      (i) => (p.headline ?? '').toLowerCase().includes(i) || orgNorm.includes(i),
    )
      ? 1
      : 0;
    const kw = keywordOverlap(
      resumeKeywords,
      `${p.headline ?? ''} ${p.currentTitle ?? ''}`.split(/\W+/).filter((w) => w.length > 3),
    );
    const fit = 0.35 * companyMatch + 0.25 * fnMatch + 0.15 * indMatch + 0.25 * kw;
    if (fit < 0.12 && !p.isAlumni) continue;
    const pathStrength = inp.pathStrength(p.id); // one lookup per candidate; callers pass a precomputed table
    const reach = Math.max(pathStrength, p.strength, p.isAlumni ? 0.6 : 0.25);
    const prior = responsePrior(p, inp.user);
    const score = Math.max(fit, 0.05) ** 0.5 * reach ** 0.3 * prior ** 0.2;
    const reasons: { code: string; text: string }[] = [];
    if (p.isAlumni) reasons.push({ code: 'alumni', text: `${inp.user.school} alum` });
    if (tc) reasons.push({ code: 'target_company', text: `${tc.nameRaw} is on your target list` });
    if (fnMatch)
      reasons.push({
        code: 'function_match',
        text: `Works in ${functionPhrase(fnKey) || 'your target function'}${p.currentTitle ? ` (${p.currentTitle})` : ''}`,
      });
    if (kw >= 0.2) reasons.push({ code: 'resume_overlap', text: 'Overlaps with your experience' });
    if (p.strength >= 0.3) reasons.push({ code: 'warm', text: 'You already know each other a little' });
    else if (pathStrength >= 0.15) reasons.push({ code: 'path', text: 'Reachable through someone you know' });
    out.push({
      id: `rec-${p.id}-${batchDate}`,
      userId: inp.userId,
      personId: p.id,
      score,
      fitScore: fit,
      reachScore: reach,
      responsePrior: prior,
      reasons,
      status: 'new',
      batchDate,
    });
  }
  out.sort((a, b) => b.score - a.score);
  // diversity: max 3 per company, at least 3 alumni if available, batch of 10
  const batch = inp.batchSize ?? 10;
  const perCompany = new Map<string, number>();
  const chosen: Recommendation[] = [];
  const peopleById = new Map(inp.people.map((p) => [p.id, p]));
  const alumniFirst = out.filter((r) => peopleById.get(r.personId)?.isAlumni).slice(0, 3);
  for (const r of [...alumniFirst, ...out]) {
    if (chosen.length >= batch) break;
    if (chosen.includes(r)) continue;
    const org = normalizeCompany(peopleById.get(r.personId)?.currentOrganizationRaw) || 'none';
    const n = perCompany.get(org) ?? 0;
    if (n >= 3) continue;
    perCompany.set(org, n + 1);
    chosen.push(r);
  }
  return chosen;
}
