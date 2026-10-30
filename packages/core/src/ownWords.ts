/**
 * The student's own words about their goals (plan 24): the written answers setup asks for and Settings edits. Each is
 * optional. This module keeps them clean and says them back to the systems that read them (the chat's snapshot, the
 * server's compose context), so every reader words them the same way.
 */
import type { RecruitingGoals } from './types';

export type OwnWordsKey =
  | 'aim'
  | 'success'
  | 'story'
  | 'proudOf'
  | 'wantToMeet'
  | 'networkingHard'
  | 'neverDo';

export const OWN_WORDS_KEYS: readonly OwnWordsKey[] = [
  'aim',
  'success',
  'story',
  'proudOf',
  'wantToMeet',
  'networkingHard',
  'neverDo',
];

/** The longest answer kept, in characters: a few sentences, never an essay. */
export const OWN_WORDS_MAX = 600;
/** The longest job link or job note kept. */
export const CURRENT_JOB_MAX = 500;

export type CurrentJob = NonNullable<RecruitingGoals['currentJob']>;
export type OwnWords = Partial<Record<OwnWordsKey, string>> & { currentJob?: CurrentJob };

/** One written question, as setup and Settings ask it. */
export interface OwnWordsQuestion {
  key: OwnWordsKey;
  label: string;
  placeholder: string;
}

export const OWN_WORDS_QUESTIONS: Record<OwnWordsKey, OwnWordsQuestion> = {
  aim: {
    key: 'aim',
    label: 'What are you going for, and why?',
    placeholder:
      "Product roles at fintech startups. I grew up helping run my family's store and want to build tools for small businesses.",
  },
  success: {
    key: 'success',
    label: 'What would make this cycle a win, and by when?',
    placeholder: "Five real conversations with PMs by November, and an offer I'm excited about by February.",
  },
  story: {
    key: 'story',
    label: 'Your story in two lines',
    placeholder:
      "I'm a junior at Michigan studying economics. Last summer I built pricing models at a fintech startup, and I run our investing club's education program.",
  },
  proudOf: {
    key: 'proudOf',
    label: 'What are you good at, or proud of?',
    placeholder: 'Explaining hard ideas simply. I taught 40 first-years how to read a balance sheet.',
  },
  wantToMeet: {
    key: 'wantToMeet',
    label: 'Who do you most want to meet?',
    placeholder: 'Alumni one or two years into product roles, and anyone on the payments team at Stripe.',
  },
  networkingHard: {
    key: 'networkingHard',
    label: "What's hard about networking for you right now?",
    placeholder:
      "I freeze on what to say after hello, and asking for someone's time feels like asking a favor.",
  },
  neverDo: {
    key: 'neverDo',
    label: 'Anything Orbit should never do?',
    placeholder: 'Never mention my GPA. No exclamation marks.',
  },
};

/** An answer as kept: trimmed, at most two line breaks in a row, capped; nothing written is undefined. */
export function cleanAnswer(v: unknown, max = OWN_WORDS_MAX): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t ? t.slice(0, max).trim() : undefined;
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')]+)/i;

/** A link as kept: https added to a bare www address, trailing punctuation dropped; undefined when it is not one. */
export function cleanJobUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let u = v.trim().replace(/[.,;:!?]+$/, '');
  if (!u) return undefined;
  if (/^www\./i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (!parsed.hostname.includes('.')) return undefined;
    return u.slice(0, CURRENT_JOB_MAX);
  } catch {
    return undefined;
  }
}

/** A job as kept: a link, a note, or both; undefined when neither is there. */
export function cleanCurrentJob(v: unknown): CurrentJob | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { url?: unknown; text?: unknown };
  const url = cleanJobUrl(o.url);
  const text = cleanAnswer(o.text, CURRENT_JOB_MAX);
  if (!url && !text) return undefined;
  return { ...(url ? { url } : {}), ...(text ? { text } : {}) };
}

/**
 * What the student typed in the job box, split into the posting's link and the rest ("Stripe, the PM intern role"):
 * "https://jobs.lever.co/acme/123 PM intern" is both.
 */
export function parseCurrentJob(input: string): CurrentJob | undefined {
  const m = URL_RE.exec(input);
  const url = m ? cleanJobUrl(m[1]) : undefined;
  const rest = m && url ? input.replace(m[1]!, ' ') : input;
  const text = cleanAnswer(rest.replace(/^[\s,;:|-]+|[\s,;:|-]+$/g, ''), CURRENT_JOB_MAX);
  return cleanCurrentJob({ url, text });
}

/** The job box's text for a stored job: the note, then the link. */
export function currentJobInput(j: CurrentJob | undefined): string {
  if (!j) return '';
  return [j.text, j.url].filter(Boolean).join(' ');
}

/** A job in a few words: the note, or the link's site and path ("jobs.lever.co/acme"). */
export function currentJobLabel(j: CurrentJob | undefined): string | undefined {
  if (!j) return undefined;
  if (j.text) return j.text;
  if (!j.url) return undefined;
  try {
    const u = new URL(j.url);
    const path = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return `${u.hostname.replace(/^www\./, '')}${path ? `/${path}` : ''}`;
  } catch {
    return j.url;
  }
}

/** The written answers of a goals row, cleaned (an old row may carry anything). */
export function ownWordsOf(g: Partial<RecruitingGoals> | undefined | null): OwnWords {
  const out: OwnWords = {};
  if (!g) return out;
  for (const k of OWN_WORDS_KEYS) {
    const v = cleanAnswer(g[k]);
    if (v) out[k] = v;
  }
  const job = cleanCurrentJob(g.currentJob);
  if (job) out.currentJob = job;
  return out;
}

/** How many of the eight written questions have an answer (the job counts as one). */
export function answeredCount(g: Partial<RecruitingGoals> | undefined | null): number {
  const w = ownWordsOf(g);
  return OWN_WORDS_KEYS.filter((k) => w[k]).length + (w.currentJob ? 1 : 0);
}

export const OWN_WORDS_TOTAL = OWN_WORDS_KEYS.length + 1;

/** The order the answers are said in: what they are going for first, how they want to come across last. */
const LINE_ORDER: readonly OwnWordsKey[] = [
  'aim',
  'success',
  'story',
  'proudOf',
  'wantToMeet',
  'networkingHard',
];

/** For a conversation with the student: their rule and the tone first, then what they want. */
export const CHAT_LINE_ORDER: readonly OwnWordsKey[] = [
  'networkingHard',
  'aim',
  'success',
  'wantToMeet',
  'story',
  'proudOf',
];

/** How each answer is introduced to a model reading about the student. */
const LINE_LABELS: Record<OwnWordsKey, string> = {
  aim: 'Going for',
  success: 'A good cycle looks like',
  story: 'Their story',
  proudOf: 'Good at or proud of',
  wantToMeet: 'Wants to meet',
  networkingHard: 'Finds hard about networking (set your tone by it)',
  neverDo: 'Never (their own rule, always follow it)',
};

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * The answers as lines for a model's context ("Their story: ..."), each on one line and at most `max` characters, in
 * the order they matter to a conversation. Nothing written gives no lines.
 */
export function ownWordsLines(
  g: Partial<RecruitingGoals> | OwnWords | undefined | null,
  max = 240,
  /** the answers in the order a reader needs them most; the never rule always comes first */
  order: readonly OwnWordsKey[] = LINE_ORDER,
): string[] {
  const w = ownWordsOf(g as Partial<RecruitingGoals>);
  const lines: string[] = [];
  for (const k of ['neverDo', ...order.filter((x) => x !== 'neverDo')] as OwnWordsKey[])
    if (w[k]) lines.push(`${LINE_LABELS[k]}: ${clip(w[k]!, max)}`);
  if (w.currentJob) {
    const job = [w.currentJob.text, w.currentJob.url].filter(Boolean).join(', ');
    lines.push(`Going for this job now: ${clip(job, max)}`);
  }
  return lines;
}
