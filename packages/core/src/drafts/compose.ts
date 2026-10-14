import type { ComposedMessage, GoalKind, MessageKind, PersonFact, StyleCard } from '../types';
import { BANNED_SUBJECT_PATTERNS, MAX_WORDS, MIN_WORDS, wordsIn } from './templates';
import { unsupportedDetails, type ValidationIssue, validateDraft } from './validate';

/**
 * Compose v2 checks (plan 16 §7.1, §7.5): the rules every composed message must pass, LLM or template, on top of the
 * v1 validator. Word range by kind and goal, a reading grade of 7 or lower, exactly one ask, a short plain subject,
 * a sourced hook in every first touch, LinkedIn length limits, no names or numbers the inputs do not contain, the
 * banned phrases, and no dashes or exclamation marks unless the student's own voice uses them.
 */

export type ComposeIssueCode =
  | 'words_out_of_range'
  | 'reading_grade'
  | 'no_ask'
  | 'several_asks'
  | 'subject_missing'
  | 'subject_length'
  | 'subject_case'
  | 'subject_banned'
  | 'hook_missing'
  | 'linkedin_too_long'
  | 'connection_note_too_long'
  | 'unknown_detail'
  | 'banned_phrase'
  | 'em_dash'
  | 'exclamation'
  | 'third_person'
  | ValidationIssue['code'];

export interface ComposeIssue {
  code: ComposeIssueCode;
  detail: string;
  blocking: boolean;
}

export interface ComposeContext {
  goal: GoalKind;
  recipientFirstName: string;
  recipientFullName?: string;
  recipientEmail?: string;
  /** everything the message may draw on (user context, recipient, research, thread, via), as text */
  inputs: string;
  /** links the message may contain (the student's scheduling link) */
  allowedUrls?: string[];
  /** the student's voice: exclamation marks are allowed only when they use them */
  style?: Pick<StyleCard, 'exclamationsPerMessage'>;
  /** a LinkedIn connection request note (≤ 200 characters) rather than a message */
  connectionNote?: boolean;
  facts?: PersonFact[];
  /** the student's own first name, which a forwardable blurb is written about */
  userFirstName?: string;
}

export const READING_GRADE_MAX = 7;
export const LINKEDIN_MESSAGE_MAX = 400;
export const CONNECTION_NOTE_MAX = 200;
export const SUBJECT_MAX_CHARS = 45;

/** Kinds that open a conversation: they need a hook with a source (§7.1). */
export const FIRST_TOUCH_KINDS: ReadonlySet<MessageKind> = new Set([
  'first_touch',
  'warm_first_touch',
  'outreach',
]);
/** Kinds that carry exactly one ask; a re-engage note carries none unless the student asked for one. */
const ONE_ASK_KINDS: ReadonlySet<MessageKind> = new Set([
  'first_touch',
  'warm_first_touch',
  'outreach',
  'intro_request',
  'bump',
  'referral_ask',
  'schedule',
]);

/** Flattery and filler §7.5 adds to the v1 list. */
export const COMPOSE_BANNED_PHRASES = [
  'amazing',
  'incredible',
  'inspiring',
  'i hope this finds you well',
  'hope this finds you well',
  'quick question',
];

/** Body word range by kind and goal (§7.1): first touches 50–110 (sales 40–90), bumps 15–50. */
export function wordRange(kind: MessageKind, goal: GoalKind): [number, number] {
  if (FIRST_TOUCH_KINDS.has(kind)) return goal === 'sales' ? [40, 90] : [50, 110];
  if (kind === 'bump') return [15, 50];
  return [MIN_WORDS[kind], MAX_WORDS[kind]];
}

/**
 * Syllables in an English word, by vowel groups with the usual corrections: a silent final e ("make"), -es/-ed that
 * add no syllable ("likes", "asked"), a final -le that keeps its e ("table"), and y as a vowel inside a word.
 * Good to about one syllable on common words, which is what a grade estimate needs.
 */
export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]!).replace(/^y/, '');
  return Math.max(1, w.match(/[aeiouy]+/g)?.length ?? 0);
}

/** The body without its greeting line and sign-off, as words and sentences. */
function prose(body: string): { words: string[]; sentences: string[] } {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l, i, all) =>
        !(i === 0 && /^(hi|hey|hello|dear)\b[^.!?]{0,40}[,!]?$/i.test(l)) &&
        !(
          i >= all.length - 2 &&
          /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|[A-Z][a-z]+)[,!.]?$/.test(
            l,
          )
        ),
    );
  const text = lines.join(' ');
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z]/.test(s));
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  return { words, sentences };
}

/** Flesch–Kincaid grade level: 0.39 · words/sentence + 11.8 · syllables/word − 15.59. */
export function fleschKincaidGrade(body: string): number {
  const { words, sentences } = prose(body);
  if (!words.length || !sentences.length) return 0;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
}

const ASK_PHRASE =
  /\b(would you|could you|could we|can we|can you|are you open|open to|worth a (quick )?look|happy to (chat|talk|hop)|let me know if|would it be|do you have|are you up for|might you|would love (it )?if you)\b/i;

/** Sentences that ask the reader for something: questions, and requests phrased as statements. */
export function asksIn(body: string): string[] {
  return prose(body).sentences.filter((s) => s.endsWith('?') || ASK_PHRASE.test(s));
}

function wordHit(lower: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lower);
}

/**
 * Validate a composed message (§7.1, §7.5). Calls the v1 `validateDraft` for what it already covers (placeholders,
 * unknown links and addresses, the recipient's name, the v1 banned phrases, prompt injection) and adds the v2 rules.
 * Word counts exclude the greeting and sign-off.
 */
export function validateComposed(
  msg: Pick<ComposedMessage, 'kind' | 'channel' | 'subject' | 'body' | 'hooks'> &
    Partial<Pick<ComposedMessage, 'ask'>>,
  ctx: ComposeContext,
): { ok: boolean; issues: ComposeIssue[]; words: number; grade: number } {
  const issues: ComposeIssue[] = [];
  const block = (code: ComposeIssueCode, detail: string) => issues.push({ code, detail, blocking: true });
  const body = msg.body;
  const lower = body.toLowerCase();
  const words = wordsIn(body);
  const grade = Math.round(fleschKincaidGrade(body) * 10) / 10;

  // v1 checks that still apply; length, hooks and the ask's length are judged by the v2 rules below
  const v1 = validateDraft(
    {
      body,
      subject: msg.subject ?? undefined,
      claims: msg.hooks.map((h) => ({ text: h.text, kind: 'about_person' as const })),
    },
    {
      kind: msg.kind,
      facts: ctx.facts ?? [],
      allowedUrls: ctx.allowedUrls ?? [],
      recipientEmail: ctx.recipientEmail,
      recipientFirstName: msg.kind === 'forwardable_blurb' ? '' : ctx.recipientFirstName,
      recipientFullName: ctx.recipientFullName,
      channel: msg.channel,
    },
  );
  const v1Skip = new Set([
    'too_long',
    'too_short',
    'no_specific_line',
    'ask_without_number',
    'exclamations',
    'em_dash',
  ]);
  for (const i of v1) if (!v1Skip.has(i.code)) issues.push(i);

  if (msg.channel === 'linkedin') {
    const max = ctx.connectionNote ? CONNECTION_NOTE_MAX : LINKEDIN_MESSAGE_MAX;
    if (body.length > max)
      block(
        ctx.connectionNote ? 'connection_note_too_long' : 'linkedin_too_long',
        `${body.length} characters, at most ${max}`,
      );
    if (FIRST_TOUCH_KINDS.has(msg.kind) && words < 12) block('words_out_of_range', `${words} words`);
  } else {
    const [min, max] = wordRange(msg.kind, ctx.goal);
    if (words < min || words > max) block('words_out_of_range', `${words} words, want ${min}–${max}`);
  }
  if (grade > READING_GRADE_MAX) block('reading_grade', `grade ${grade}, want ${READING_GRADE_MAX} or lower`);

  const asks = asksIn(body);
  const wantsNone = msg.kind === 'reengage' && (msg.ask?.kind ?? 'none') === 'none';
  if (wantsNone) {
    if (asks.length) block('several_asks', `a re-engage note asks nothing: ${asks[0]}`);
  } else if (ONE_ASK_KINDS.has(msg.kind) || msg.kind === 'reengage') {
    if (!asks.length) block('no_ask', 'no ask');
    else if (asks.length > 1) block('several_asks', `${asks.length} asks: ${asks.join(' | ')}`);
  } else if (asks.length > 1) block('several_asks', `${asks.length} asks: ${asks.join(' | ')}`);

  if (msg.channel === 'gmail') {
    const subject = (msg.subject ?? '').trim();
    if (!subject) {
      if (FIRST_TOUCH_KINDS.has(msg.kind) || msg.kind === 'intro_request')
        block('subject_missing', 'no subject');
    } else {
      const n = subject.split(/\s+/).length;
      if (n < 2 || n > 6 || subject.length > SUBJECT_MAX_CHARS)
        block(
          'subject_length',
          `${n} words, ${subject.length} characters (2–6 words, ≤ ${SUBJECT_MAX_CHARS})`,
        );
      // lower-case except names: a capitalised word after the first must be a name from the inputs
      const caps = subject
        .split(/\s+/)
        .slice(1)
        .filter(
          (w) => /^[A-Z]/.test(w) && !new RegExp(`\\b${w.replace(/[^A-Za-z0-9]/g, '')}\\b`).test(ctx.inputs),
        );
      if (caps.length) block('subject_case', `capitalised: ${caps.join(', ')}`);
      if (
        BANNED_SUBJECT_PATTERNS.some((re) => re.test(subject)) ||
        COMPOSE_BANNED_PHRASES.some((p) => wordHit(subject.toLowerCase(), p)) ||
        /[!?]{2,}|\b(urgent|re:|fwd:)/i.test(subject)
      )
        block('subject_banned', subject);
    }
  }

  if (FIRST_TOUCH_KINDS.has(msg.kind) && !msg.hooks.some((h) => h.text.trim() && h.sourceId.trim()))
    block('hook_missing', 'a first touch needs at least one hook with its source');

  for (const u of unsupportedDetails(`${msg.subject ?? ''}\n${body}`, ctx.inputs))
    block('unknown_detail', `${u} is not in the inputs`);

  for (const p of COMPOSE_BANNED_PHRASES) if (wordHit(lower, p)) block('banned_phrase', p);
  if (/[—–]/.test(body)) block('em_dash', 'no dashes; use a comma or a period');
  const bangs = (body.match(/!/g) ?? []).length;
  const allowed = (ctx.style?.exclamationsPerMessage ?? 0) > 0 ? 1 : 0;
  if (bangs > allowed)
    block('exclamation', `${bangs} exclamation marks${allowed ? ', at most one in your voice' : ''}`);

  // a forwardable blurb is about the student, in the third person, so the introducer can pass it on unchanged
  if (msg.kind === 'forwardable_blurb') {
    if (/\b(I|I'm|I've|I'd|my|me)\b/.test(body))
      block('third_person', 'write it about the student, not as them');
    if (ctx.userFirstName && !body.includes(ctx.userFirstName))
      block('third_person', `name ${ctx.userFirstName}`);
  }

  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const k = `${i.code}|${i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ok: !deduped.some((i) => i.blocking), issues: deduped, words, grade };
}
