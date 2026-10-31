/**
 * The playbook (plan 28 §3): what a sharp friend who has done this knows, as prose the chat model, the draft prompt
 * and the prep page can all read. The text lives in the .md files next to this one and is bundled into bundle.ts by
 * scripts/knowledge-bundle.mjs; this module picks sections for a student's goals, answers a topic lookup, and carries
 * the short per-goal and per-firm rules the draft prompt appends.
 */
import type { FirmKind } from '../drafts/sector';
import type { GoalKind } from '../types';
import { KNOWLEDGE_FILES } from './bundle';

export type KnowledgeId =
  | 'etiquette'
  | 'glossary'
  | 'ib'
  | 'consulting'
  | 'tech'
  | 'pm'
  | 'data-design'
  | 'vc-job'
  | 'quant'
  | 'finance-other'
  | 'fundraising'
  | 'sales'
  | 'hiring'
  | 'advice'
  | 'cofounder'
  | 'community'
  | 'collaboration';

export const KNOWLEDGE_IDS: readonly KnowledgeId[] = [
  'etiquette',
  'glossary',
  'ib',
  'consulting',
  'tech',
  'pm',
  'data-design',
  'vc-job',
  'quant',
  'finance-other',
  'fundraising',
  'sales',
  'hiring',
  'advice',
  'cofounder',
  'community',
  'collaboration',
];

export interface KnowledgeSection {
  id: KnowledgeId;
  title: string;
  body: string;
  words: number;
}

/** Words in the frozen block at most: about 3k tokens, so the goal sections never crowd out the tools. */
export const KNOWLEDGE_WORD_BUDGET = 2200;
/** Goal sections in the block at most; the rest is one lookup_playbook call away. */
export const KNOWLEDGE_MAX_GOAL_SECTIONS = 2;

const wordsIn = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function knowledgeSection(id: KnowledgeId): KnowledgeSection {
  const f = KNOWLEDGE_FILES[id];
  if (!f) throw new Error(`no knowledge section ${id}`);
  return { id, title: f.title, body: f.body, words: wordsIn(f.body) };
}

/** The student's target function codes (goals.targetFunctions) to the recruiting section that covers them. */
const SECTION_FOR_FUNCTION: Record<string, KnowledgeId> = {
  ib: 'ib',
  banking: 'ib',
  finance: 'finance-other',
  pe: 'finance-other',
  consulting: 'consulting',
  swe: 'tech',
  eng: 'tech',
  pm: 'pm',
  product: 'pm',
  design: 'data-design',
  data: 'data-design',
  vc: 'vc-job',
  quant: 'quant',
  trading: 'quant',
  research: 'collaboration',
};

const SECTION_FOR_GOAL: Record<Exclude<GoalKind, 'recruiting'>, KnowledgeId> = {
  fundraising: 'fundraising',
  sales: 'sales',
  hiring: 'hiring',
  advice: 'advice',
  cofounder: 'cofounder',
  community: 'community',
  collaboration: 'collaboration',
};

/** Role names ("Investment Banking Summer Analyst", "Product Manager intern") to a function code. */
export function functionsFromText(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  const add = (f: string) => {
    if (!out.includes(f)) out.push(f);
  };
  if (/\b(investment bank\w*|banking|\bib\b|m&a|leveraged finance|capital markets)\b/.test(t)) add('ib');
  if (/\bconsult/.test(t)) add('consulting');
  if (/\b(quant\w*|trader|trading)\b/.test(t)) add('quant');
  if (/\b(venture|\bvc\b|investor|investing)\b/.test(t)) add('vc');
  if (
    /\b(private equity|equity research|asset management|hedge fund|wealth management|corporate finance)\b/.test(
      t,
    )
  )
    add('finance');
  if (/\b(product manager|product management|\bapm\b|\bpm\b)\b/.test(t)) add('pm');
  if (/\b(software|engineer\w*|developer|\bswe\b|\bsde\b|programm\w*)\b/.test(t)) add('swe');
  if (
    /\b(data scien\w*|data analy\w*|machine learning|\bml\b|analytics|designer|\bux\b|product design)\b/.test(
      t,
    )
  )
    add('data');
  if (/\b(research assistant|research\b|\blab\b|phd)\b/.test(t)) add('research');
  return out;
}

export interface KnowledgeGoal {
  kind: GoalKind;
  /** the goal's roles and title, for a recruiting goal with no function on file */
  targets?: { roles?: string[] };
  title?: string;
}

/**
 * The sections for a student: etiquette first and always, then up to two goal sections in the order of their goals
 * (a recruiting goal resolves through their target functions, then the goal's roles), within the word budget. What
 * does not fit is still one lookup_playbook call away, and the block says so.
 */
export function knowledgeFor(
  goals: readonly KnowledgeGoal[],
  functions: readonly string[] = [],
): KnowledgeSection[] {
  const wanted: KnowledgeId[] = [];
  const want = (id: KnowledgeId | undefined) => {
    if (id && id !== 'etiquette' && !wanted.includes(id)) wanted.push(id);
  };
  const fnIds = (fns: readonly string[]) =>
    fns.map((f) => SECTION_FOR_FUNCTION[f.toLowerCase().trim()]).filter((x): x is KnowledgeId => !!x);
  for (const g of goals) {
    if (g.kind === 'recruiting') {
      const fromFunctions = fnIds(functions);
      const fromRoles = fnIds(functionsFromText([g.title ?? '', ...(g.targets?.roles ?? [])].join(' ')));
      for (const id of [...fromFunctions, ...fromRoles]) want(id);
    } else want(SECTION_FOR_GOAL[g.kind]);
  }
  // a student with target functions and no tracked goal yet is still recruiting for them
  if (!goals.length) for (const id of fnIds(functions)) want(id);

  const out: KnowledgeSection[] = [knowledgeSection('etiquette')];
  let words = out[0]!.words;
  let goalSections = 0;
  for (const id of wanted) {
    if (goalSections >= KNOWLEDGE_MAX_GOAL_SECTIONS) break;
    const s = knowledgeSection(id);
    if (words + s.words > KNOWLEDGE_WORD_BUDGET) continue;
    out.push(s);
    words += s.words;
    goalSections++;
  }
  return out;
}

/** The block the chat prepends to the conversation: how to use it, then the sections. */
export function knowledgeBlockText(sections: readonly KnowledgeSection[]): string {
  const have = new Set(sections.map((s) => s.id));
  const others = KNOWLEDGE_IDS.filter((id) => !have.has(id));
  const head = [
    'Playbook. What a sharp friend who has done this knows, picked for this student. Answer a question about how a process works from it first, in your own words and only the part that matters for them right now; from their own data second; from the web only for a current fact.',
    "A line tagged [CHANGES YEARLY] gives the pattern, not this year's date: say the pattern, then check the date or the program on the web before stating one.",
    others.length ? `Other sections, through lookup_playbook: ${others.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return [head, ...sections.map((s) => `## ${s.title}\n\n${s.body}`)].join('\n\n');
}

/** Words a student uses for each section, for lookup_playbook. Longer phrases score first. */
const ALIASES: Record<KnowledgeId, string[]> = {
  etiquette: [
    'etiquette',
    'coffee chat',
    'thank you',
    'thank-you',
    'follow up',
    'follow-up',
    'follow ups',
    'follow-ups',
    'too many',
    'bump',
    'intro',
    'introduction',
    'double opt-in',
    'how many messages',
    'ghosted',
    'no reply',
    'linkedin note',
    'connection note',
    'resume',
    'send window',
    'when to send',
    'how long',
    'how often',
    'manners',
  ],
  glossary: [
    'glossary',
    'what is',
    'what does',
    'what are',
    'mean',
    'means',
    'term',
    'jargon',
    'define',
    'superday',
    'hirevue',
    'online assessment',
    'pei',
    'safe',
    'pro rata',
    'carry',
    'scout',
    'return offer',
    'off-cycle',
    'off cycle',
    'bulge bracket',
    'elite boutique',
    'term sheet',
    'vesting',
    'cap table',
    'runway',
  ],
  ib: [
    'investment banking',
    'banking',
    'bank',
    'banks',
    'ib',
    'summer analyst',
    'superday',
    'hirevue',
    'bulge bracket',
    'boutique',
    'goldman',
    'morgan stanley',
    'jpmorgan',
    'evercore',
    'm&a',
    'sponsorship',
    'exploding offer',
    'renege',
  ],
  consulting: [
    'consulting',
    'consultant',
    'case interview',
    'case prep',
    'mckinsey',
    'bcg',
    'bain',
    'mbb',
    'pei',
    'office choice',
    'staffing',
  ],
  tech: [
    'software',
    'software engineering',
    'swe',
    'engineer',
    'engineering',
    'coding interview',
    'leetcode',
    'big tech',
    'referral',
    'new grad',
    'startup job',
    'internship posting',
  ],
  pm: ['product manager', 'product management', 'apm', 'pm', 'product sense', 'rpm'],
  'data-design': [
    'data science',
    'data scientist',
    'data analyst',
    'analytics',
    'machine learning',
    'ml engineer',
    'design',
    'designer',
    'ux',
    'portfolio',
    'product design',
  ],
  'vc-job': [
    'vc job',
    'venture job',
    'venture capital job',
    'job in vc',
    'job in venture',
    'vc recruiting',
    'venture recruiting',
    'vc analyst',
    'vc associate',
    'become an investor',
    'scout program',
    'fellowship',
    'venture fellowship',
    'work in vc',
    'break into vc',
    'break into venture',
  ],
  quant: [
    'quant',
    'quantitative',
    'trading',
    'trader',
    'jane street',
    'citadel',
    'two sigma',
    'hrt',
    'optiver',
    'sig',
  ],
  'finance-other': [
    'private equity',
    'pe',
    'equity research',
    'sales and trading',
    's&t',
    'asset management',
    'hedge fund',
    'wealth management',
    'corporate finance',
    'fp&a',
    'commercial banking',
  ],
  fundraising: [
    'fundraising',
    'fundraise',
    'raise',
    'raising',
    'round',
    'seed',
    'pre-seed',
    'preseed',
    'series a',
    'safe',
    'investor',
    'investors',
    'vc call',
    'partner meeting',
    'term sheet',
    'lead investor',
    'pro rata',
    'valuation',
    'pitch',
    'deck',
    'investor update',
    'angel',
  ],
  sales: [
    'sales',
    'selling',
    'sell',
    'customer',
    'customers',
    'cold email',
    'cold outreach',
    'discovery call',
    'pilot',
    'buyer',
    'prospect',
    'demo',
    'pricing',
  ],
  hiring: [
    'hiring',
    'hire',
    'recruit a',
    'candidate',
    'candidates',
    'first engineer',
    'first hire',
    'job offer',
    'sourcing candidates',
    'passive candidates',
    'offer letter',
    'equity offer',
  ],
  advice: [
    'advice',
    'mentor',
    'mentors',
    'mentorship',
    'informational interview',
    'career change',
    'switch careers',
    'switching',
    'freshman',
    'first-year',
    'first year',
    'explore',
    'paths',
  ],
  cofounder: ['cofounder', 'co-founder', 'co founder', 'founding team', 'equity split', 'founder matching'],
  community: ['community', 'club', 'event', 'events', 'meetup', 'speaker', 'invite', 'invitation', 'sponsor'],
  collaboration: [
    'collaboration',
    'collaborate',
    'research',
    'professor',
    'lab',
    'paper',
    'phd',
    'postdoc',
    'academic',
    'research assistant',
    'faculty',
  ],
};

/**
 * The section for a topic a student typed ("how does vc recruiting work", "what is a superday"): the one whose
 * aliases match most, longer matches counting more; undefined when nothing matches.
 */
export function findPlaybookSection(topic: string): KnowledgeSection | undefined {
  const t = ` ${topic
    .toLowerCase()
    .replace(/[^a-z0-9&'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  if (!t.trim()) return undefined;
  const direct = KNOWLEDGE_IDS.find((id) => t.trim() === id);
  if (direct) return knowledgeSection(direct);
  let best: { id: KnowledgeId; score: number } | undefined;
  for (const id of KNOWLEDGE_IDS) {
    let score = 0;
    for (const a of ALIASES[id]) {
      const needle = ` ${a} `;
      if (t.includes(needle)) score += a.includes(' ') ? 3 : a.length > 3 ? 2 : 1;
    }
    if (score && (!best || score > best.score)) best = { id, score };
  }
  return best ? knowledgeSection(best.id) : undefined;
}

/** What a first message in each goal's register does; appended to the draft prompt (plan 28 §3b, rule 13). */
export const DRAFT_RULES: Record<GoalKind, string> = {
  recruiting:
    'Recruiting register: warm, curious, specific. The ask is a 15 minute call about their path and their team (20 for an alum). Never a job, a referral, a resume review or "openings" in a first message; proof of interest is one specific thing about them, not about the student.',
  fundraising:
    'Fundraising register: crisp, numbers first, confident. Two lines on what the company does and why now, one line of traction only if the context gives one, then "would you be open to a look?" Never a job hunting line, never a valuation, never a fake deadline, never the whole pitch.',
  sales:
    'Sales register: short, concrete, no hype. Open with the trigger or the specific observation about them, say what the product does for people like them in plain words with one result if the context gives one, then "worth a quick look?" with an out. No feature list, no attachment.',
  hiring:
    'Hiring register: direct and respectful of their current job. Line one is why them (something they built or did), line two the company, stage and the one thing that makes the role interesting, line three "open to hearing about it?" Never "exciting opportunity", never a pasted job description.',
  advice:
    'Advice register: warm, humble, specific. One real connection, the one question only this person can answer ("I\'m deciding between X and Y and you did both"), a 15 to 20 minute ask with an out. Never "any advice you have", never "be my mentor", never a resume.',
  cofounder:
    'Co-founder register: peer to peer. One line on what the student is building and why them, one line on why this person (what they built or spent years inside), a 20 minute ask to compare notes on the problem. Never equity, never a title, never "looking for a technical co-founder" as the opener.',
  community:
    'Community register: friendly and concrete. A named event or group with the date and place, two or three people they would know who are coming, why this person would add something, and a plain invitation. Never a mass invite, never a bare link.',
  collaboration:
    'Collaboration register: precise and academic. Name the specific paper or talk and the specific thing in it, ask one precise question or state one concrete overlap, and ask for an answer by email or 20 minutes. "Dear Professor Lastname" for faculty not yet met; never "I am passionate about research".',
};

/** What a first message to this kind of firm asks about and never asks (plan 28 §3b, rule 14). */
export const ASK_RULES: Record<FirmKind, string> = {
  bank: 'A banker is asked about their group and path: how they chose it, what the first year looks like, what separates the summer analysts who do well. Never about staffing or an office (consulting words), never whether the group still has seats, never off-cycle or diversity programs. When the summer cycle is already late, ask how they would approach recruiting from here, never "before recruiting starts".',
  pe: 'Someone in private equity is asked how they made the move and what surprised them about the work, or, if senior, what they look for in the analysts they hire. Never about a bank\'s group, summer analyst seats or "your bank".',
  trading:
    'A trader or researcher is asked how they prepared and what the first months were like, or how they chose between trading and research; a desk head gets one question only they can answer. Never "the office" or "your group".',
  vc: 'An investor is asked how they got into venture and what their week looks like, or whether to operate first; a founder raising money asks "would you be open to a look" with one line of traction. Never "your bank", never how juniors get staffed.',
  consulting:
    'A consultant is asked how they chose their office or practice, how staffing worked in their first year, or what case prep actually helped; a partner is asked for judgment, never about their first year. Never a "group" or a desk.',
  big_tech:
    'An engineer or PM at a large company is asked what the team owns, how intern projects are picked or what to practise; a manager what they look for; a VP or head for a pointer to someone closer to the intern class. Proof beats adjectives. Never a referral ask to a stranger in a first message.',
  tech: 'An engineer or PM is asked what the team owns, how they ended up there and what their first months were like; a manager what they look for in interns and new grads. One link to something the student built beats any adjective. Never a referral or "openings" in a first message to someone the student has not talked to.',
  startup:
    'A founder or early employee is asked how they joined so early and what the stage is like; a founder what they look for in early hires. Never a referral in message one.',
  academic:
    'A professor is asked about their research and how students take part, or whether they take undergraduate research assistants and what they look for in one. Never their "first few months" or "the path to" their university.',
  other:
    'Someone whose firm Orbit does not know is asked how they got into their field and what helped early on; a senior person what they look for in people starting out. Never bank, consulting or desk words.',
};
