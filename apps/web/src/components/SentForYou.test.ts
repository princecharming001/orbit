import { describe, expect, it } from 'vitest';
import { canUndo, sentLine } from './SentForYou';

// Tuesday Oct 6 2026, 8:41 am in New York
const SENT = '2026-10-06T12:41:00.000Z';
const TZ = 'America/New_York';

describe('Sent for you (plan 29 §B1)', () => {
  it('says when it went in their time, and booked when the reply booked a call', () => {
    expect(sentLine({ status: 'sent', sentAt: SENT, sendAt: null }, Date.parse(SENT) + 60_000, TZ)).toBe(
      'Sent 8:41 am their time',
    );
    expect(
      sentLine(
        { status: 'sent', sentAt: SENT, sendAt: null, outcome: 'booked' },
        Date.parse(SENT) + 60_000,
        TZ,
      ),
    ).toBe('Sent 8:41 am their time · booked');
  });

  it('counts down the minute while the send is ahead, and names the time beyond it', () => {
    const now = Date.parse(SENT);
    expect(
      sentLine({ status: 'queued', sentAt: null, sendAt: new Date(now + 30_000).toISOString() }, now, TZ),
    ).toBe('Sending in 30 s');
    expect(
      sentLine({ status: 'queued', sentAt: null, sendAt: new Date(now + 3_600_000).toISOString() }, now, TZ),
    ).toBe('Goes 9:41 am their time');
    expect(
      sentLine({ status: 'queued', sentAt: null, sendAt: new Date(now - 1000).toISOString() }, now, TZ),
    ).toBe('Sending now');
  });

  it('Undo shows only while the send is still ahead', () => {
    const now = Date.parse(SENT);
    expect(canUndo({ status: 'queued', sendAt: new Date(now + 45_000).toISOString() }, now)).toBe(true);
    expect(canUndo({ status: 'queued', sendAt: new Date(now - 1).toISOString() }, now)).toBe(false);
    expect(canUndo({ status: 'sent', sendAt: new Date(now + 45_000).toISOString() }, now)).toBe(false);
    expect(canUndo({ status: 'held', sendAt: null }, now)).toBe(false);
  });
});
