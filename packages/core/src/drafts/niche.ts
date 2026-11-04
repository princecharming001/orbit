/**
 * Niche drafting playbooks (plan 30). One resolver says which situation a message is in (an IB coffee chat, a lab
 * position, a startup role that is open now...), and one playbook per niche says what that niche expects at each
 * step: the first message, the follow-up, the reply and the thank-you. Both draft prompts (the server's composeDraft
 * and the browser's LLM draft) read these, so the niche logic lives in one place. The norms are written from public
 * guidance, cited per niche, in Orbit's own words; nothing is copied from a source.
 *
 * A situation no playbook covers resolves to `general`; a goal can carry its own short brief (`goalBrief`, written
 * once when the goal is set) that rides along with the general playbook, so a niche Orbit did not pre-build still
 * gets its norms.
 */
import { ASK_RULES } from '../knowledge/index';
import type { ComposedMessage, GoalKind, MessageKind, Sector } from '../types';
import { type FirmKind, firmKindOf, sectorOf } from './sector';

export type Niche =
  | 'ib_coffee_chat'
  | 'consulting_coffee_chat'
  | 'finance_coffee_chat'
  | 'tech_recruiting'
  | 'startup_job'
  | 'research_position'
  | 'research_collaboration'
  | 'fundraising'
  | 'sales'
  | 'hiring'
  | 'advice'
  | 'cofounder'
  | 'community'
  | 'general';

export interface NicheInput {
  goalKind: GoalKind;
  /** the goal's title, description and the student's aim, in their words */
  goalText?: string;
  recipient: { title?: string; org?: string; industry?: string };
  /** the student's target functions ("Investment Banking", "Software Engineering") */
  targetFunctions?: string[];
  /** the student's degree ("BS", "PhD"): a PhD writing to a professor is a collaboration, an undergraduate a position */
  degree?: string;
}

const JOB_NOW =
  /\b(hiring|open (role|position)s?|job (post|posting|listing)|apply(ing)? (for|to)|founding (engineer|ml|designer|pm)|new[- ]grad|full[- ]time (role|job)|internship at (a|an) (startup|seed|series))/i;
const STARTUP_GOAL = /\b(startups?|seed|series [ab]|early[- ]stage|yc|y combinator|founding)\b/i;
const RESEARCH_GOAL =
  /\b(research (position|assistant|opportunit|experience|lab)|undergrad(uate)? research|\bRA\b|lab position|join (a|the|their|his|her) (lab|group)|(a|the) lab\b|reu\b|urop\b|pura\b|research this (summer|fall|spring|winter))/i;
const COLLAB_GOAL = /\b(collaborat|co-?author|joint (paper|project)|research partner)/i;
const GRAD_DEGREE = /\b(phd|ph\.d|doctoral|postdoc)\b/i;

/** Which playbook a message follows. Pure and deterministic: the same inputs always give the same niche. */
export function nicheFor(i: NicheInput): Niche {
  const goal = i.goalText ?? '';
  const sector: Sector = sectorOf(i.recipient, i.targetFunctions ?? []);
  const firm: FirmKind = firmKindOf(i.recipient, sector, i.targetFunctions ?? []);
  switch (i.goalKind) {
    case 'fundraising':
    case 'sales':
    case 'hiring':
    case 'cofounder':
    case 'community':
      return i.goalKind;
    case 'collaboration':
      return firm === 'academic' && !GRAD_DEGREE.test(i.degree ?? '') && RESEARCH_GOAL.test(goal)
        ? 'research_position'
        : 'research_collaboration';
    default:
      break;
  }
  // recruiting and advice: the recipient and the words of the goal decide
  if (firm === 'academic' || RESEARCH_GOAL.test(goal))
    return GRAD_DEGREE.test(i.degree ?? '') || COLLAB_GOAL.test(goal)
      ? 'research_collaboration'
      : 'research_position';
  if (firm === 'startup' && (JOB_NOW.test(goal) || STARTUP_GOAL.test(goal))) return 'startup_job';
  if (STARTUP_GOAL.test(goal) && JOB_NOW.test(goal)) return 'startup_job';
  if (firm === 'bank') return 'ib_coffee_chat';
  if (firm === 'consulting') return 'consulting_coffee_chat';
  if (firm === 'pe' || firm === 'vc' || firm === 'trading') return 'finance_coffee_chat';
  if (firm === 'big_tech' || firm === 'tech' || firm === 'startup') return 'tech_recruiting';
  return i.goalKind === 'advice' ? 'advice' : 'general';
}

/** The step of a conversation a message is: what the playbook says differs for each. */
export type NicheStep = 'first' | 'follow_up' | 'reply' | 'thank_you' | 'other';

export function stepOf(kind: MessageKind): NicheStep {
  switch (kind) {
    case 'first_touch':
    case 'warm_first_touch':
    case 'outreach':
    case 'intro_request':
    case 'referral_ask':
      return 'first';
    case 'bump':
      return 'follow_up';
    case 'reply':
    case 'schedule':
      return 'reply';
    case 'thank_you':
      return 'thank_you';
    default:
      return 'other';
  }
}

export interface NichePlaybook {
  /** a short name for logs and the chat ("an IB coffee chat") */
  label: string;
  first: string;
  followUp: string;
  reply: string;
  thankYou: string;
  /** a first message's word range */
  firstWords: [number, number];
  /** where the norms come from, checked 2026-11-03 */
  sources: string[];
}

const COMMON_FOLLOW_UP =
  'Open by pointing back to the first note in a few words ("Following up on my note from last week about ..."), keep who the student is and the real link in one clause, add one new, true line (something they did since, a sharper question, a recent fact about them), and repeat the same ask in one line. Never "just bumping this", "circling back", "bringing this to the top of your inbox" or "in case it got buried", and no guilt.';

/** What every reply that sets up a call does, whatever the niche. */
const COMMON_REPLY =
  'If they named a time, check it against the free hours and take it when it is free; never turn down a free time they offered. Otherwise offer two or three exact start times (day, date, time and zone) inside the free hours that fit the week they named, at different times of day. Say how long and phone or video. Never write "I\'m flexible, pick a time": choosing is the student\'s job. Only when nothing free fits, give the scheduling link or ask for two times that suit them. Never invent availability or hours the inputs do not give. Thanks in a few words, no gushing, no new questions.';

export const NICHE_PLAYBOOKS: Record<Niche, NichePlaybook> = {
  ib_coffee_chat: {
    label: 'an investment banking coffee chat',
    first:
      'Four to six short sentences. Open with the real link (same school or club, a referral, a shared employer) or one specific thing about their group. One line on who the student is, only the most relevant fact. Ask for 15 to 20 minutes by phone or Zoom to hear how they chose their group and what their first year has been like. Never a job, an interview, a referral, "openings" or a resume in a first message. Sign off with the full name.',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP} Bankers expect a follow-up; two in total is normal.`,
    reply:
      'They said yes: thank them in a few words, then offer two or three concrete times from the free slots (or take the time they gave), say phone or Zoom and how long, and stop. No new questions, no pitch.',
    thankYou:
      'Within a day of the call: one specific thing they said and what the student will do with it, then a light permission to keep in touch. Never ask for a referral in the thank-you.',
    firstWords: [60, 120],
    sources: [
      'https://mergersandinquisitions.com/investment-banking/recruitment/networking/',
      'https://www.wallstreetoasis.com/forum/investment-banking/what-kind-of-networking-cold-emails-do-you-respond-to',
      'https://banking-at-michigan.squarespace.com/s/Email-Guide-for-IB-Recruitment-2.pdf',
    ],
  },
  consulting_coffee_chat: {
    label: 'a consulting coffee chat',
    first:
      'Four to six short sentences. Open with the real link (school, club, office city) or one specific thing about their practice or office. One line on who the student is. Ask for 15 to 20 minutes to hear how they chose the firm and their office or practice, and what their first year of staffing was like. Never a referral, an interview or "openings" in a first message.',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply:
      'They said yes: thank them briefly, take their time or offer two or three concrete times from the free slots, confirm the medium and length, and stop.',
    thankYou:
      'Within a day: one specific thing they said (about staffing, the case, the office) and what the student took from it, then a light permission to stay in touch.',
    firstWords: [60, 120],
    sources: [
      'https://mergersandinquisitions.com/investment-banking/recruitment/networking/',
      'https://www.preplounge.com/en/blog/finance/investment-banking/interview/cold-email-ib',
    ],
  },
  finance_coffee_chat: {
    label: 'a coffee chat in private equity, venture or trading',
    first:
      'Four to six short sentences. The real link or one specific thing about their firm or a deal or post of theirs. One line on who the student is. Ask for 15 to 20 minutes on how they made the move into their seat and what the work is really like. Never a job or a referral in a first message.',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply:
      'They said yes: thank them briefly, offer two or three concrete times from the free slots or take theirs, confirm the medium and length.',
    thankYou: 'Within a day: one specific thing they said and what the student will do with it.',
    firstWords: [60, 120],
    sources: ['https://mergersandinquisitions.com/investment-banking/recruitment/networking/'],
  },
  tech_recruiting: {
    label: 'a recruiting chat with an engineer, PM or designer',
    first:
      'Three to five sentences. The real link or one specific thing about their team or product. One line of proof about the student (something they built, with a result, or a link) rather than adjectives. Ask for 15 minutes on what the team owns and how they got there. Never a referral to a stranger in a first message.',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply:
      'They said yes: thank them briefly, offer two or three concrete times from the free slots or take theirs, confirm the length.',
    thankYou: 'Within a day: one specific thing they said and what the student will do with it.',
    firstWords: [50, 110],
    sources: ['https://www.1752.vc/learn/how-to-cold-email-a-startup-founder-for-a-job'],
  },
  startup_job: {
    label: 'a note to a startup about a role it is hiring for now',
    first:
      'Direct and concrete, 60 to 130 words. Name the role (from the topic or facts) and one specific thing about the product or a recent launch that shows real interest. One or two lines of proof of work: what the student built or shipped, with the result, and a link only if the inputs give one. One line on why this company now. The ask: a short call about the role, or the best way to be considered. Interest in the open role is welcome here; never "any openings?", never a referral ask to a stranger, never "passionate about startups".',
    followUp:
      'After about a week, point back to the first note and the role in a few words, then one new thing: a small idea for their product, a quick take on their launch, or a piece of work with its result, and the same ask in one line. Stop after two follow-ups.',
    reply:
      'They want to talk: say yes, take their time or offer two or three concrete times from the free slots, and answer what they asked (a GitHub link, hours, a start date) with what the student gave. Short.',
    thankYou:
      'Within a day: thank them, one thing from the conversation that made the role more interesting, and anything promised (a link, a sample) or when it will come.',
    firstWords: [60, 130],
    sources: [
      'https://www.1752.vc/learn/how-to-cold-email-a-startup-founder-for-a-job',
      'https://nextplayso.substack.com/p/extremely-practical-advice-for-getting',
      'https://www.colinkeeley.com/blog/cold-email-your-way-into-an-internshipjob-at-any-startup',
    ],
  },
  research_position: {
    label: 'an undergraduate asking about a place in a lab',
    first:
      'Formal and warm: "Dear Professor X" (a PhD student or postdoc by first name). 80 to 180 words in two or three short paragraphs. Name one specific paper or project of theirs from the facts and one honest sentence on what drew the student to it, never a copied summary. Their year and major, the relevant coursework or skills, any lab or project experience, or plainly that they are new and eager to learn. Their availability (hours a week, which terms) when the inputs give it. The ask: whether there might be a place for an undergraduate in the lab, or a short meeting to talk about it. Offer to send a CV and transcript; never say they are attached. Never flattery, never asking about pay first. Subject names the research area and that they are an undergraduate.',
    followUp:
      'After one to two weeks, three or four polite sentences: point back to the first note and the paper it named, restate year and major in one clause, the availability again, one new detail (a course finished, a skill picked up) if the inputs give one, and the same ask. Professors are busy and a follow-up is normal.',
    reply:
      'Answer exactly what they asked (availability, interests, CV) with what the student gave, offer times if a meeting is proposed, and say the CV or transcript will follow rather than claiming an attachment. Short and formal.',
    thankYou:
      'After meeting: thank them, one thing they said about the project, and the next step that was agreed (a reading, a start date, a form).',
    firstWords: [80, 180],
    sources: [
      'https://urop.mit.edu/students/resources/approaching-faculty/email-templates/',
      'https://exl.cns.utexas.edu/do-research/find-research-lab/how-reach-out-professors',
      'https://our.unc.edu/find/emails-to-faculty/',
      'https://pcur.princeton.edu/2025/04/21/cracking-cold-emails-reaching-out-to-professors-in-a-way-that-works/',
    ],
  },
  research_collaboration: {
    label: 'a researcher proposing a collaboration',
    first:
      'Precise and collegial, 50 to 150 words. One specific question about their paper and the overlap with the student’s own work, named concretely. The ask: a 20 minute call to compare notes, or whether they would be open to it. Never flattery, never a vague "let’s collaborate".',
    followUp: `After about two weeks, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply: 'Answer what they said, propose concrete times from the free slots if they want to talk, short.',
    thankYou: 'After the call: the one idea agreed on and the next step with its owner.',
    firstWords: [50, 150],
    sources: ['https://urop.mit.edu/students/resources/approaching-faculty/email-templates/'],
  },
  fundraising: {
    label: 'a founder writing to an investor',
    first:
      'Crisp, numbers first: two lines on what the company does and why now, one line of traction only if the inputs give one, then "would you be open to a look?" Never a valuation, a fake deadline or the whole pitch.',
    followUp: `After about a week, two sentences with one new number or milestone if the inputs give one. ${COMMON_FOLLOW_UP}`,
    reply:
      'Answer what they asked, offer times from the free slots, and send what they asked for if the inputs have it.',
    thankYou: 'After the meeting: thank them, the one question they raised and when the answer comes.',
    firstWords: [50, 120],
    sources: ['packages/core/src/knowledge/fundraising.md'],
  },
  sales: {
    label: 'a first sales note',
    first:
      'Short and concrete: the trigger or a specific observation about them, what the product does for people like them in plain words with one result if the inputs give one, then "worth a quick look?" with an out.',
    followUp: `After about a week, one new reason it matters to them now. ${COMMON_FOLLOW_UP}`,
    reply: 'Answer what they said and offer times from the free slots. No feature list.',
    thankYou: 'After the call: the one problem they named and the next step.',
    firstWords: [40, 90],
    sources: ['packages/core/src/knowledge/sales.md'],
  },
  hiring: {
    label: 'a founder recruiting someone',
    first:
      'Direct and respectful of their current job: why them (something they built or did), the company and stage and the one thing that makes the role interesting, then "open to hearing about it?"',
    followUp: `After about a week, one new line about the role or the team. ${COMMON_FOLLOW_UP}`,
    reply: 'Answer what they asked and offer times from the free slots.',
    thankYou: 'After the call: thank them and the next step.',
    firstWords: [50, 110],
    sources: ['packages/core/src/knowledge/hiring.md'],
  },
  advice: {
    label: 'asking someone for advice',
    first:
      'Warm and humble: the real link, the one question only this person can answer, and 15 to 20 minutes with an easy out. Never "any advice you have", never "be my mentor".',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply: 'Thank them briefly, take their time or offer two or three concrete times from the free slots.',
    thankYou: 'Within a day: what they said and what the student will do with it.',
    firstWords: [50, 120],
    sources: ['packages/core/src/knowledge/advice.md'],
  },
  cofounder: {
    label: 'looking for a co-founder',
    first:
      'Peer to peer: what the student is building and why, why this person (what they built or spent years inside), and 20 minutes to compare notes on the problem. Never equity or titles.',
    followUp: `After about a week, one new line on the problem or progress. ${COMMON_FOLLOW_UP}`,
    reply: 'Answer what they said and offer times from the free slots.',
    thankYou: 'After the call: the one thing to try next and who does it.',
    firstWords: [50, 120],
    sources: ['packages/core/src/knowledge/cofounder.md'],
  },
  community: {
    label: 'an invitation to an event or group',
    first:
      'Friendly and concrete: the named event or group with the date and place, who else is coming if the inputs say so, why this person would add something, and a plain invitation.',
    followUp: 'Closer to the date, one line with the details and the invitation again.',
    reply: 'Confirm the details they asked about.',
    thankYou: 'After the event: thank them for coming and one thing from it.',
    firstWords: [40, 100],
    sources: ['packages/core/src/knowledge/community.md'],
  },
  general: {
    label: 'a networking message',
    first:
      'The real link or one specific thing about them, one line on who the student is, and one small, clear ask with an easy out.',
    followUp: `After about a week, two or three sentences. ${COMMON_FOLLOW_UP}`,
    reply: 'Answer what they said, offer concrete times from the free slots if they want to talk, short.',
    thankYou: 'Within a day: one specific thing they said and what the student will do with it.',
    firstWords: [50, 120],
    sources: ['packages/core/src/knowledge/etiquette.md'],
  },
};

type AskKind = ComposedMessage['ask']['kind'];

/** How a niche's messages are shaped beyond the words of its playbook: the ask a first message carries, how plain the
 * prose must read, the greeting when the niche fixes one (it wins over the student's voice card), and how long a
 * call it asks for. */
export interface NicheForm {
  ask: AskKind;
  /** the highest reading grade a message may have: academic writing runs a little denser than a coffee chat */
  gradeMax: number;
  greeting?: string;
  callMinutes?: number;
}

export const NICHE_FORM: Record<Niche, NicheForm> = {
  ib_coffee_chat: { ask: 'call', gradeMax: 7, callMinutes: 15 },
  consulting_coffee_chat: { ask: 'call', gradeMax: 7, callMinutes: 15 },
  finance_coffee_chat: { ask: 'call', gradeMax: 7, callMinutes: 15 },
  tech_recruiting: { ask: 'call', gradeMax: 7, callMinutes: 15 },
  startup_job: { ask: 'call', gradeMax: 8, callMinutes: 20 },
  research_position: {
    ask: 'question',
    gradeMax: 10,
    greeting:
      '"Dear Professor <last name>," for faculty (a PhD student, postdoc or lab manager by first name), whatever <voice> uses for greetings',
    callMinutes: 20,
  },
  research_collaboration: {
    ask: 'question',
    gradeMax: 10,
    greeting: '"Dear Professor <last name>," for faculty not yet met, whatever <voice> uses for greetings',
    callMinutes: 20,
  },
  fundraising: { ask: 'interest', gradeMax: 8, callMinutes: 30 },
  sales: { ask: 'interest', gradeMax: 7, callMinutes: 20 },
  hiring: { ask: 'interest', gradeMax: 7, callMinutes: 20 },
  advice: { ask: 'call', gradeMax: 7, callMinutes: 15 },
  cofounder: { ask: 'call', gradeMax: 7, callMinutes: 20 },
  community: { ask: 'question', gradeMax: 7 },
  general: { ask: 'call', gradeMax: 7, callMinutes: 15 },
};

/** Niches whose first message is a conversation about someone's work, where what to ask depends on the kind of firm
 * (ASK_RULES): a bank's group, a consulting office, a tech team. */
const FIRM_ASK_NICHES: ReadonlySet<Niche> = new Set([
  'ib_coffee_chat',
  'consulting_coffee_chat',
  'finance_coffee_chat',
  'tech_recruiting',
  'advice',
  'general',
]);

/** A first message's word range in this niche (sales keeps the shorter range a cold sales note needs). */
export function nicheWords(niche: Niche): [number, number] {
  return NICHE_PLAYBOOKS[niche].firstWords;
}

export interface DraftPlaybook {
  niche: Niche;
  label: string;
  form: NicheForm;
  /** the numbered-rule lines both draft prompts append, in order */
  lines: string[];
}

/**
 * Everything a draft prompt needs from the playbooks for one message: the niche, its form, and its rules for this
 * step (plus what to ask this kind of firm on a first message, and the greeting the niche fixes). The one entry point
 * the server's composeDraft and the browser's LLM draft share, so both resolve the niche the same way.
 */
export function draftPlaybook(i: NicheInput & { kind: MessageKind; goalBrief?: string }): DraftPlaybook {
  const niche = nicheFor(i);
  const form = NICHE_FORM[niche];
  const lines = nicheRules(niche, i.kind, i.goalBrief);
  const step = stepOf(i.kind);
  if (step === 'first' && FIRM_ASK_NICHES.has(niche)) {
    const sector = sectorOf(i.recipient, i.targetFunctions ?? []);
    lines.push(ASK_RULES[firmKindOf(i.recipient, sector, i.targetFunctions ?? [])]);
  }
  if (form.greeting && step !== 'other') lines.push(`Greeting: ${form.greeting}.`);
  if (form.callMinutes && (step === 'first' || step === 'reply'))
    lines.push(
      `A call here is ${form.callMinutes} minutes unless they named a length; a reply that sets one up says the length and phone or video.`,
    );
  return { niche, label: NICHE_PLAYBOOKS[niche].label, form, lines };
}

/** The lines a draft prompt carries for this niche and step, plus the goal's own brief when it has one. */
export function nicheRules(niche: Niche, kind: MessageKind, goalBrief?: string): string[] {
  const p = NICHE_PLAYBOOKS[niche];
  const step = stepOf(kind);
  const rule =
    step === 'first'
      ? p.first
      : step === 'follow_up'
        ? p.followUp
        : step === 'reply'
          ? `${p.reply} ${COMMON_REPLY}`
          : step === 'thank_you'
            ? p.thankYou
            : '';
  const out = rule ? [`This is ${p.label}. ${rule}`] : [];
  const brief = goalBrief?.trim();
  if (brief) out.push(`For this goal in particular: ${brief.slice(0, 700)}`);
  return out;
}
