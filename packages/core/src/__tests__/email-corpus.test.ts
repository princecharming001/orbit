import { describe, expect, it } from 'vitest';
import { heuristicSignal, heuristicTriage } from '../email/triage';
import { isAutomatedSender, splitSignature, stripQuotedReply } from '../text/email';
import type { ProposedTime } from '../types';
import { CORPUS_NOW, CORPUS_TZ, MESSAGES, THREADS } from './fixtures/email-corpus';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function wall(iso: string, tz: string): { label: string; hm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hm = `${get('hour').padStart(2, '0')}:${get('minute')}`;
  return { label: `${get('weekday')} ${get('month')}/${get('day')}`, hm };
}
function fmt(t: ProposedTime): string {
  const tz = t.timeZone ?? CORPUS_TZ;
  const s = wall(t.startIso, tz);
  return `${s.label} ${s.hm}${t.endIso ? `-${wall(t.endIso, tz).hm}` : ''}`;
}

function read(m: (typeof MESSAGES)[number]) {
  const stripped = stripQuotedReply(m.body);
  const sig = splitSignature(stripped);
  const body = sig.body || stripped;
  return { body, ...heuristicSignal(body, m.direction, CORPUS_NOW, { timeZone: CORPUS_TZ }) };
}

describe('email corpus', () => {
  it('has a realistic number of messages', () => {
    expect(MESSAGES.length + THREADS.reduce((n, t) => n + t.messages.length, 0)).toBeGreaterThanOrEqual(60);
    expect(new Set(MESSAGES.map((m) => m.id)).size).toBe(MESSAGES.length);
    expect(DOW.length).toBe(7);
  });

  for (const m of MESSAGES)
    it(`${m.id}: ${m.expect.signal}`, () => {
      const r = read(m);
      expect(r.signal).toBe(m.expect.signal);
      if (m.expect.times) expect(r.extraction.proposedTimes.map(fmt)).toEqual(m.expect.times);
      if (m.expect.zone) for (const t of r.extraction.proposedTimes) expect(t.timeZone).toBe(m.expect.zone);
      else for (const t of r.extraction.proposedTimes) expect(t.timeZone).toBeUndefined();
      if (m.expect.automated !== undefined)
        expect(isAutomatedSender(m.from, m.headers ?? {}, [])).toBe(m.expect.automated);
      if (m.expect.returnDate) expect(r.extraction.returnDate).toBe(m.expect.returnDate);
      for (const k of m.expect.bodyKeeps ?? []) expect(r.body).toContain(k);
      for (const k of m.expect.bodyDrops ?? []) expect(r.body).not.toContain(k);
      if (m.expect.offers !== undefined) expect(r.extraction.offers.length).toBe(m.expect.offers);
      if (m.expect.asks !== undefined) expect(r.extraction.asksOfUser.length).toBe(m.expect.asks);
      // never propose a time that has already passed
      for (const t of r.extraction.proposedTimes)
        expect(new Date(t.startIso).getTime()).toBeGreaterThan(CORPUS_NOW.getTime());
    });

  for (const t of THREADS)
    it(`thread ${t.id}: ${t.expect.category}`, () => {
      const r = heuristicTriage({
        subject: t.subject,
        messages: t.messages.map((m) => ({
          fromEmail: m.from,
          direction: m.direction,
          body: m.body,
          isAutomated: m.isAutomated ?? false,
        })),
        userEmails: ['alex.rivera@cornell.edu', 'ar123@cornell.edu'],
      });
      expect(r.category).toBe(t.expect.category);
      expect(r.isNetworking).toBe(t.expect.isNetworking);
    });
});
