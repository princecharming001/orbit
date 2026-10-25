import { article, inOrAt } from '../drafts/phrasing';
import { isRecruiter } from '../drafts/sector';
import { roleFromHeadline } from '../linkedin/headline';
import { normalizeCompany } from '../text/normalize';
import type {
  CoffeeChat,
  Person,
  Recommendation,
  RecruitingGoals,
  ResumeFacet,
  TargetCompany,
} from '../types';
import {
  buildDiscoverProfile,
  type DismissSignal,
  type OutreachExample,
  scoreDiscoverCandidate,
} from './discover';
import { cleanName, rankScore, replyOdds } from './quality';
import { FUNCTION_TITLE, normalizeTitle, titleSimilarity, titleStatus } from './title';

/**
 * Titles that only hint at a function. "Analyst" or "Associate" is a banking title at a bank, but a McKinsey
 * "Business Analyst" is a consultant and a Bain "Associate Consultant" too, so a hint counts only when nothing in the
 * title or company points at another function.
 */
const FUNCTION_HINT: Record<string, RegExp> = {
  ib: /\b(analyst|associate|banker)\b/i,
};
/** Titles a hint never covers: a "Business Analyst" outside a bank is operations or consulting work. */
const NOT_A_HINT =
  /\b(business|credit|loan|lending|risk|compliance|audit|commercial|retail|branch|operations|systems|it|data|marketing|policy)\s+(analyst|associate)\b/i;

/** The student's target function this person works in, from their title and company (undefined when none). */
export function matchedFunction(text: string | undefined, functions: string[]): string | undefined {
  if (!text) return undefined;
  // "APM" and "SWE II" are read written out too ("Associate Product Manager")
  const full = `${text} ${normalizeTitle(text)}`;
  const strong = functions.find((f) => FUNCTION_TITLE[f]?.test(full));
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
  user: { school: string; majors: string[]; gradYear?: number; currentCity?: string; homeCity?: string };
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
  /** who the student wrote to, and who replied: people like them rank higher */
  outreach?: OutreachExample[];
  /** cards the student turned down, with why: a wrong company or role ranks lower next time */
  dismissed?: DismissSignal[];
  /** people the student already wrote to outside a chat and who have not answered: not suggested again */
  contacted?: Set<string>;
}

/**
 * The role a person's record says they hold, and only that: their title, or the first part of a headline when there
 * is no title and the headline says they work there. "Aspiring Investment Banker" is not a banker.
 */
export function heldRole(p: Pick<Person, 'currentTitle' | 'headline'>): string | undefined {
  if (p.currentTitle?.trim()) return titleStatus(p.currentTitle) === 'working' ? p.currentTitle : undefined;
  const fromHeadline = roleFromHeadline(p.headline).title;
  return fromHeadline && titleStatus(fromHeadline) === 'working' && titleStatus(p.headline) === 'working'
    ? fromHeadline
    : undefined;
}

/** A reason code that is enough on its own to suggest someone from the network (see quality.worthSuggesting). */
const GOAL_ANCHORS = new Set([
  'target_company',
  'want_to_meet',
  'alumni_field',
  'role_industry',
  'shared_org',
  'shared_org_now',
]);

/**
 * The people in the student's own network worth a coffee chat now, best first. Only people with a specific reason:
 * their company is on the target list, an alum in the student's field, an employer on both resumes, the role in an
 * industry on the list, or a real tie (they know each other a little, or someone can introduce them). Never anyone
 * the student is already in a chat with (any stage: to contact, waiting, declined, archived), already wrote to,
 * hid, or who asked not to be contacted; never a profile without a real name or with neither title nor company.
 */
export function recommendPeople(inp: RecommendInput): Recommendation[] {
  const batchDate = inp.now.toISOString().slice(0, 10);
  const inChat = new Set(inp.chats.map((c) => c.personId));
  const resumeKeywords = inp.resumeFacets.flatMap((f) => f.keywords);
  const targetNames = new Map(inp.targetCompanies.map((t) => [normalizeCompany(t.nameRaw), t]));
  const industries = inp.goals.targetIndustries.map((i) => i.toLowerCase());
  const profile = buildDiscoverProfile({
    user: inp.user,
    goals: inp.goals,
    targetCompanies: inp.targetCompanies,
    resumeFacets: inp.resumeFacets,
    outreach: inp.outreach,
    dismissed: inp.dismissed,
  });
  const out: Recommendation[] = [];
  for (const p of inp.people) {
    if (
      !p.isHuman ||
      p.hiddenAt ||
      p.doNotContact ||
      inChat.has(p.id) ||
      inp.contacted?.has(p.id) ||
      inp.recentlyRecommended.has(p.id)
    )
      continue;
    const name = cleanName(p.displayName);
    if (name.quality === 'junk' || (!p.currentTitle?.trim() && !p.currentOrganizationRaw?.trim())) continue;
    const status = titleStatus(p.currentTitle || p.headline);
    if (status === 'student' || status === 'aspiring') continue;
    const orgNorm = normalizeCompany(p.currentOrganizationRaw);
    const tc =
      (p.currentOrganizationId &&
        inp.targetCompanies.find((t) => t.organizationId === p.currentOrganizationId)) ||
      (orgNorm ? targetNames.get(orgNorm) : undefined);
    // the function is read from the role they hold and the company (an "Analyst" at McKinsey is consulting, at
    // Evercore banking), never from a headline that only hopes for the role
    const role = heldRole(p);
    const roleText = role ? `${role} ${p.currentOrganizationRaw ?? ''}` : undefined;
    const fnKey = matchedFunction(roleText, inp.goals.targetFunctions);
    const indMatch = industries.some(
      (i) => (p.headline ?? '').toLowerCase().includes(i) || orgNorm.includes(i),
    );
    const kw = keywordOverlap(
      resumeKeywords,
      `${p.headline ?? ''} ${p.currentTitle ?? ''}`.split(/\W+/).filter((w) => w.length > 3),
    );
    // someone at an organisation on the student's resume: their own club now, or the firm they interned at
    const shared = orgNorm
      ? inp.resumeFacets.find(
          (f) =>
            f.kind === 'experience' &&
            !!f.organizationName &&
            normalizeCompany(f.organizationName) === orgNorm,
        )
      : undefined;
    const pathStrength = inp.pathStrength(p.id); // one lookup per candidate; callers pass a precomputed table
    const prior = responsePrior(p, inp.user);
    const likeTitle = role ?? p.currentTitle;
    const odds = replyOdds({
      title: likeTitle,
      status,
      recruiter: isRecruiter(likeTitle),
      alum: !!p.isAlumni,
      sharedOrg: shared ? (shared.startDate && !shared.endDate ? 'now' : 'past') : undefined,
      strength: p.strength,
      connected: !!p.linkedinConnectedOn,
      likeReplied: inp.outreach?.some(
        (ex) => ex.replied && !!ex.title && !!likeTitle && titleSimilarity(ex.title, likeTitle) >= 0.75,
      ),
    });
    const scored = scoreDiscoverCandidate(
      {
        name: p.displayName,
        title: role ?? p.currentTitle,
        company: p.currentOrganizationRaw,
        headline: p.headline,
        location: p.location,
        schoolEvidence: !!p.isAlumni,
        known: { strength: p.strength, pathStrength, linkedinConnected: !!p.linkedinConnectedOn },
        targetPriority: tc?.priority,
        prior,
        odds,
      },
      profile,
    );
    const like = scored.parts.like;
    if (
      !tc &&
      !fnKey &&
      scored.parts.role < 0.55 &&
      !indMatch &&
      kw < 0.48 &&
      !shared &&
      !p.isAlumni &&
      like < 0.75 &&
      scored.parts.want < 0.6
    )
      continue;
    // a little for what their work shares with the student's resume
    const fit = Math.min(1, scored.fit + 0.08 * Math.min(1, kw) * scored.parts.penalty);
    const reach = scored.reach;
    const score = rankScore({ match: fit, reach, odds, initialName: name.quality === 'initial' });
    const reasons: { code: string; text: string }[] = [];
    if (shared) {
      // "both at X" only when the resume says the student is there now (a range ending in "present"); a resume
      // line without dates says nothing about when
      const now = !!shared.startDate && !shared.endDate;
      reasons.push({
        code: now ? 'shared_org_now' : 'shared_org',
        text: now
          ? `You're both ${inOrAt(p.currentOrganizationRaw!, shared.title)}`
          : `Works at ${p.currentOrganizationRaw}, where you ${/\bintern/i.test(shared.title ?? '') ? 'interned' : 'worked'}`,
      });
    }
    const where = p.currentOrganizationRaw ? ` at ${p.currentOrganizationRaw}` : '';
    if (p.isAlumni && fnKey && role && !tc)
      reasons.push({
        code: 'alumni_field',
        text: `${inp.user.school} alum, now ${article(role)} ${role}${where}`,
      });
    if (fnKey && role && indMatch && !tc && p.currentOrganizationRaw) {
      const ind = inp.goals.targetIndustries.find(
        (i) =>
          !role.toLowerCase().includes(i.toLowerCase()) &&
          ((p.headline ?? '').toLowerCase().replace(role.toLowerCase(), '').includes(i.toLowerCase()) ||
            orgNorm.includes(i.toLowerCase())),
      );
      if (ind)
        reasons.push({
          code: 'role_industry',
          text: `${role}${where}, in ${ind}, an industry on your list`,
        });
    }
    // who the student said they most want to meet (plan 24)
    const wanted = scored.reasons.find((r) => r.code === 'want_to_meet');
    if (wanted) reasons.push(wanted);
    if (p.isAlumni) reasons.push({ code: 'alumni', text: `${inp.user.school} alum` });
    if (tc) reasons.push({ code: 'target_company', text: `${tc.nameRaw} is on your target list` });
    // "PM at Plaid, who you said you want to meet" already says the role
    if (fnKey && role && !wanted?.text.includes(role))
      reasons.push({ code: 'function_match', text: `${role}${where}, the role you're targeting` });
    const replied = scored.reasons.find((r) => r.code === 'like_replied');
    if (replied) reasons.push(replied);
    if (kw >= 0.2 && !shared) reasons.push({ code: 'resume_overlap', text: 'Overlaps with your experience' });
    if (p.strength >= 0.3) reasons.push({ code: 'warm', text: 'You already know each other a little' });
    else if (pathStrength >= 0.15) reasons.push({ code: 'path', text: 'Reachable through someone you know' });
    // a role true of thousands, a school, a LinkedIn connection: not enough without a specific reason or a real tie
    if (!reasons.some((r) => GOAL_ANCHORS.has(r.code) || r.code === 'warm' || r.code === 'path')) continue;
    out.push({
      id: `rec-${p.id}-${batchDate}`,
      userId: inp.userId,
      personId: p.id,
      score: Math.round(score * 1000) / 1000,
      fitScore: Math.round(fit * 1000) / 1000,
      reachScore: reach,
      // the reply odds: how likely they are to answer the student (Discover's third meter)
      responsePrior: odds,
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
  const alumniFirst = out
    .filter((r) => peopleById.get(r.personId)?.isAlumni && r.reasons.some((x) => GOAL_ANCHORS.has(x.code)))
    .slice(0, 3);
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
