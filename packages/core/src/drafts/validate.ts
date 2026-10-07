import type { MessageKind, PersonFact } from '../types';
import type { DraftOutput } from './templates';
import {
  BANNED_PHRASES,
  BANNED_SUBJECT_PATTERNS,
  LINKEDIN_NOTE_MAX,
  MAX_WORDS,
  MIN_WORDS,
  wordsIn,
} from './templates';

export interface ValidationIssue {
  code:
    | 'too_long'
    | 'too_short'
    | 'banned_phrase'
    | 'em_dash'
    | 'unknown_url'
    | 'unknown_email'
    | 'ungrounded_claim'
    | 'missing_name'
    | 'injection'
    | 'placeholder'
    | 'needs_connection'
    | 'needs_update'
    | 'no_specific_line'
    | 'ask_without_number'
    | 'duplicate_opening'
    | 'banned_subject'
    | 'linkedin_note_too_long'
    | 'exclamations'
    | 'i_heavy'
    | 'long_sentences'
    | 'referral_without_conversation'
    | 'unsupported_detail'
    | 'ignores_ask'
    | 'needs_input';
  detail: string;
  blocking: boolean;
}

export interface ValidateOptions {
  kind: MessageKind;
  facts: PersonFact[];
  allowedUrls: string[];
  recipientEmail?: string;
  recipientFirstName: string;
  recipientFullName?: string;
  recentOpenings?: string[];
  hadConversation?: boolean;
  channel?: 'gmail' | 'linkedin' | 'clipboard';
  /**
   * Everything the draft may mention (see `contextText`). When given, any name, company, post, event, mutual
   * connection or number in the body that is not in it is flagged, whether or not the draft cites claims.
   */
  context?: string;
  /** what the other person asked the student in their last message; a reply must not ignore them */
  asks?: string[];
}

const NEED_DETAIL: Record<string, string> = {
  news: 'Say what you are congratulating them on.',
  target: 'Name the person you would like to be introduced to.',
  answer: 'Answer their question in your own words.',
  role: 'Name the role and company you are applying to.',
  takeaway: 'Add one thing they said that stuck with you.',
};

/** Capitalised words that are fine anywhere without appearing in the context. */
const COMMON_CAPS = new Set(
  `i i'm i'd i'll i've hi hey hello dear thanks thank best kind regards cheers warmly sincerely ps re fwd
  monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun
  january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
  et pt ct mt est edt pst pdt cst cdt mst mdt utc gmt am pm zoom google meet linkedin email ok
  would could can will should do does did is are was were have has had may might must
  what which why how when where who whatever whenever however
  quick small just also and but so or if as at in on for to of from by with about after before since though
  the a an this that these those there here it its my your our their his her we you they he she
  no yes not completely totally absolutely happy glad sorry hope hoping looking last one two few next
  any anything anyone someone something all some most many much more still even only really
  saw read found noticed met came floating following followed surfacing congratulations congrats well
  speaking also especially again either neither both each every other another
  resume cv`.split(/\s+/),
);
const PHRASE_CHECKS: { re: RegExp; anchor: RegExp; what: string }[] = [
  {
    re: /\b(mutual (connection|friend|contact)s?|we('ve| have)? (both )?(know|known)|our (mutual|shared) (friend|contact|connection)|(friend|colleague) of yours)\b/i,
    anchor: /\b(referr|mutual|introduc|suggested I write)/i,
    what: 'a mutual connection',
  },
  {
    re: /\byour (recent |latest |last )?(post|article|blog|podcast|piece|newsletter|video|essay|op-ed|interview)\b/i,
    anchor: /\b(post|article|blog|podcast|piece|newsletter|video|essay|interview|warmUpNote)\b/i,
    what: 'a post or article',
  },
  {
    re: /\b(we met|met you|when we met|you spoke at|your talk|your panel|in the audience)\b/i,
    anchor: /\b(met|panel|spoke|talk|event|session|conference|workshop|fireside|completedAt|meetingAt)\b/i,
    what: 'a meeting or event',
  },
  {
    re: /\b(?:[Mm]y|[Aa]) (?:good |close |old )?(?:friend|colleague|classmate|roommate|cousin|professor|manager|mentor),?\s+[A-Z]/,
    anchor: /\b(referr|introduc|suggested I write|friend|colleague|classmate|professor|mentor)/i,
    what: 'a mutual connection',
  },
  {
    re: /\b(referred (me )?by|pointed me to you|told me to (write|contact|email)|suggested I (write|contact|email))\b/i,
    anchor: /\b(referr|introduc|suggested I write)/i,
    what: 'a referral',
  },
  { re: /\bGPA\b/i, anchor: /\bGPA\b/i, what: 'a GPA' },
  {
    re: /\b(top of my class|valedictorian|salutatorian|dean's list|summa cum laude|magna cum laude|perfect score|straight A'?s)\b/i,
    anchor:
      /\b(top of (my|the) class|valedictorian|salutatorian|dean's list|cum laude|perfect score|straight A)/i,
    what: 'an academic honor',
  },
];

/** Names, companies, posts, mutual connections and figures in `body` that are not in `context`. */
export function unsupportedDetails(body: string, context: string): string[] {
  const ctx = context.toLowerCase();
  const has = (w: string) => {
    const l = w.toLowerCase();
    return new RegExp(`(^|[^a-z0-9])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(ctx);
  };
  const out: string[] = [];
  const re = /[A-Z][A-Za-z&'.-]*(?:\s+(?:&\s+)?[A-Z][A-Za-z&'.-]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const before = body.slice(0, m.index);
    if (/[A-Za-z0-9'@./-]$/.test(before)) continue; // inside a word, URL or email
    const sentenceStart = /(^|[.!?:;"]\s+|\n\s*|\(\s*)$/.test(before);
    const phrase = m[0].replace(/'s$/, '').replace(/[.'-]+$/, '');
    if (!phrase || has(phrase)) continue;
    const words = phrase.split(/\s+/);
    const unknown = words.filter((w, i) => {
      const bare = w.replace(/'s$/, '').replace(/[.'-]+$/, '');
      if (!bare || COMMON_CAPS.has(bare.toLowerCase()) || has(bare)) return false;
      // a single capitalised word opening a sentence is usually just English
      if (i === 0 && sentenceStart && words.length === 1 && /^[A-Z][a-z]+$/.test(bare)) return false;
      return true;
    });
    if (unknown.length) out.push(phrase);
  }
  for (const p of PHRASE_CHECKS) {
    const hit = body.match(p.re);
    if (hit && !p.anchor.test(context)) out.push(`${p.what} ("${hit[0]}")`);
  }
  // figures: percentages, decimals, money and large numbers must come from the data
  for (const f of body.match(/\$?\d[\d,]*(\.\d+)?%?/g) ?? []) {
    const plain = f.replace(/[$,%]/g, '');
    const interesting = /[%$.]/.test(f) || Number(plain) >= 100;
    if (!interesting || /^(19|20)\d\d$/.test(plain)) continue;
    if (!ctx.includes(plain) && !ctx.includes(f.toLowerCase())) out.push(f);
  }
  return [...new Set(out)];
}

export function validateDraft(
  d: Pick<DraftOutput, 'body' | 'claims'> & Partial<DraftOutput>,
  opts: ValidateOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = d.body;
  const lower = body.toLowerCase();
  const wc = wordsIn(body);
  // a scheduling reply that also answers their asks is held to the reply limit
  const limitKind = opts.kind === 'schedule' && opts.asks?.length ? 'reply' : opts.kind;
  const max = MAX_WORDS[limitKind];
  if (wc > max + 25) issues.push({ code: 'too_long', detail: `${wc} words, aim for ${max}`, blocking: true });
  else if (wc > max)
    issues.push({ code: 'too_long', detail: `${wc} words, aim for ${max}`, blocking: false });
  if (wc < MIN_WORDS[limitKind]) issues.push({ code: 'too_short', detail: `${wc} words`, blocking: false });
  for (const p of BANNED_PHRASES)
    if (lower.includes(p)) issues.push({ code: 'banned_phrase', detail: p, blocking: true });
  if (/[—–]/.test(body))
    issues.push({
      code: 'em_dash',
      detail: 'dash reads as machine-written; use a comma or a period',
      blocking: true,
    });
  if (/\[[^\]]{3,}\]/.test(body))
    issues.push({ code: 'placeholder', detail: body.match(/\[[^\]]{3,}\]/)![0], blocking: true });
  for (const n of d.needsInput ?? []) {
    if (n === 'connection')
      issues.push({
        code: 'needs_connection',
        detail: `Add one line only true of ${opts.recipientFirstName}: how you found them, what you share, or what of theirs you read.`,
        blocking: true,
      });
    else if (n === 'update')
      issues.push({
        code: 'needs_update',
        detail: 'Add one real update since you last spoke.',
        blocking: true,
      });
    else if (n !== 'post')
      issues.push({
        code: 'needs_input',
        detail: NEED_DETAIL[n] ?? 'Fill in the bracketed line.',
        blocking: true,
      });
  }
  const urls = body.match(/https?:\/\/[^\s)>"]+/g) ?? [];
  for (const u of urls)
    if (!opts.allowedUrls.some((a) => a && u.startsWith(a)))
      issues.push({ code: 'unknown_url', detail: u, blocking: true });
  const emails = body.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  for (const e of emails)
    if (e.toLowerCase() !== opts.recipientEmail?.toLowerCase())
      issues.push({ code: 'unknown_email', detail: e, blocking: true });
  const factIds = new Set(opts.facts.map((f) => f.id));
  for (const c of d.claims)
    if (c.kind === 'about_person' && c.factId && !factIds.has(c.factId))
      issues.push({ code: 'ungrounded_claim', detail: c.text, blocking: true });
  if (
    opts.recipientFirstName &&
    !body.includes(opts.recipientFirstName) &&
    !(opts.recipientFullName && body.includes(opts.recipientFullName))
  )
    issues.push({ code: 'missing_name', detail: opts.recipientFirstName, blocking: true });
  if (/\b(ignore (all )?(previous|prior) instructions|system prompt)\b/i.test(body))
    issues.push({ code: 'injection', detail: 'instruction-like text', blocking: true });
  if (
    ['outreach', 'thank_you', 'nurture', 'congratulate'].includes(opts.kind) &&
    !d.claims.some(
      (c) => (c.kind === 'about_person' || c.kind === 'shared') && c.text !== 'connection missing',
    )
  )
    issues.push({
      code: 'no_specific_line',
      detail: 'nothing in this message is only true of the recipient',
      blocking: opts.kind === 'outreach',
    });
  if (
    ['outreach', 'bump', 'intro_request'].includes(opts.kind) &&
    !/\b(15|20|30|fifteen|twenty)[- ]?min/i.test(body) &&
    !/\b(15|20)\b/.test(body)
  )
    issues.push({
      code: 'ask_without_number',
      detail: 'the ask should name a length (15 or 20 minutes)',
      blocking: false,
    });
  if (
    d.opening &&
    opts.recentOpenings?.some((o) => o.trim().toLowerCase() === d.opening!.trim().toLowerCase())
  )
    issues.push({
      code: 'duplicate_opening',
      detail: 'same opening sentence as another message to this company in the last 30 days',
      blocking: true,
    });
  if (d.subject && BANNED_SUBJECT_PATTERNS.some((re) => re.test(d.subject!)))
    issues.push({ code: 'banned_subject', detail: d.subject, blocking: true });
  if (d.bodyShort && d.bodyShort.length > LINKEDIN_NOTE_MAX)
    issues.push({
      code: 'linkedin_note_too_long',
      detail: `${d.bodyShort.length} characters`,
      blocking: true,
    });
  if ((body.match(/!/g) ?? []).length > 1)
    issues.push({ code: 'exclamations', detail: 'more than one exclamation point', blocking: false });
  const sentences = body
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && !/^(hi|hey|hello|dear|best|thanks|thank you|cheers)\b/i.test(s));
  if (sentences.length >= 4) {
    const iStarts = sentences.filter((s) => /^I(\b|')/.test(s)).length;
    if (iStarts / sentences.length > 0.6)
      issues.push({
        code: 'i_heavy',
        detail: `${iStarts} of ${sentences.length} sentences start with "I"`,
        blocking: false,
      });
  }
  const long = sentences.filter((s) => s.split(/\s+/).length > 32);
  if (long.length)
    issues.push({
      code: 'long_sentences',
      detail: `${long.length} sentence${long.length > 1 ? 's' : ''} over 32 words`,
      blocking: false,
    });
  if (opts.context !== undefined)
    for (const u of unsupportedDetails(`${d.subject ?? ''}\n${body}\n${d.bodyShort ?? ''}`, opts.context))
      issues.push({
        code: 'unsupported_detail',
        detail: `${u} is not in anything Orbit knows about this person`,
        blocking: true,
      });
  // a reply that ignores what they asked: a resume request with no word about the resume, a question with no answer
  for (const a of opts.asks ?? []) {
    if (/\b(resume|cv)\b/i.test(a) && !/\b(resume|cv)\b/i.test(body))
      issues.push({ code: 'ignores_ask', detail: `they asked: ${a}`, blocking: true });
  }
  if (
    opts.kind === 'referral_ask' &&
    opts.hadConversation === false &&
    /\b(refer me|flag(ging)? my (name|application)|submit my name|put in a word)\b/i.test(body)
  )
    issues.push({
      code: 'referral_without_conversation',
      detail: 'ask for a referral only after a real conversation',
      blocking: true,
    });
  return issues;
}

export function isBlocked(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.blocking);
}
