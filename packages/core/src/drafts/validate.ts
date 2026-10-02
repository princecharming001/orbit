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
    | 'referral_without_conversation';
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
}

export function validateDraft(
  d: Pick<DraftOutput, 'body' | 'claims'> & Partial<DraftOutput>,
  opts: ValidateOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = d.body;
  const lower = body.toLowerCase();
  const wc = wordsIn(body);
  if (wc > MAX_WORDS[opts.kind] + 25)
    issues.push({ code: 'too_long', detail: `${wc} words, aim for ${MAX_WORDS[opts.kind]}`, blocking: true });
  else if (wc > MAX_WORDS[opts.kind])
    issues.push({
      code: 'too_long',
      detail: `${wc} words, aim for ${MAX_WORDS[opts.kind]}`,
      blocking: false,
    });
  if (wc < MIN_WORDS[opts.kind]) issues.push({ code: 'too_short', detail: `${wc} words`, blocking: false });
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
    if (n === 'update')
      issues.push({
        code: 'needs_update',
        detail: 'Add one real update since you last spoke.',
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
  if (opts.kind === 'referral_ask' && opts.hadConversation === false)
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
