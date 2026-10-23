import { describe, expect, it } from 'vitest';
import { isKnownContact } from '../scoring/known';
import { tieStrength } from '../scoring/tieScore';
import type { Person, Touchpoint, TouchpointKind } from '../types';

/**
 * Closeness from LinkedIn (plan 17 B): direct messages count like email, comments and reactions on posts are weak
 * and capped, and a person known from several channels adds them up. Built from touchpoints through the same path
 * the browser uses (buildTieHistory → scoreTie), one touch per day each way for messages and texts.
 */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

const person = (patch: Partial<Person> = {}): Person =>
  ({
    id: 'p1',
    userId: 'u1',
    displayName: 'Sam Lee',
    firstName: 'Sam',
    lastName: 'Lee',
    nameNormalized: 'sam lee',
    emails: [],
    sources: ['linkedin_live'],
    isHuman: true,
    strength: 0,
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...patch,
  }) as unknown as Person;

let n = 0;
/** A touch `daysAgo` days before now, `hours` into that day. */
const tp = (kind: TouchpointKind, daysAgo: number, hours = 0): Touchpoint => ({
  id: `tp${n++}`,
  userId: 'u1',
  personId: 'p1',
  kind,
  occurredAt: new Date(NOW.getTime() - daysAgo * DAY + hours * HOUR).toISOString(),
  refTable: kind.startsWith('linkedin_') ? 'linkedin_dm' : 'texts',
  refId: `r${n}`,
  weight: 0.5,
});

const score = (p: Person, touches: Touchpoint[]) => tieStrength({ person: p, touchpoints: touches }, NOW);

describe('LinkedIn in closeness: scoring fixtures', () => {
  it('a friend you only message on LinkedIn is warm to strong, like an email friend', () => {
    // a year of LinkedIn messages every six weeks or so, both ways, answered the next day; the last a month ago
    const touches: Touchpoint[] = [];
    for (let d = 31; d <= 365; d += 45) touches.push(tp('linkedin_out', d, 9), tp('linkedin_in', d - 1, 11));
    const dm = score(person({ linkedinConnectedOn: '2024-09-01' }), touches);
    // the same history by email scores the same: a LinkedIn message counts like an email
    const email = score(
      person({ linkedinConnectedOn: '2024-09-01' }),
      touches.map((t) => ({ ...t, kind: t.kind === 'linkedin_out' ? 'email_out' : 'email_in' })),
    );
    expect(['warm', 'strong']).toContain(dm.tie.band);
    expect(dm.tie.score).toBe(email.tie.score);
    expect(dm.tie.explanation.join(' ')).toMatch(/messages between you/);
  });

  it('a stranger who reacts to every post is faint, not a tie, and not someone the student knows', () => {
    const touches: Touchpoint[] = [];
    for (let d = 3; d <= 360; d += 7) touches.push(tp('linkedin_reaction_in', d));
    touches.push(tp('linkedin_comment_in', 10), tp('linkedin_comment_in', 40));
    const s = score(person(), touches);
    expect(s.tie.band).toBe('faint');
    expect(s.strength).toBe(0);
    expect(isKnownContact({ ...person(), strengthBreakdown: s.breakdown, sources: [] })).toBe(false);
    // engagement alone never lifts much: at most the f15 weight in the logit
    expect(s.tie.features.engagement).toBeLessThanOrEqual(1);
  });

  it('a connection who comments on your posts is lifted a little, and capped', () => {
    const base = score(person({ linkedinConnectedOn: '2025-01-10' }), []);
    const touches: Touchpoint[] = [];
    for (let d = 5; d <= 200; d += 10)
      touches.push(tp('linkedin_comment_in', d), tp('linkedin_reaction_in', d));
    const engaged = score(person({ linkedinConnectedOn: '2025-01-10' }), touches);
    expect(engaged.tie.score).toBeGreaterThan(base.tie.score);
    expect(engaged.tie.score - base.tie.score).toBeLessThanOrEqual(10);
    expect(engaged.tie.band).toBe(base.tie.band);
    expect(engaged.tie.explanation.join(' ')).toMatch(/comments on your LinkedIn posts/);
  });

  it('a recruiter who wrote first and you answered is light: one exchange, not a relationship', () => {
    // their InMail three weeks ago, the student's answer the next day, their reply the day after that
    const s = score(person(), [
      tp('linkedin_in', 21, 10),
      tp('linkedin_out', 20, 9),
      tp('linkedin_in', 19, 15),
    ]);
    expect(s.tie.band).toBe('light');
    expect(s.tie.capped).toBe(false);
    // the reply latency is read from the student's message to theirs (30 hours), not from their first InMail
    expect(s.tie.facts.medianLatencyHours).toBeCloseTo(30, 5);
  });

  it('someone you email, text and message on LinkedIn adds it all up: strong or close', () => {
    // a few texts, a few emails and a few LinkedIn messages over the last year, each answered within a day or two
    const touches: Touchpoint[] = [];
    for (const d of [20, 140, 260]) touches.push(tp('text_out', d, 18), tp('text_in', d - 1, 9));
    for (const d of [60, 180, 300]) touches.push(tp('email_out', d, 9), tp('email_in', d - 1, 15));
    for (const d of [100, 220, 340]) touches.push(tp('linkedin_out', d, 10), tp('linkedin_in', d - 2, 12));
    const p = person({ linkedinConnectedOn: '2024-03-01' });
    const all = score(p, touches);
    const one = (prefix: string) =>
      score(
        p,
        touches.filter((t) => t.kind.startsWith(prefix)),
      ).tie.score;
    expect(['strong', 'close']).toContain(all.tie.band);
    for (const prefix of ['text_', 'email_', 'linkedin_']) expect(all.tie.score).toBeGreaterThan(one(prefix));
    expect(all.tie.explanation.join(' ')).toMatch(/18 messages between you \(9 from them\)/);
  });
});
