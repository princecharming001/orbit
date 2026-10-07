import { describe, expect, it } from 'vitest';
import { extractProposedTimes, heuristicSignal, heuristicTriage } from '../email/triage';
import { heuristicNoteExtraction } from '../notes/extract';
import { canTransition, decideTransition } from '../pipeline/transitions';
import { buildWarmUpPlan, warmUpProgress } from '../warmup/rules';

describe('transitions', () => {
  it('follows the table', () => {
    expect(decideTransition('identified', { type: 'outbound_sent', kind: 'outreach' })).toMatchObject({
      to: 'outreach_sent',
    });
    expect(decideTransition('warming', { type: 'outbound_sent', kind: 'outreach' })).toMatchObject({
      to: 'outreach_sent',
    });
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'reply_positive',
        confidence: 0.9,
      }),
    ).toMatchObject({ to: 'replied' });
    expect(
      decideTransition('outreach_sent', {
        type: 'inbound_signal',
        signal: 'reply_decline',
        confidence: 0.95,
      })!.confidence,
    ).toBeLessThan(0.8);
    expect(decideTransition('scheduled', { type: 'event_ended', confidence: 0.95 })).toMatchObject({
      to: 'completed',
    });
    expect(decideTransition('completed', { type: 'outbound_sent', kind: 'thank_you' })).toMatchObject({
      to: 'followed_up',
    });
    expect(decideTransition('followed_up', { type: 'timer_followed_up_14d' })).toMatchObject({
      to: 'nurturing',
    });
    expect(
      decideTransition('outreach_sent', { type: 'timer_no_response', bumps: 2, maxBumps: 2, daysSilent: 15 }),
    ).toMatchObject({ to: 'no_response' });
    expect(
      decideTransition('completed', { type: 'inbound_signal', signal: 'reply_positive', confidence: 0.9 }),
    ).toBeUndefined();
    expect(canTransition('archived', 'scheduled', 'user')).toBe(true);
    expect(canTransition('archived', 'scheduled', 'system')).toBe(false);
  });
});

describe('triage and signals', () => {
  const ref = new Date('2026-10-05T12:00:00Z'); // Monday
  it('classifies networking threads', () => {
    const r = heuristicTriage({
      subject: 'Coffee chat?',
      messages: [
        {
          fromEmail: 'alex@cornell.edu',
          direction: 'outbound',
          body: 'Would you be open to a 20-minute call to hear about your path?',
          isAutomated: false,
        },
      ],
      userEmails: ['alex@cornell.edu'],
    });
    expect(r.isNetworking).toBe(true);
    const o = heuristicTriage({
      subject: 'Your order has shipped',
      messages: [
        {
          fromEmail: 'orders@amazon.com',
          direction: 'inbound',
          body: 'Your order #123 has shipped. Track your delivery.',
          isAutomated: true,
        },
      ],
      userEmails: [],
    });
    expect(o.category).toBe('automated');
    const rec = heuristicTriage({
      subject: 'Next steps',
      messages: [
        {
          fromEmail: 'recruiting@stripe.com',
          direction: 'inbound',
          body: 'Thanks for completing the online assessment. Next steps: a phone screen with the hiring manager.',
          isAutomated: false,
        },
      ],
      userEmails: [],
    });
    expect(rec.category).toBe('recruiting_process');
  });
  it('extracts proposed times', () => {
    const t = extractProposedTimes('Would Thursday at 2pm work? Or Fri 10:30am.', ref);
    expect(t.length).toBe(2);
    expect(new Date(t[0]!.startIso).getDay()).toBe(4);
    expect(new Date(t[0]!.startIso).getHours()).toBe(14);
    expect(new Date(t[1]!.startIso).getMinutes()).toBe(30);
  });
  it('classifies signals', () => {
    expect(heuristicSignal('Sure! Would Thursday at 2pm work?', 'inbound', ref).signal).toBe(
      'scheduling_proposal',
    );
    expect(
      heuristicSignal('Unfortunately I am not able to take calls this quarter.', 'inbound', ref).signal,
    ).toBe('reply_decline');
    expect(heuristicSignal('Happy to refer you when the posting goes up.', 'inbound', ref).signal).toBe(
      'referral_offer',
    );
    expect(heuristicSignal('Thanks so much for your time today!', 'outbound', ref).signal).toBe('thank_you');
    expect(heuristicSignal('I am out of office until Monday.', 'inbound', ref).signal).toBe('out_of_office');
    expect(heuristicSignal('Happy to chat, let me know what works.', 'inbound', ref).signal).toBe(
      'reply_positive',
    );
    expect(heuristicSignal('Confirmed, see you then!', 'inbound', ref).signal).toBe(
      'scheduling_confirmation',
    );
  });
});

describe('note extraction', () => {
  it('finds offers, action items, hooks, advice', () => {
    const r = heuristicNoteExtraction(
      'Priya recommended focusing on one project story. They are hiring interns in January. Priya offered to refer me when the posting goes up. I will send my resume by Friday. She ran a marathon in April.',
      'Priya',
    );
    expect(r.offers.length).toBe(1);
    expect(r.actionItems[0]?.text).toContain('resume');
    expect(r.actionItems[0]?.dueHint).toMatch(/friday/i);
    expect(r.facts.some((f) => f.type === 'advice')).toBe(true);
    expect(r.facts.some((f) => f.type === 'hook')).toBe(true);
    expect(r.facts.some((f) => f.type === 'personal')).toBe(true);
  });
});

describe('warm-up', () => {
  it('plans three actions and becomes ready after the window with at least one done', () => {
    const start = new Date('2026-10-01T10:00:00Z');
    const plan = buildWarmUpPlan('priya-patel', start, 4);
    expect(plan.actions.length).toBe(3);
    expect(plan.actions[1]!.url).toContain('recent-activity');
    expect(warmUpProgress(plan, new Date('2026-10-02T10:00:00Z')).ready).toBe(false);
    plan.actions[0]!.doneAt = '2026-10-01T11:00:00Z';
    // four working days after Thursday Oct 1 is Wednesday Oct 7 (the weekend does not count)
    expect(warmUpProgress(plan, new Date('2026-10-08T10:00:00Z')).ready).toBe(true);
    expect(warmUpProgress(plan, new Date('2026-10-02T10:00:00Z')).nextAction?.id).toBe('w2');
  });

  it('never puts a step on a weekend (EG-20)', () => {
    const plan = buildWarmUpPlan('x', new Date(2026, 9, 2, 10), 4); // Friday Oct 2, local time
    const days = [...plan.actions.slice(1).map((a) => a.dueAt), plan.readyAt].map((d) =>
      new Date(d).getDay(),
    );
    expect(days.every((d) => d !== 0 && d !== 6)).toBe(true);
    expect(new Date(plan.actions[1]!.dueAt).getDate()).toBe(6); // Tuesday, not Sunday Oct 4
    expect(new Date(plan.readyAt).getDate()).toBe(8); // Thursday
  });
});
