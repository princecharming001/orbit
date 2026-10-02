import type { ChatStage } from '../types';

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
  outreach_sent: 'Outreach sent',
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
  | { type: 'timer_no_response'; bumps: number; maxBumps: number; daysSilent: number }
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
    case 'timer_no_response':
      return from === 'outreach_sent' && trig.bumps >= trig.maxBumps && trig.daysSilent >= 14
        ? d('no_response', 1, 'timer:no_response')
        : undefined;
    case 'warmup_ready':
      return undefined; // warm-up readiness produces a suggestion, not a transition
  }
}

export const PROPOSE_THRESHOLD = 0.8;
