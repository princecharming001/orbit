import { wordCount } from '../text/email';
import type { MessageKind, PersonFact, StyleCard } from '../types';
import type { DraftOutput } from './templates';
import { BANNED_PHRASES, MAX_WORDS } from './templates';

export interface ValidationIssue {
  code:
    | 'too_long'
    | 'banned_phrase'
    | 'unknown_url'
    | 'unknown_email'
    | 'ungrounded_claim'
    | 'missing_name'
    | 'injection';
  detail: string;
}

export function validateDraft(
  d: DraftOutput,
  opts: {
    kind: MessageKind;
    facts: PersonFact[];
    allowedUrls: string[];
    recipientEmail?: string;
    recipientFirstName: string;
    styleCard?: StyleCard;
  },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wc = wordCount(d.body);
  if (wc > MAX_WORDS[opts.kind] + 25)
    issues.push({ code: 'too_long', detail: `${wc} words, max ${MAX_WORDS[opts.kind]}` });
  const lower = d.body.toLowerCase();
  for (const p of BANNED_PHRASES) if (lower.includes(p)) issues.push({ code: 'banned_phrase', detail: p });
  const urls = d.body.match(/https?:\/\/[^\s)>"]+/g) ?? [];
  for (const u of urls)
    if (!opts.allowedUrls.some((a) => u.startsWith(a))) issues.push({ code: 'unknown_url', detail: u });
  const emails = d.body.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  for (const e of emails)
    if (e.toLowerCase() !== opts.recipientEmail?.toLowerCase())
      issues.push({ code: 'unknown_email', detail: e });
  const factIds = new Set(opts.facts.map((f) => f.id));
  for (const c of d.claims)
    if (c.kind === 'about_person' && c.factId && !factIds.has(c.factId))
      issues.push({ code: 'ungrounded_claim', detail: c.text });
  if (opts.recipientFirstName && !d.body.includes(opts.recipientFirstName))
    issues.push({ code: 'missing_name', detail: opts.recipientFirstName });
  if (/\b(ignore (all )?(previous|prior) instructions|system prompt)\b/i.test(d.body))
    issues.push({ code: 'injection', detail: 'instruction-like text' });
  return issues;
}
