import type { ChatStage, CoffeeChat, MessageKind } from '../types';

export const ACTIVE_STAGES: ChatStage[] = [
  'identified',
  'warming',
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
];
export const CLOSED_STAGES: ChatStage[] = ['declined', 'no_response', 'archived'];
export const STAGE_ORDER: ChatStage[] = [...ACTIVE_STAGES, ...CLOSED_STAGES];

export const STAGE_LABELS: Record<ChatStage, string> = {
  identified: 'Identified',
  warming: 'Warming up',
  outreach_sent: 'First message sent',
  replied: 'Replied',
  scheduling: 'Scheduling',
  scheduled: 'Scheduled',
  completed: 'Completed',
  followed_up: 'Followed up',
  nurturing: 'Nurturing',
  declined: 'Declined',
  no_response: 'No response',
  archived: 'Archived',
};

const ALLOWED: Record<ChatStage, ChatStage[]> = {
  identified: ['warming', 'outreach_sent', 'replied', 'scheduled', 'archived', 'declined'],
  warming: ['outreach_sent', 'replied', 'identified', 'archived', 'declined'],
  outreach_sent: ['replied', 'scheduling', 'scheduled', 'declined', 'no_response', 'archived', 'completed'],
  replied: ['scheduling', 'scheduled', 'declined', 'completed', 'archived', 'nurturing'],
  scheduling: ['scheduled', 'declined', 'completed', 'archived', 'replied'],
  scheduled: ['completed', 'scheduling', 'declined', 'archived'],
  completed: ['followed_up', 'nurturing', 'archived', 'scheduled'],
  followed_up: ['nurturing', 'archived', 'scheduled', 'scheduling'],
  nurturing: ['outreach_sent', 'scheduling', 'scheduled', 'declined', 'archived'],
  declined: ['identified', 'archived', 'outreach_sent'],
  no_response: ['identified', 'outreach_sent', 'replied', 'archived'],
  archived: ['identified'],
};

export function canTransition(from: ChatStage, to: ChatStage, actor: 'system' | 'user' = 'system'): boolean {
  if (from === to) return false;
  if (actor === 'user') return true; // the user may move anything anywhere
  return ALLOWED[from].includes(to);
}

export type StageTrigger =
  | { type: 'outbound_sent'; kind: 'outreach' | 'bump' | 'schedule' | 'thank_you' | 'nurture' | 'other' }
  | { type: 'inbound_signal'; signal: string; confidence: number }
  | { type: 'event_scheduled'; confidence: number }
  | { type: 'event_ended'; confidence: number }
  | { type: 'event_cancelled' }
  | { type: 'note_ingested'; confidence: number }
  | { type: 'timer_followed_up_14d' }
  /** a chat that ended two weeks ago with no thank-you on record: it is a nurture relationship now */
  | { type: 'timer_completed_14d' }
  | {
      type: 'timer_no_response';
      bumps: number;
      maxBumps: number;
      daysSilent: number;
      /** business days of silence (holidays and the winter freeze excluded); preferred over daysSilent when set */
      businessDaysSilent?: number;
    }
  | { type: 'warmup_ready' };

export interface StageDecision {
  to: ChatStage;
  confidence: number;
  reason: string;
}

export function decideTransition(from: ChatStage, trig: StageTrigger): StageDecision | undefined {
  const d = (to: ChatStage, confidence: number, reason: string): StageDecision | undefined =>
    canTransition(from, to) ? { to, confidence, reason } : undefined;
  switch (trig.type) {
    case 'outbound_sent':
      if (
        trig.kind === 'outreach' &&
        (from === 'identified' || from === 'warming' || from === 'nurturing' || from === 'no_response')
      )
        return d('outreach_sent', 1, 'outbound:outreach');
      if (trig.kind === 'schedule' && ['outreach_sent', 'replied'].includes(from))
        return d('scheduling', 1, 'outbound:schedule');
      if (trig.kind === 'thank_you' && from === 'completed') return d('followed_up', 1, 'outbound:thank_you');
      return undefined;
    case 'inbound_signal': {
      const s = trig.signal;
      if (s === 'reply_decline')
        return [
          'outreach_sent',
          'replied',
          'scheduling',
          'scheduled',
          'nurturing',
          'warming',
          'identified',
        ].includes(from)
          ? {
              to: 'declined',
              confidence: Math.min(trig.confidence, 0.79),
              reason: 'inbound_signal:reply_decline',
            }
          : undefined;
      // they wrote first with a time ("happy to chat, would Thursday at 2pm work?", often in reply to an email
      // introduction): that is their reply, and the student confirms the time from there
      if (
        (s === 'scheduling_proposal' || s === 'scheduling_confirmation') &&
        ['identified', 'warming', 'no_response'].includes(from)
      )
        return d('replied', trig.confidence, `inbound_signal:${s}`);
      if (s === 'scheduling_proposal')
        return d('scheduling', trig.confidence, 'inbound_signal:scheduling_proposal');
      if (s === 'scheduling_confirmation')
        return d('scheduling', trig.confidence, 'inbound_signal:scheduling_confirmation');
      if (s === 'reschedule' && from === 'scheduled')
        return d('scheduling', trig.confidence, 'inbound_signal:reschedule');
      if (
        [
          'reply_positive',
          'reply_neutral',
          'question',
          'referral_offer',
          'intro_offer',
          'thank_you',
        ].includes(s) &&
        ['identified', 'warming', 'outreach_sent', 'no_response'].includes(from)
      )
        return d('replied', trig.confidence, `inbound_signal:${s}`);
      return undefined;
    }
    case 'event_scheduled':
      return [
        'identified',
        'warming',
        'outreach_sent',
        'replied',
        'scheduling',
        'nurturing',
        'followed_up',
      ].includes(from)
        ? d('scheduled', trig.confidence, 'calendar:event_scheduled')
        : undefined;
    case 'event_ended':
      return from === 'scheduled' ? d('completed', trig.confidence, 'calendar:event_ended') : undefined;
    case 'event_cancelled':
      return from === 'scheduled' ? d('scheduling', 1, 'calendar:event_cancelled') : undefined;
    case 'note_ingested':
      return ['outreach_sent', 'replied', 'scheduling', 'scheduled'].includes(from)
        ? d('completed', trig.confidence, 'note:ingested')
        : undefined;
    case 'timer_followed_up_14d':
      return from === 'followed_up' ? d('nurturing', 1, 'timer:followed_up_14d') : undefined;
    case 'timer_completed_14d':
      return from === 'completed' ? d('nurturing', 1, 'timer:completed_14d') : undefined;
    case 'timer_no_response': {
      // bumps exhausted and ten more business days of silence, or three weeks (15 business days) of silence whether
      // or not a bump went out
      const exhausted =
        trig.bumps >= trig.maxBumps &&
        (trig.businessDaysSilent !== undefined
          ? trig.businessDaysSilent >= NO_RESPONSE_AFTER_BUMPS_BUSINESS_DAYS
          : trig.daysSilent >= NO_RESPONSE_AFTER_BUMPS_DAYS);
      // in business days when known, so a holiday stretch or the winter freeze cannot close a thread before the
      // next bump was even due
      const stale =
        trig.businessDaysSilent !== undefined
          ? trig.businessDaysSilent >= NO_RESPONSE_SILENT_BUSINESS_DAYS
          : trig.daysSilent >= NO_RESPONSE_SILENT_DAYS;
      return from === 'outreach_sent' && (exhausted || stale)
        ? d('no_response', 1, exhausted ? 'timer:no_response' : 'timer:no_response_silent')
        : undefined;
    }
    case 'warmup_ready':
      return undefined; // warm-up readiness produces a suggestion, not a transition
  }
}

export const PROPOSE_THRESHOLD = 0.8;
/** outreach_sent -> no_response: this many days of silence after the last allowed bump ... */
export const NO_RESPONSE_AFTER_BUMPS_DAYS = 14;
/** ... measured in business days when the caller knows them (the sector's bump cap, then ten business days) */
export const NO_RESPONSE_AFTER_BUMPS_BUSINESS_DAYS = 10;
/** ... or this many days of silence with no bump sent at all (a dismissed or never-sent bump must not strand the chat) */
export const NO_RESPONSE_SILENT_DAYS = 21;
/** ... the same three weeks in business days (holidays and the winter freeze do not count); always past the last bump */
export const NO_RESPONSE_SILENT_BUSINESS_DAYS = 15;

export interface Reengage {
  /** when it is fair to write again */
  at: string;
  /** the qualifier as they wrote it ("this quarter") */
  said: string;
  /** what they said, as seen from after the window, for "you mentioned ..." ("last quarter wasn't a good time") */
  past: string;
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * A decline with a time limit ("not able to take calls this quarter", "swamped until January") is a "not now", not a
 * "no": the window after which a polite second try is fair. Undefined for a decline without one.
 */
export function declineReengage(body: string | undefined, saidAt: Date): Reengage | undefined {
  if (!body) return undefined;
  const t = body.toLowerCase();
  const y = saidAt.getFullYear();
  const m = saidAt.getMonth();
  const mk = (d: Date, said: string, past: string): Reengage => ({ at: d.toISOString(), said, past });
  const until = t.match(
    /\b(?:until|till|after)\s+(?:early\s+|mid[- ])?(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  );
  if (until) {
    const mi = MONTH_NAMES.indexOf(until[1]!);
    const month = until[1]!.charAt(0).toUpperCase() + until[1]!.slice(1);
    const after = /^after/.test(until[0]);
    const at = new Date(mi > m ? y : y + 1, after ? mi + 1 : mi, 1, 9);
    return mk(
      at,
      `${after ? 'until after' : 'until'} ${month}`,
      `you were tied up until ${after ? 'after ' : ''}${month}`,
    );
  }
  if (/\bthis (quarter|q[1-4])\b/.test(t))
    return mk(
      new Date(y, Math.floor(m / 3) * 3 + 3, 1, 9),
      'this quarter',
      "last quarter wasn't a good time",
    );
  if (/\bthis (semester|term)\b/.test(t)) {
    const unit = /\bthis term\b/.test(t) ? 'term' : 'semester';
    // spring runs January to May, fall August to December
    const at = m <= 4 ? new Date(y, 7, 25, 9) : new Date(y + 1, 0, 15, 9);
    return mk(at, `this ${unit}`, `last ${unit} wasn't a good time`);
  }
  if (/\bthis summer\b/.test(t) && m <= 7)
    return mk(new Date(y, 8, 8, 9), 'this summer', "the summer wasn't a good time");
  if (/\bthis month\b/.test(t))
    return mk(new Date(y, m + 1, 1, 9), 'this month', "last month wasn't a good time");
  return undefined;
}

/**
 * When one polite second try after a time-limited decline becomes fair: once the window they named has passed, and
 * never sooner than three weeks after they said it.
 */
export function reengageDueAt(re: Reengage, saidAt: Date): Date {
  return new Date(Math.max(new Date(re.at).getTime(), saidAt.getTime() + 21 * 86_400_000));
}

/**
 * What "Write to {first}" should draft for a chat right now, or why nothing should go out yet. A check-in minutes
 * after a thank-you (or any note within two weeks of the student's last one, with no reply since) is not offered:
 * the stage alone would say "nurture", the calendar says "too soon".
 */
export function composeKindFor(
  chat: Pick<CoffeeChat, 'stage' | 'lastOutboundAt' | 'lastInboundAt'> | undefined,
  now: Date,
): { kind: MessageKind } | { wait: { since: string } } {
  if (!chat) return { kind: 'outreach' };
  const lastOut = chat.lastOutboundAt ? new Date(chat.lastOutboundAt).getTime() : undefined;
  const repliedSince = !!chat.lastInboundAt && (!lastOut || new Date(chat.lastInboundAt).getTime() > lastOut);
  switch (chat.stage) {
    case 'completed':
      return { kind: 'thank_you' };
    case 'outreach_sent':
      return { kind: 'bump' };
    case 'replied':
    case 'scheduling':
      return { kind: 'schedule' };
    case 'scheduled':
      return { kind: repliedSince ? 'reply' : 'outreach' };
    case 'followed_up':
    case 'nurturing':
      if (repliedSince) return { kind: 'reply' };
      if (lastOut && now.getTime() - lastOut < 14 * 86_400_000)
        return { wait: { since: chat.lastOutboundAt! } };
      return { kind: 'nurture' };
    default:
      return { kind: 'outreach' };
  }
}
