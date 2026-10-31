import { describe, expect, it } from 'vitest';
import { addDaysKey, nextSendWindow, zonedParts } from '../compose/window';
import {
  AUTO_KINDS,
  AUTO_SEND_DAILY_CAP,
  AUTOPILOT_MODE_LEVEL,
  AUTOPILOT_MODES,
  type AutonomyContext,
  autonomyAllows,
  SEND_CAPS,
} from '../safety/rules';

/** Plan 29 §B2.1: one cap table, read by the browser's outbox and the server's send job. */
describe('the cap table', () => {
  it('holds the numbers the plan names', () => {
    expect(SEND_CAPS).toEqual({
      gmailPerDay: 15,
      linkedinPerDay: 10,
      gmailSalesFirstTouchesPerDay: 30,
      autoPerDay: 5,
      autoFirstTouchesPerDay: 3,
      autoFirstTouchesPerWeek: 12,
      linkedinAutoPerDay: 0,
      linkedinInvitesPerDay: 15,
      linkedinInvitesPerWeek: 60,
    });
    expect(AUTO_SEND_DAILY_CAP).toBe(SEND_CAPS.autoPerDay);
  });

  it('names the ladder’s kinds in the order they are offered, and the three modes by level', () => {
    expect([...AUTO_KINDS]).toEqual(['bump', 'thank_you', 'schedule']);
    expect([...AUTOPILOT_MODES]).toEqual(['off', 'assist', 'autopilot']);
    expect(AUTOPILOT_MODE_LEVEL).toEqual({ off: 0, assist: 1, autopilot: 2 });
  });

  it('level 2 stops at the table’s auto cap and never on LinkedIn', () => {
    // Tuesday 9:00 in New York
    const now = new Date('2026-10-20T13:00:00Z');
    const ctx: AutonomyContext = {
      now,
      userEmails: ['sam@x.edu'],
      userName: 'Sam Rivera',
      recipient: {},
      history: [
        { direction: 'out', at: '2026-10-18T13:00:00Z' },
        { direction: 'in', at: '2026-10-19T13:00:00Z' },
      ],
      userAutonomy: 2,
      replyClass: 'scheduling',
      inThread: true,
      recipientScore: 60,
      validatorOk: true,
      autoSentToday: SEND_CAPS.autoPerDay - 1,
      recipientTimeZone: 'America/New_York',
    };
    const d = { channel: 'gmail' as const, personId: 'p', body: 'That works for me. Thanks, Sam' };
    expect(autonomyAllows(d, ctx).allowed).toBe(true);
    const capped = autonomyAllows(d, { ...ctx, autoSentToday: SEND_CAPS.autoPerDay });
    expect(capped.allowed).toBe(false);
    expect(capped.reasons).toContain(`${SEND_CAPS.autoPerDay} auto-sends today`);
    const linkedin = autonomyAllows({ ...d, channel: 'linkedin' }, ctx);
    expect(linkedin.allowed).toBe(false);
    expect(linkedin.reasons).toContain('not Gmail');
  });
});

/** The window the browser planner now schedules with (plan 29 §B2.1), and the day arithmetic it exports. */
describe('the shared send window', () => {
  it('counts calendar days by key, across a month end', () => {
    expect(addDaysKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('lands on a Tuesday to Thursday morning in the recipient’s zone, with bounded jitter', () => {
    // Friday 15:30 in Tokyo
    const now = new Date('2026-10-09T06:30:00Z');
    const w = nextSendWindow(now, 'Asia/Tokyo', 'gmail', () => 0.999);
    const p = zonedParts(new Date(w.notBefore), 'Asia/Tokyo');
    expect(p.weekday).toBe(2);
    expect(p.hour).toBe(8);
    expect(p.minute).toBe(20);
    // inside the window, the send is now plus jitter, never past the window's end
    const inside = new Date('2026-10-13T01:20:00Z');
    const w2 = nextSendWindow(inside, 'Asia/Tokyo', 'gmail', () => 0.999);
    expect(zonedParts(new Date(w2.notBefore), 'Asia/Tokyo')).toMatchObject({ hour: 10, minute: 30 });
  });
});
