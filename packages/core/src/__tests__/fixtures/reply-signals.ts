import type { MessageExtraction, ReplySignal } from '../../types';
import { MESSAGES } from './email-corpus';

/**
 * Labelled corpus for reply-signal classification (email/triage.ts `heuristicSignal` and the times it reads with
 * email/when.ts). Every message is read as ingest reads it (quoted history stripped, signature split off) in the
 * student's zone, America/Los_Angeles, on Monday 5 October 2026 at 9:00 AM Pacific (CORPUS_NOW in email-corpus.ts).
 *
 * Labels are what the student's next step depends on, so a few signals are split by their flags:
 * - `email_only`: a `question` with `prefersEmail` (no to a call, yes to questions by email)
 * - `decline_hard` / `decline_soft`: `reply_decline` with `decline` "hard" (a no) or "soft" (not now, wrong person,
 *   a bare "best of luck" on an ask still waiting for an answer)
 * - `intro` / `intro_handoff`: `intro_offer` without or with `handoff` (the next step is with someone else)
 *
 * Expected times are the sender's wall clock: "Thu 10/8 14:00" in the stated zone when there is one (`zone`),
 * otherwise in the student's zone. An empty list means no time may be read.
 */
export type SignalLabel =
  | 'positive'
  | 'question'
  | 'email_only'
  | 'proposal'
  | 'confirmation'
  | 'reschedule'
  | 'decline_hard'
  | 'decline_soft'
  | 'ooo'
  | 'intro'
  | 'intro_handoff'
  | 'referral'
  | 'thank_you'
  | 'neutral'
  | 'other';

export interface SignalExample {
  id: string;
  label: SignalLabel;
  /** inbound unless stated */
  direction?: 'inbound' | 'outbound';
  /** the chat is still waiting on the person's answer to the student's ask (outreach sent, no reply yet) */
  awaiting?: boolean;
  body: string;
  times?: string[];
  zone?: string;
  followUpAfter?: string;
}

/** The label a classification amounts to. */
export function labelOf(signal: ReplySignal, x: MessageExtraction): SignalLabel {
  switch (signal) {
    case 'reply_positive':
      return 'positive';
    case 'question':
      return x.prefersEmail ? 'email_only' : 'question';
    case 'scheduling_proposal':
      return 'proposal';
    case 'scheduling_confirmation':
      return 'confirmation';
    case 'reschedule':
      return 'reschedule';
    case 'reply_decline':
      return x.decline === 'soft' ? 'decline_soft' : 'decline_hard';
    case 'out_of_office':
      return 'ooo';
    case 'intro_offer':
      return x.handoff ? 'intro_handoff' : 'intro';
    case 'referral_offer':
      return 'referral';
    case 'thank_you':
      return 'thank_you';
    case 'reply_neutral':
      return 'neutral';
    case 'other':
      return 'other';
  }
}

/** Older corpus messages whose label needs a flag the older corpus does not record. */
const SOFT_DECLINES = new Set([
  'decline-soft-slammed',
  'decline-soft-bandwidth',
  'decline-soft-left',
  'decline-slammed-january',
  'decline-bandwidth-luck',
  'decline-left-company',
]);
const INTROS_WITHOUT_HANDOFF = new Set(['intro-offer-anyone']);

/** The older email corpus (email-corpus.ts), reused as tuning examples (a body it lists twice counts once). */
export function fromEmailCorpus(): SignalExample[] {
  const unique = MESSAGES.filter((m, i) => MESSAGES.findIndex((x) => x.body === m.body) === i);
  return unique.map((m) => {
    const s = m.expect.signal;
    const label: SignalLabel =
      s === 'reply_decline'
        ? SOFT_DECLINES.has(m.id)
          ? 'decline_soft'
          : 'decline_hard'
        : s === 'intro_offer'
          ? INTROS_WITHOUT_HANDOFF.has(m.id)
            ? 'intro'
            : 'intro_handoff'
          : labelOf(s, {
              proposedTimes: [],
              asksOfUser: [],
              offers: [],
              factsAboutSender: [],
              sentiment: 'neutral',
              prefersEmail: m.expect.prefersEmail,
            });
    return {
      id: `email-corpus/${m.id}`,
      label,
      direction: m.direction,
      body: m.body,
      ...(m.expect.times ? { times: m.expect.times } : {}),
      ...(m.expect.zone ? { zone: m.expect.zone } : {}),
      ...(m.expect.followUpAfter ? { followUpAfter: m.expect.followUpAfter } : {}),
    };
  });
}
