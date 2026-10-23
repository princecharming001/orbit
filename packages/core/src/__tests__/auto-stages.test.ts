import { describe, expect, it } from 'vitest';
import { answersOutreach, decideTransition, PROPOSE_THRESHOLD } from '../pipeline/transitions';

/**
 * Plan 18: every move the pipeline makes on its own, in board order, with the trigger that makes it and the reason
 * it records. The apps/web tests cover the readers (Gmail, LinkedIn, the calendar, a send) that raise these triggers.
 */
describe('automatic stage moves (plan 18)', () => {
  it('To contact or Warming up → First message sent when the outreach goes out', () => {
    for (const from of ['identified', 'warming'] as const)
      expect(decideTransition(from, { type: 'outbound_sent', kind: 'outreach' })).toEqual({
        to: 'outreach_sent',
        confidence: 1,
        reason: 'outbound:outreach',
      });
    // a bump or a check-in is not a first message
    expect(decideTransition('outreach_sent', { type: 'outbound_sent', kind: 'bump' })).toBeUndefined();
  });

  it('First message sent → Replied on a confident reply, whatever it says', () => {
    for (const signal of ['reply_positive', 'reply_neutral', 'question', 'referral_offer', 'thank_you'])
      expect(decideTransition('outreach_sent', { type: 'inbound_signal', signal, confidence: 0.85 })).toEqual(
        {
          to: 'replied',
          confidence: 0.85,
          reason: `inbound_signal:${signal}`,
        },
      );
    // someone who wrote before the student did has not replied to anything
    expect(
      answersOutreach(
        {
          stage: 'outreach_sent',
          stageEnteredAt: '2026-10-15T14:00:00Z',
          firstOutreachAt: '2026-10-15T14:00:00Z',
        },
        '2026-10-14T09:00:00Z',
      ),
    ).toBe(false);
    expect(
      answersOutreach(
        {
          stage: 'outreach_sent',
          stageEnteredAt: '2026-10-15T14:00:00Z',
          firstOutreachAt: '2026-10-15T14:00:00Z',
        },
        '2026-10-16T09:00:00Z',
      ),
    ).toBe(true);
  });

  it('a reply Orbit is not sure of is proposed, never applied silently', () => {
    const d = decideTransition('outreach_sent', {
      type: 'inbound_signal',
      signal: 'reply_neutral',
      confidence: 0.7,
    });
    expect(d?.to).toBe('replied');
    expect(d!.confidence).toBeLessThan(PROPOSE_THRESHOLD);
    // a decline is always a question for the student
    const no = decideTransition('outreach_sent', {
      type: 'inbound_signal',
      signal: 'reply_decline',
      confidence: 1,
    });
    expect(no?.to).toBe('declined');
    expect(no!.confidence).toBeLessThan(PROPOSE_THRESHOLD);
  });

  it('Replied → Scheduling when a time is proposed, by either side', () => {
    expect(decideTransition('replied', { type: 'outbound_sent', kind: 'schedule' })?.reason).toBe(
      'outbound:schedule',
    );
    expect(
      decideTransition('replied', { type: 'inbound_signal', signal: 'scheduling_proposal', confidence: 0.9 })
        ?.to,
    ).toBe('scheduling');
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'scheduling_proposal',
        confidence: 0.9,
      })?.to,
    ).toBe('scheduling');
  });

  it('→ Scheduled when a calendar event with the person appears, from any open stage before it', () => {
    for (const from of ['identified', 'outreach_sent', 'replied', 'scheduling', 'nurturing'] as const)
      expect(decideTransition(from, { type: 'event_scheduled', confidence: 0.9 })).toEqual({
        to: 'scheduled',
        confidence: 0.9,
        reason: 'calendar:event_scheduled',
      });
    // a warm-up ends with the first message, not a booking; a chat already had is not booked again by its own event
    expect(decideTransition('warming', { type: 'event_scheduled', confidence: 0.9 })).toBeUndefined();
    expect(decideTransition('completed', { type: 'event_scheduled', confidence: 0.9 })).toBeUndefined();
  });

  it('Scheduled → Completed when the meeting ended, and back to Scheduling when it was cancelled', () => {
    expect(decideTransition('scheduled', { type: 'event_ended', confidence: 0.95 })).toEqual({
      to: 'completed',
      confidence: 0.95,
      reason: 'calendar:event_ended',
    });
    expect(decideTransition('scheduling', { type: 'event_ended', confidence: 0.95 })).toBeUndefined();
    expect(decideTransition('scheduled', { type: 'event_cancelled' })?.to).toBe('scheduling');
    // notes from the chat complete it too, even when no calendar held it
    expect(decideTransition('scheduling', { type: 'note_ingested', confidence: 0.9 })?.to).toBe('completed');
  });

  it('Completed → Thanked when the thank-you is sent, and nothing else sent there moves it', () => {
    expect(decideTransition('completed', { type: 'outbound_sent', kind: 'thank_you' })).toEqual({
      to: 'followed_up',
      confidence: 1,
      reason: 'outbound:thank_you',
    });
    expect(decideTransition('replied', { type: 'outbound_sent', kind: 'thank_you' })).toBeUndefined();
  });

  it('Thanked → Staying in touch two weeks later, and Completed too when no thank-you was ever recorded', () => {
    expect(decideTransition('followed_up', { type: 'timer_followed_up_14d' })?.to).toBe('nurturing');
    expect(decideTransition('completed', { type: 'timer_completed_14d' })?.to).toBe('nurturing');
    expect(decideTransition('nurturing', { type: 'timer_followed_up_14d' })).toBeUndefined();
  });

  it('a move to the stage a chat is already in is never a move', () => {
    expect(
      decideTransition('replied', { type: 'inbound_signal', signal: 'reply_positive', confidence: 1 }),
    ).toBeUndefined();
    expect(decideTransition('scheduled', { type: 'event_scheduled', confidence: 1 })).toBeUndefined();
    expect(decideTransition('followed_up', { type: 'outbound_sent', kind: 'thank_you' })).toBeUndefined();
  });
});
