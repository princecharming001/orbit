/**
 * Turns a persona, a recipient archetype and a scenario into the DraftContext the app would build
 * (apps/web/src/engine/brief.ts buildDraftContext), without Dexie: the resume facets go through the same
 * credibility and one-liner picks, the own-words answers through the same field mapping (story, aim, proudOf,
 * neverDo), and the recipient's facts, thread and chat are the ones that kind of card carries.
 */

import { type DraftContext, proposeWindows, schoolShort } from '../../drafts/templates';
import { heuristicSignal } from '../../email/triage';
import { resumeOneLiner } from '../../resume/parse';
import { defaultStyleCard } from '../../style/card';
import type { MessageKind, PersonFact, ResumeFacet } from '../../types';
import type { Persona } from './personas';

export const NOW = new Date('2026-10-06T14:00:00Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

/** Copy of apps/web/src/engine/brief.ts credibilityLine (the web module imports Dexie, so it is not imported). */
export function credibilityLine(
  facets: { kind: string; text: string; title?: string; organizationName?: string }[],
): string | undefined {
  const score = (t: string) =>
    (/\b\d[\d,]*\b/.test(t) ? 2 : 0) +
    (/\b(built|shipped|led|grew|raised|published|launched|won)\b/i.test(t) ? 1 : 0);
  const cands = facets
    .filter((f) => f.kind === 'project' || f.kind === 'experience')
    .map((f) => {
      const first = (f.text.split(/(?<=[.!?])\s+/)[0] ?? f.text).split(/;\s*/)[0]!;
      const line = first.replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
      return { line, score: score(line) + (f.kind === 'project' ? 0.5 : 0), len: line.length };
    })
    .filter((c) =>
      /^[A-Za-z]+ed\b|^(built|led|ran|won|grew|wrote|made|shipped|taught|drove|began)\b/i.test(c.line),
    )
    .filter((c) => c.len >= 20 && c.len <= 110)
    .sort((a, b) => b.score - a.score || a.len - b.len);
  return cands[0]?.line;
}

/** Copy of brief.ts oneLinerFor. */
function oneLinerFor(school: string, gradYear: number | undefined, summary: string | undefined) {
  if (school && gradYear) return undefined;
  const clause = resumeOneLiner(summary)?.split(/,\s*/)[0]?.trim();
  if (!clause) return undefined;
  return school ? clause.replace(school, schoolShort(school)) : clause;
}

export type RecipientId = 'alum' | 'senior' | 'recruiter' | 'founder' | 'professor' | 'unknown';
export const RECIPIENTS: RecipientId[] = ['alum', 'senior', 'recruiter', 'founder', 'professor', 'unknown'];

const fact = (id: string, type: PersonFact['type'], text: string, sourceTable = 'notes'): PersonFact => ({
  id,
  userId: 'u',
  personId: 'p',
  type,
  text,
  sourceTable,
  sourceId: `${id}-src`,
  confidence: 0.8,
  occurredAt: ago(10),
  createdAt: ago(10),
});

export function recipientFor(
  r: RecipientId,
  p: Persona,
): { person: DraftContext['person']; facts: PersonFact[] } {
  const g = p.goal;
  switch (r) {
    case 'alum':
      return {
        person: {
          firstName: 'Maya',
          lastName: 'Okafor',
          fullName: 'Maya Okafor',
          title: g.alumTitle,
          org: g.orgs.alum,
          orgIndustry: g.industry,
          isAlumni: true,
          relationshipType: 'unknown',
          strength: 0.1,
          headline: `${g.alumTitle} at ${g.orgs.alum} | ${schoolShort(p.school.name)} '24`,
          previousOrg: undefined,
        },
        facts: [fact('a1', 'background', `graduated from ${p.school.name} in 2024`, 'linkedin')],
      };
    case 'senior':
      return {
        person: {
          firstName: 'Richard',
          lastName: 'Hallworth',
          fullName: 'Richard Hallworth',
          title: g.seniorTitle,
          org: g.orgs.senior,
          orgIndustry: g.industry,
          relationshipType: 'unknown',
          strength: 0.05,
          headline: `${g.seniorTitle} at ${g.orgs.senior}. Previously at McKinsey.`,
          previousOrg: 'McKinsey & Company',
        },
        facts: [
          fact(
            's1',
            'role_detail',
            'leads the team that built the company’s first self-serve product',
            'linkedin',
          ),
        ],
      };
    case 'recruiter':
      return {
        person: {
          firstName: 'Jen',
          lastName: 'Alvarez',
          fullName: 'Jen Alvarez',
          title: 'University Recruiter',
          org: g.orgs.recruiter,
          orgIndustry: g.industry,
          relationshipType: 'unknown',
          strength: 0.05,
          headline: `Campus recruiting at ${g.orgs.recruiter}`,
        },
        facts: [],
      };
    case 'founder':
      return {
        person: {
          firstName: 'Dev',
          lastName: 'Raman',
          fullName: 'Dev Raman',
          title: 'Co-founder & CEO',
          org: g.orgs.founder,
          orgIndustry: 'Software',
          relationshipType: 'unknown',
          strength: 0.05,
          headline: `Co-founder & CEO at ${g.orgs.founder} (seed, hiring)`,
        },
        facts: [fact('f1', 'hook', 'posted that the team is hiring its first five people', 'linkedin')],
      };
    case 'professor':
      return {
        person: {
          firstName: 'Elena',
          lastName: 'Marsh',
          fullName: 'Elena Marsh',
          title: 'Associate Professor of Economics',
          org: 'Northwestern University',
          orgIndustry: 'Higher Education',
          relationshipType: 'unknown',
          strength: 0.05,
          headline: 'Associate Professor of Economics at Northwestern. Labor markets, matching.',
        },
        facts: [fact('pr1', 'role_detail', 'studies how matching markets place new graduates', 'web')],
      };
    default:
      return {
        person: { firstName: 'Sam', fullName: 'Sam', relationshipType: 'unknown', strength: 0.05 },
        facts: [],
      };
  }
}

/** The message kinds the app drafts, as the scenario a card would carry. */
export type ScenarioId =
  | 'outreach_email'
  | 'outreach_linkedin'
  | 'bump'
  | 'schedule'
  | 'thank_you'
  | 'nurture'
  | 'congratulate'
  | 'referral_ask'
  | 'intro_request'
  | 'reply_question'
  | 'reply_question_llm'
  | 'reply_interested'
  | 'reply_referral'
  | 'reply_not_now';

export const SCENARIOS: ScenarioId[] = [
  'outreach_email',
  'outreach_linkedin',
  'bump',
  'schedule',
  'thank_you',
  'nurture',
  'congratulate',
  'referral_ask',
  'intro_request',
  'reply_question',
  'reply_question_llm',
  'reply_interested',
  'reply_referral',
  'reply_not_now',
];

export const FIRST_TOUCH: ReadonlySet<ScenarioId> = new Set(['outreach_email', 'outreach_linkedin']);

/** Free windows the way the app picks them (an empty calendar, in the student's zone). */
function windows(p: Persona) {
  return proposeWindows([], NOW, p.school.tz, { seed: p.id });
}

/** Their reply, read by the same heuristic triage the app runs on inbound mail (signal, asks, proposed times). */
function inbound(p: Persona, body: string, sent: string): NonNullable<DraftContext['thread']> {
  const at = ago(0.3);
  const { signal, extraction } = heuristicSignal(body, 'inbound', new Date(at), { timeZone: p.school.tz });
  return {
    firstOutboundAt: sent,
    lastInboundAt: at,
    lastInboundBody: body,
    asksOfUser: extraction.asksOfUser,
    proposedTimes: extraction.proposedTimes.map((t) => ({ startIso: t.startIso, raw: t.raw })),
    lastSignal: signal,
    inThread: true,
  };
}

/** The student's own answer to "what kind of roles?" (the reply box), as messy as their onboarding answers. */
function answerFor(p: Persona): string {
  if (p.wordsStyle === 'blank') return '';
  return p.words.aim ?? p.goal.roleLabel;
}

function updateFor(p: Persona): string {
  switch (p.wordsStyle) {
    case 'messy_lower':
      return 'got a first round interview at the place we talked about';
    case 'typos':
      return 'I finished my first case competiton and placed 3rd';
    case 'nonnative':
      return 'I have been selected for the second round of interviews';
    case 'emoji':
      return 'Just got my first offer 🎉';
    case 'blank':
      return '';
    default:
      return `I applied to the ${p.goal.roleLabel} role and finished the take-home project`;
  }
}

export interface Built {
  ctx: DraftContext;
  /** what the student put in onboarding and their resume, for the grader */
  persona: Persona;
  recipient: RecipientId;
  scenario: ScenarioId;
}

export function buildContext(p: Persona, r: RecipientId, s: ScenarioId): Built {
  const facets: ResumeFacet[] = p.facets;
  const summary = facets.find((f) => f.kind === 'summary')?.text;
  const gradYear = 2026 + p.year.gradOffset;
  const school = p.school.name;
  const { person, facts } = recipientFor(r, p);
  const fullName = [p.name.first, p.name.last].filter(Boolean).join(' ');
  const exp = facets.filter((f) => f.kind === 'experience' && f.organizationName);
  const user: DraftContext['user'] = {
    firstName: p.name.first,
    lastName: p.name.last,
    fullName,
    // the profile fields are what the student set in onboarding; the resume's are only offered (resumeProfileChanges)
    school,
    gradYear,
    degree: p.year.degree,
    majors: p.major === 'Undecided' ? [] : [p.major],
    cycleLabel: p.goal.cycleLabel,
    targetFunctions: p.goal.targetFunctions,
    oneLiner: oneLinerFor(school, gradYear, summary),
    credibility: credibilityLine(facets),
    ...(p.words.story ? { story: p.words.story } : {}),
    ...(p.words.aim ? { aim: p.words.aim } : {}),
    ...(p.words.proudOf ? { proudOf: p.words.proudOf } : {}),
    ...(p.never.text ? { neverDo: p.never.text } : {}),
    timezone: p.school.tz,
    pastOrgs: [...new Set(exp.map((f) => f.organizationName!))],
    orgRoles: exp.map((f) => ({ name: f.organizationName!, title: f.title, current: !f.endDate })),
  };
  const base: DraftContext = {
    user,
    styleCard: defaultStyleCard(p.tone, p.name.first),
    person,
    facts,
    kind: 'outreach',
    channel: 'gmail',
    seed: `${p.id}-${r}-${s}`,
    now: NOW,
  };
  const sent = ago(8);
  const met = ago(1);
  let kind: MessageKind = 'outreach';
  const over: Partial<DraftContext> = {};
  switch (s) {
    case 'outreach_email':
      break;
    case 'outreach_linkedin':
      over.channel = 'linkedin';
      break;
    case 'bump':
      kind = 'bump';
      over.bumpNumber = 1;
      over.thread = { firstOutboundAt: sent };
      break;
    case 'schedule':
      kind = 'schedule';
      over.proposedWindows = windows(p);
      over.thread = inbound(p, 'Happy to chat. What times work for you next week?', sent);
      break;
    case 'thank_you':
      kind = 'thank_you';
      over.chat = { completedAt: met, meetingAt: met, stage: 'completed' };
      over.facts = [
        ...facts,
        // a note as students type them: half an imperative, half a statement
        Number(p.id.slice(1)) % 2
          ? fact('t1', 'advice', 'the key is showing how you handled ambiguity in one project story')
          : fact('t1', 'advice', 'lead every interview answer with the result, then the story'),
      ];
      over.promises = ['send my resume by Friday'];
      break;
    case 'nurture':
      kind = 'nurture';
      over.chat = { completedAt: ago(45), meetingAt: ago(45), stage: 'completed' };
      over.update = updateFor(p) || undefined;
      break;
    case 'congratulate':
      kind = 'congratulate';
      over.chat = { completedAt: ago(90), stage: 'completed' };
      // a promotion where they are (the role it replaced was at the same company), or a first role on record
      over.newAffiliation = {
        title: person.title
          ? /^(senior|head|chief|vice|managing|general)/i.test(person.title)
            ? `Head of ${p.goal.roleLabel.replace(/ intern$/i, '')}`
            : `Senior ${person.title}`
          : 'Director',
        org: person.org ?? 'Ramp',
        since: ago(12),
        ...(person.org ? { previousOrg: person.org } : {}),
      };
      break;
    case 'referral_ask':
      kind = 'referral_ask';
      over.chat = { completedAt: ago(14), meetingAt: ago(14), stage: 'completed' };
      over.targetCompany = {
        name: person.org ?? p.goal.orgs.alum,
        roleLabel: p.goal.roleLabel,
        applied: true,
      };
      break;
    case 'intro_request':
      kind = 'intro_request';
      over.chat = { completedAt: ago(20), meetingAt: ago(20), stage: 'completed' };
      over.target = {
        name: 'Lena Novak',
        firstName: 'Lena',
        title: `${p.goal.alumTitle}`,
        org: person.org ?? p.goal.orgs.alum,
        // as apps/web/src/engine/drafts.ts builds it: a noun phrase, and the student's own line when they typed one
        why: `their work at ${person.org ?? p.goal.orgs.alum}`,
        ...(Number(p.id.slice(1)) % 2 ? { whyLine: 'She works on the team I am applying to.' } : {}),
      };
      break;
    case 'reply_question':
      kind = 'reply';
      over.thread = inbound(
        p,
        'Thanks for writing. What kind of roles are you looking at, and when do you graduate?',
        sent,
      );
      over.answer = answerFor(p) || undefined;
      over.proposedWindows = windows(p);
      break;
    case 'reply_question_llm':
      // the same question, with the asks extracted the way the LLM extractor returns them
      kind = 'reply';
      over.thread = {
        ...inbound(
          p,
          'Thanks for writing. What kind of roles are you looking at, and when do you graduate?',
          sent,
        ),
        asksOfUser: ['What kind of roles are you looking at?', 'When do you graduate?'],
      };
      over.answer = answerFor(p) || undefined;
      over.proposedWindows = windows(p);
      break;
    case 'reply_interested':
      kind = 'reply';
      over.thread = inbound(p, 'Sure, happy to help. Send me a couple of times that work.', sent);
      over.proposedWindows = windows(p);
      break;
    case 'reply_referral':
      kind = 'reply';
      over.thread = inbound(
        p,
        "I'm not the best person for this, but my colleague Tom Reyes runs that team. I've cc'd him here.",
        sent,
      );
      break;
    case 'reply_not_now':
      kind = 'reply';
      over.thread = inbound(
        p,
        'Swamped until after the holidays. Ping me again in January and we can find time.',
        sent,
      );
      break;
  }
  return { ctx: { ...base, ...over, kind }, persona: p, recipient: r, scenario: s };
}
