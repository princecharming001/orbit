import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../demo/seed';
import { fitResiduals, fitTieWeights } from '../scoring/tieFit';
import {
  buildTieHistory,
  computeTieFeatures,
  explainTie,
  fitCalibration,
  scoreFromZ,
  scoreTie,
  sharedContext,
  TIE_FEATURES,
  TIE_WEIGHTS,
  type TieHistory,
  type TieMessage,
  tieBand,
  tieBandTier,
  warmthValue,
} from '../scoring/tieScore';
import { isAtsSender } from '../text/email';
import type { Affiliation, Person, Touchpoint } from '../types';
import { ANCHORS, at, empty, msg } from './fixtures/tie-anchors';

const NOW = new Date('2026-10-14T12:00:00Z');
const DAY = 86_400_000;

describe('tie score anchors (§3.7)', () => {
  for (const a of ANCHORS)
    it(`${a.id} lands in ${a.range[0]}–${a.range[1]}`, () => {
      const s = scoreTie(a.history(NOW), NOW);
      expect(s.score).toBeGreaterThanOrEqual(a.range[0]);
      expect(s.score).toBeLessThanOrEqual(a.range[1]);
      expect(s.modelVersion).toBe('tie-v1');
      expect(s.band).toBe(tieBand(s.score));
    });

  it('the anchors land where the weights comment says', () => {
    const scores = Object.fromEntries(ANCHORS.map((a) => [a.id, scoreTie(a.history(NOW), NOW).score]));
    expect(scores).toEqual({ A1: 11, A2: 8, A3: 31, A4: 90, A5: 46, A6: 17, A7: 53, A8: 20 });
  });

  it('frozen weights are the ridge fit to the anchors, rounded', () => {
    const rows = ANCHORS.filter((a) => a.id !== 'A6').map((a) => ({
      features: computeTieFeatures(a.history(NOW), NOW).features,
      target: (a.range[0] + a.range[1]) / 2,
      range: [a.range[0] + 1, a.range[1] - 1] as [number, number],
    }));
    const fit = fitTieWeights(rows, {
      ridge: 0.1,
      rangePenalty: 10,
      fixed: ['intros', 'structural', 'warmth'],
      bounds: {
        time: [0.2, Number.POSITIVE_INFINITY],
        recency: [0, Number.POSITIVE_INFINITY],
        log_out: [0.1, Number.POSITIVE_INFINITY],
        log_in: [0.2, Number.POSITIVE_INFINITY],
        reciprocity: [0, 2],
        log_meetings: [0.6, Number.POSITIVE_INFINITY],
        log_threads: [0, Number.POSITIVE_INFINITY],
        latency: [0, 1.6],
        shared: [0, Number.POSITIVE_INFINITY],
        linkedin: [0, 1.2],
        never: [Number.NEGATIVE_INFINITY, -0.1],
      },
    });
    for (const k of ['bias', ...TIE_FEATURES] as const)
      expect(Math.abs(fit[k] - TIE_WEIGHTS[k])).toBeLessThan(0.006);
    const res = fitResiduals(rows, TIE_WEIGHTS).map((r) => Math.round(r * 10) / 10);
    expect(res).toEqual([-0.1, 1.4, -6.6, 0.3, 1.5, 0.1, -0.4]);
    // silence never raises a score
    expect(TIE_WEIGHTS.log_days_last).toBeLessThanOrEqual(-TIE_WEIGHTS.log_days_first);
  });

  it('A6: ten unanswered messages are capped at 20', () => {
    const s = scoreTie(ANCHORS.find((a) => a.id === 'A6')!.history(NOW), NOW);
    expect(s.score).toBeLessThanOrEqual(20);
    expect(s.explanation).toContain('Mostly one-way: 10 sent, 0 back');
  });

  it('A5: a former close tie two years dormant stays well above a stranger', () => {
    const s = scoreTie(ANCHORS.find((a) => a.id === 'A5')!.history(NOW), NOW);
    expect(s.score).toBeGreaterThanOrEqual(35);
    expect(s.explanation.at(-1)).toBe('Last real exchange was 2 years ago');
  });
});

/** Random but plausible histories: a few threads, replies some of the time, meetings now and then. */
function randomHistory(rnd: () => number): TieHistory {
  const messages: TieMessage[] = [];
  const meetings: TieHistory['meetings'] = [];
  const threads = Math.floor(rnd() * 6);
  const typical = 1 + rnd() * 60;
  for (let t = 0; t < threads; t++) {
    const start = 5 + rnd() * 900;
    messages.push(msg(NOW, start, 'out', `t${t}`));
    if (rnd() < 0.6) {
      const lat = typical * (0.5 + rnd());
      messages.push(msg(NOW, start - lat / 24, 'in', `t${t}`, { isReplyLatencyHours: lat }));
      if (rnd() < 0.5) messages.push(msg(NOW, start - lat / 24 - 0.5, 'out', `t${t}`));
    }
  }
  const m = Math.floor(rnd() * 3);
  for (let i = 0; i < m; i++)
    meetings.push({ at: at(NOW, 3 + rnd() * 700), attendees: 2 + Math.floor(rnd() * 5) });
  const connected = rnd() < 0.6;
  return empty({
    messages,
    meetings,
    linkedinConnected: connected,
    connectedAt: connected ? at(NOW, 10 + rnd() * 1000) : undefined,
    intros: rnd() < 0.1 ? 1 : 0,
    shared: { sameSchool: rnd() < 0.3, overlappingEmployer: false, sameCity: rnd() < 0.2 },
    noteWarmth: rnd() < 0.2 ? [rnd() < 0.5 ? 1 : 0] : [],
  });
}

describe('A9: monotonic', () => {
  it('adding one inbound reply never lowers a score', () => {
    const rnd = mulberry32(7);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const h = randomHistory(rnd);
      const outs = h.messages.filter((m) => m.direction === 'out');
      if (!outs.length) continue;
      // they answer the student's latest message no slower than they usually do (their lower median latency); a
      // reply slower than usual lowers f8 by design, so it is not part of this property
      const last = outs.reduce((a, b) => (a.at > b.at ? a : b));
      const lats = h.messages.flatMap((m) =>
        m.isReplyLatencyHours === undefined ? [] : [m.isReplyLatencyHours],
      );
      const usual = lats.length ? lats.sort((a, b) => a - b)[(lats.length - 1) >> 1]! : 24;
      const replyAt = Math.min(new Date(last.at).getTime() + usual * 3_600_000, NOW.getTime());
      const reply: TieMessage = {
        ...last,
        direction: 'in',
        at: new Date(replyAt).toISOString(),
        isReplyLatencyHours: (replyAt - new Date(last.at).getTime()) / 3_600_000,
      };
      const before = scoreTie(h, NOW);
      const after = scoreTie({ ...h, messages: [...h.messages, reply] }, NOW);
      expect(after.score, JSON.stringify(h)).toBeGreaterThanOrEqual(before.score);
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
  });

  it('30 more days of silence never raises a score', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 400; i++) {
      const h = randomHistory(rnd);
      const now = scoreTie(h, NOW);
      const later = scoreTie(h, new Date(NOW.getTime() + 30 * DAY));
      expect(later.score, JSON.stringify(h)).toBeLessThanOrEqual(now.score);
      expect(later.z).toBeLessThanOrEqual(now.z + 1e-12);
    }
  });
});

describe('calibration (§3.5)', () => {
  it('A10: eight "very close" labels on people scoring ~40 move them above 75', () => {
    const z = Math.log(0.4 / 0.6);
    expect(scoreFromZ(z)).toBe(40);
    const labels = Array.from({ length: 8 }, (_, i) => ({ z: z + (i - 3.5) * 0.02, closeness: 5 }));
    const cal = fitCalibration(labels)!;
    expect(cal).toBeDefined();
    for (const l of labels) expect(scoreFromZ(l.z, cal)).toBeGreaterThan(75);
  });

  it('needs eight labels, is deterministic, and leaves consistent labels near the global model', () => {
    expect(fitCalibration([{ z: 0, closeness: 3 }])).toBeUndefined();
    const consistent = [-3, -2, -1, -0.5, 0.5, 1, 2, 3].map((z) => ({
      z,
      closeness: Math.min(5, Math.max(1, Math.round(1 + 4 / (1 + Math.exp(-z))))),
    }));
    const a = fitCalibration(consistent)!;
    expect(a).toEqual(fitCalibration(consistent));
    expect(Math.abs(a.a - 1)).toBeLessThan(0.6);
    expect(Math.abs(a.c)).toBeLessThan(0.5);
  });

  it('applies the calibration to the score', () => {
    const h = ANCHORS[2]!.history(NOW);
    const base = scoreTie(h, NOW);
    const up = scoreTie(h, NOW, TIE_WEIGHTS, { a: 1, c: 1 });
    expect(up.score).toBeGreaterThan(base.score);
  });

  it("shows a labelled person's band midpoint until new contact", () => {
    const h = ANCHORS[2]!.history(NOW);
    const labelled = scoreTie({ ...h, label: { closeness: 5, at: at(NOW, 1) } }, NOW);
    expect(labelled.score).toBe(90);
    expect(labelled.labelled).toBe(true);
    const newer = scoreTie(
      { ...h, label: { closeness: 5, at: at(NOW, 1) }, messages: [...h.messages, msg(NOW, 0.5, 'in', 't')] },
      NOW,
    );
    expect(newer.labelled).toBe(false);
    expect(newer.score).not.toBe(90);
  });
});

describe('bands and the cap', () => {
  it('maps bands to the v1 tiers', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(tieBand)).toEqual([
      'faint',
      'faint',
      'light',
      'light',
      'warm',
      'warm',
      'strong',
      'strong',
      'close',
      'close',
    ]);
    expect(tieBandTier('close')).toBe('strong');
    expect(tieBandTier('strong')).toBe('strong');
    expect(tieBandTier('warm')).toBe('medium');
    expect(tieBandTier('light')).toBe('weak');
    expect(tieBandTier('faint')).toBe('weak');
  });

  it('caps unanswered mail, but not someone the student met', () => {
    const many = Array.from({ length: 12 }, (_, i) => msg(NOW, 1 + i, 'out', `c${i}`));
    const capped = scoreTie(
      empty({ messages: many, linkedinConnected: true, connectedAt: at(NOW, 30) }),
      NOW,
    );
    expect(capped.score).toBeLessThanOrEqual(20);
    const met = scoreTie(empty({ messages: many, meetings: [{ at: at(NOW, 2), attendees: 2 }] }), NOW);
    expect(met.capped).toBe(false);
    expect(met.score).toBeGreaterThan(20);
  });

  it('ignores automated mail, big threads and big meetings', () => {
    const noisy = empty({
      messages: [
        msg(NOW, 3, 'in', 'ats', { automated: true }),
        msg(NOW, 3, 'in', 'list', { threadParticipants: 30 }),
      ],
      meetings: [{ at: at(NOW, 5), attendees: 40 }],
    });
    const s = scoreTie(noisy, NOW);
    expect(s.features.never).toBe(1);
    expect(s.features.log_in).toBe(0);
    expect(s.score).toBe(scoreTie(empty(), NOW).score);
  });

  it('ranks a close friend above an acquaintance above a stranger', () => {
    const close = scoreTie(ANCHORS.find((a) => a.id === 'A4')!.history(NOW), NOW).score;
    const acquaintance = scoreTie(ANCHORS.find((a) => a.id === 'A3')!.history(NOW), NOW).score;
    const stranger = scoreTie(empty(), NOW).score;
    expect(close).toBeGreaterThan(acquaintance);
    expect(acquaintance).toBeGreaterThan(stranger);
  });
});

describe('explainTie (§3.4)', () => {
  it('a close tie is explained by its messages and meetings', () => {
    const s = scoreTie(ANCHORS.find((a) => a.id === 'A4')!.history(NOW), NOW);
    expect(s.explanation).toContain('52 messages between you (26 from them)');
    expect(s.explanation).toContain('3 meetings in the last 2 years');
    expect(s.explanation).toContain('Usually replies within 5 hours');
    expect(s.explanation.length).toBeLessThanOrEqual(4);
  });

  it('says when someone is only a LinkedIn connection', () => {
    expect(scoreTie(ANCHORS[0]!.history(NOW), NOW).explanation).toEqual([
      'Connected on LinkedIn, never talked',
    ]);
    const a8 = scoreTie(ANCHORS.find((a) => a.id === 'A8')!.history(NOW), NOW).explanation;
    expect(a8).toEqual(['You both went to Cornell University', 'Connected on LinkedIn, never talked']);
    expect(scoreTie(empty(), NOW).explanation).toEqual(["You haven't talked yet"]);
  });

  it('builds sentences from raw counts', () => {
    const h = empty({
      name: 'Priya',
      messages: [
        msg(NOW, 400, 'out', 'x'),
        msg(NOW, 380, 'in', 'x', { isReplyLatencyHours: 96 }),
        msg(NOW, 379, 'out', 'x'),
      ],
      intros: 1,
      introRole: 'they_introduced_you',
      shared: {
        sameSchool: false,
        overlappingEmployer: true,
        sameCity: false,
        employer: 'Stripe',
        overlapYears: '2021–2023',
      },
      mutualScores: [80, 70],
      mutualNames: ['Maya', 'Leo'],
      noteWarmth: [1],
    });
    const s = scoreTie(h, NOW);
    const all = [...s.explanation];
    expect(all.length).toBe(4);
    const { explanation } = explainTie(s.features, s.facts);
    expect(explanation).toEqual(all);
    const text = all.join(' | ');
    expect(text).toMatch(
      /Priya introduced you to someone|You overlapped at Stripe \(2021–2023\)|Close with people/,
    );
    expect(all.at(-1)).toMatch(/^(Last real exchange was 12 months ago|Takes about 4 days to reply)$/);
  });

  it('contributions are measured from the population baseline', () => {
    const s = scoreTie(empty(), NOW);
    for (const k of TIE_FEATURES) expect(Number.isFinite(s.contributions[k])).toBe(true);
    expect(s.contributions.never).toBeLessThan(0);
  });
});

describe('isAtsSender (§19.1)', () => {
  it('flags applicant tracking systems and no-reply senders', () => {
    for (const e of [
      'no-reply@greenhouse.io',
      'jane@greenhouse.io',
      'recruiting@hire.lever.co',
      'stripe@myworkday.com',
      'x@wd5.myworkday.com',
      'talent@workday.com',
      'jobs@ashbyhq.com',
      'a@icims.com',
      'b@smartrecruiters.com',
      'c@jobvite.com',
      'noreply@stripe.com',
      'do-not-reply@bank.com',
      'donotreply@school.edu',
      'careers-noreply@figma.com',
    ])
      expect(isAtsSender(e), e).toBe(true);
    for (const e of ['maya@stripe.com', 'replyguy@gmail.com', 'noreen@figma.com'])
      expect(isAtsSender(e), e).toBe(false);
  });
});

const person = (extra: Partial<Person> = {}): Person => ({
  id: 'p',
  userId: 'u',
  displayName: 'Sam Lee',
  firstName: 'Sam',
  lastName: 'Lee',
  nameNormalized: 'sam lee',
  emails: ['sam@stripe.com'],
  primaryEmail: 'sam@stripe.com',
  relationshipType: 'unknown',
  strength: 0,
  interactionCount: 0,
  sources: ['gmail'],
  isHuman: true,
  tags: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  ...extra,
});

const tp = (kind: Touchpoint['kind'], daysAgo: number, extra: Partial<Touchpoint> = {}): Touchpoint => ({
  id: `${kind}${daysAgo}`,
  userId: 'u',
  personId: 'p',
  kind,
  occurredAt: at(NOW, daysAgo),
  refTable: 'messages',
  refId: `m${daysAgo}`,
  weight: 0.6,
  ...extra,
});

describe('buildTieHistory', () => {
  it('turns touchpoints into messages, groups them into exchanges and reads reply latency', () => {
    const h = buildTieHistory({
      person: person(),
      touchpoints: [
        tp('email_out', 10),
        tp('email_in', 9.5),
        tp('email_out', 200),
        tp('linkedin_out', 50),
        tp('email_cc', 3),
        tp('note', 2),
      ],
    });
    expect(h.messages).toHaveLength(4);
    const recent = h.messages.filter((m) => m.channel === 'email' && m.at > at(NOW, 20));
    expect(new Set(recent.map((m) => m.threadId)).size).toBe(1);
    expect(recent.find((m) => m.direction === 'in')!.isReplyLatencyHours).toBeCloseTo(12, 5);
    const old = h.messages.find((m) => m.at === at(NOW, 200))!;
    expect(old.threadId).not.toBe(recent[0]!.threadId);
    expect(h.name).toBe('Sam');
  });

  it('uses message records for threads and the automated flag when it has them', () => {
    const messages = new Map([
      [
        'm5',
        {
          id: 'm5',
          threadId: 'T',
          isAutomated: false,
          direction: 'inbound',
          fromEmail: 'sam@stripe.com',
        } as unknown as import('../types').EmailMessage,
      ],
      [
        'm4',
        {
          id: 'm4',
          threadId: 'U',
          isAutomated: false,
          direction: 'inbound',
          fromEmail: 'no-reply@greenhouse.io',
        } as unknown as import('../types').EmailMessage,
      ],
    ]);
    const threads = new Map([
      ['T', { id: 'T', participantPersonIds: ['p', 'q'] } as unknown as import('../types').EmailThread],
    ]);
    const h = buildTieHistory({
      person: person(),
      touchpoints: [tp('email_in', 5), tp('email_in', 4)],
      messages,
      threads,
    });
    expect(h.messages.find((m) => m.threadId === 'T')!.threadParticipants).toBe(3);
    expect(h.messages.find((m) => m.threadId === 'U')!.automated).toBe(true);
  });

  it('makes every email from an ATS person automated, and reads meetings, intros, logs and LinkedIn', () => {
    const ats = buildTieHistory({
      person: person({ primaryEmail: 'jobs@lever.co', emails: ['jobs@lever.co'] }),
      touchpoints: [tp('email_in', 3)],
    });
    expect(ats.messages[0]!.automated).toBe(true);
    const h = buildTieHistory({
      person: person({ linkedinConnectedOn: '2025-01-02' }),
      touchpoints: [
        tp('meeting', 4, { refTable: 'events', refId: 'e1' }),
        tp('meeting', 4, { refTable: 'notes', refId: 'n1:meeting' }),
        tp('intro_observed', 6),
        tp('manual_log', 2, { weight: 0.6 }),
        tp('manual_log', 1, { weight: 0.3 }),
      ],
    });
    expect(h.meetings).toHaveLength(1);
    expect(h.intros).toBe(1);
    expect(h.introRole).toBe('introduced_to_you');
    expect(h.messages.map((m) => m.direction).sort()).toEqual(['in', 'out']);
    expect(h.linkedinConnected).toBe(true);
    expect(h.connectedAt).toBe('2025-01-02T12:00:00.000Z');
  });

  it('reads shared school, employer and city', () => {
    const aff: Affiliation = {
      id: 'a',
      userId: 'u',
      personId: 'p',
      kind: 'employment',
      nameRaw: 'Stripe',
      startDate: '2021-06-01',
      endDate: '2023-08-01',
      isCurrent: false,
      source: 'manual',
    };
    const sh = sharedContext({
      person: person({ school: 'Cornell University', location: 'New York, NY' }),
      user: { school: 'Cornell University', currentCity: 'New York' },
      userEmployers: [{ name: 'Stripe, Inc.', startDate: '2022-06-01', endDate: '2022-08-31' }],
      affiliations: [aff],
    });
    expect(sh).toMatchObject({
      sameSchool: true,
      overlappingEmployer: true,
      sameCity: true,
      school: 'Cornell University',
      employer: 'Stripe',
      overlapYears: '2022',
      city: 'New York',
    });
    expect(computeTieFeatures(empty({ shared: sh }), NOW).features.shared).toBe(2);
  });

  it('converts note warmth', () => {
    expect([
      warmthValue('warm'),
      warmthValue('neutral'),
      warmthValue('cool'),
      warmthValue(undefined),
    ]).toEqual([1, 0, -1, 0]);
  });
});
