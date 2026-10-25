import { describe, expect, it } from 'vitest';
import { combinedPairWeights, describePairHop, inferEdges } from '../graph/edges';
import {
  combineTies,
  decayedTieWeight,
  inferTies,
  isRoutable,
  pairsFromEdges,
  TIE_CONFIDENCE,
  type Tie,
  type TieInput,
  tiesToEdges,
} from '../graph/ties';
import type { Affiliation, CalendarEvent, EmailMessage, EmailThread, Organization, Person } from '../types';

const NOW = new Date('2026-10-14T12:00:00Z');

const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  userId: 'u',
  displayName: `${id[0]!.toUpperCase()}${id.slice(1)} X`,
  firstName: `${id[0]!.toUpperCase()}${id.slice(1)}`,
  lastName: 'X',
  nameNormalized: `${id} x`,
  emails: [`${id}@x.com`],
  primaryEmail: `${id}@x.com`,
  relationshipType: 'unknown',
  strength: 0.5,
  interactionCount: 0,
  sources: ['gmail'],
  isHuman: true,
  tags: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const thread = (id: string, participants: string[], extra: Partial<EmailThread> = {}): EmailThread => ({
  id,
  userId: 'u',
  externalThreadId: id,
  messageCount: 2,
  participantEmails: participants.map((p) => `${p}@x.com`),
  participantPersonIds: participants,
  isNetworking: true,
  lastMessageAt: '2026-09-01T10:00:00Z',
  ...extra,
});

const message = (
  id: string,
  threadId: string,
  from: string | 'me',
  to: string[],
  cc: string[] = [],
  sentAt = '2026-09-01T10:00:00Z',
): EmailMessage => ({
  id,
  userId: 'u',
  threadId,
  externalMessageId: id,
  direction: from === 'me' ? 'outbound' : 'inbound',
  fromEmail: from === 'me' ? 'me@school.edu' : `${from}@x.com`,
  toEmails: to.map((t) => (t === 'me' ? 'me@school.edu' : `${t}@x.com`)),
  ccEmails: cc.map((t) => `${t}@x.com`),
  sentAt,
  bodyText: '',
  headers: {},
  isAutomated: false,
});

const input = (extra: Partial<TieInput>): TieInput => ({
  userId: 'u',
  people: ['ann', 'ben', 'cal', 'dee'].map((p) => person(p)),
  affiliations: [],
  organizations: new Map(),
  threads: [],
  events: [],
  now: NOW,
  ...extra,
});

const kinds = (ties: Tie[]) => ties.map((t) => `${t.aId}-${t.bId}:${t.kind}`).sort();

describe('inferTies (§4.1)', () => {
  it('splits a thread into exchange, cc and co-thread by who wrote', () => {
    const ties = inferTies(
      input({
        threads: [thread('t1', ['ann', 'ben', 'cal', 'dee'])],
        messages: [
          message('m1', 't1', 'ann', ['me'], ['ben']),
          message('m2', 't1', 'ben', ['me', 'ann']),
          message('m3', 't1', 'me', ['ann', 'ben', 'cal', 'dee']),
        ],
      }),
    );
    expect(kinds(ties)).toEqual(['ann-ben:email_cc', 'ann-ben:email_exchange', 'cal-dee:email_cothread']);
    const ex = ties.find((t) => t.kind === 'email_exchange')!;
    expect(ex).toMatchObject({ weight: 0.6, confidence: 0.95 });
    const cc = ties.find((t) => t.kind === 'email_cc')!;
    // ann copied ben, ben wrote to ann: two messages
    expect(cc.weight).toBeCloseTo(0.5, 10);
    expect(cc.confidence).toBe(0.85);
    expect(ties.find((t) => t.kind === 'email_cothread')).toMatchObject({ weight: 0.3, confidence: 0.5 });
  });

  it('grows with more threads, up to the caps', () => {
    const threads = Array.from({ length: 6 }, (_, i) => thread(`t${i}`, ['ann', 'ben']));
    const messages = threads.flatMap((t, i) => [
      message(`a${i}`, t.id, 'ann', ['me']),
      message(`b${i}`, t.id, 'ben', ['me']),
    ]);
    const ex = inferTies(input({ threads, messages })).find((t) => t.kind === 'email_exchange')!;
    expect(ex.weight).toBe(0.9);
    expect(ex.evidence.threads).toBe(6);
    const co = inferTies(input({ threads })).find((t) => t.kind === 'email_cothread')!;
    expect(co.weight).toBe(0.5);
  });

  it('skips big threads, big or cancelled meetings and attendees who declined', () => {
    const many = Array.from({ length: 9 }, (_, i) => `p${i}`);
    const ev = (id: string, ids: string[], extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
      id,
      userId: 'u',
      externalEventId: id,
      startAt: '2026-09-01T10:00:00Z',
      endAt: '2026-09-01T11:00:00Z',
      status: 'confirmed',
      attendees: ids.map((p) => ({ email: `${p}@x.com` })),
      attendeePersonIds: ids,
      ...extra,
    });
    const ties = inferTies(
      input({
        people: [...['ann', 'ben', 'cal'], ...many].map((p) => person(p)),
        threads: [thread('big', many)],
        events: [
          ev('e1', ['ann', 'ben', 'cal'], {
            attendees: [
              { email: 'ann@x.com' },
              { email: 'ben@x.com' },
              { email: 'cal@x.com', responseStatus: 'declined' },
            ],
          }),
          ev('e2', ['ann', 'ben']),
          ev('e3', many),
          ev('e4', ['ann', 'cal'], { status: 'cancelled' }),
        ],
      }),
    );
    expect(kinds(ties)).toEqual(['ann-ben:meeting_coattendee']);
    expect(ties[0]!.weight).toBeCloseTo(0.7, 10);
    expect(ties[0]!.confidence).toBe(0.8);
  });

  it('adds introductions, mutuals and Village paths', () => {
    const ties = inferTies(
      input({
        threads: [
          thread('t', ['ann', 'ben'], {
            introduction: {
              introducerId: 'ann',
              introducedIds: ['ben'],
              messageId: 'm',
              at: '2026-05-01T00:00:00Z',
            },
          }),
        ],
        mutuals: [{ aId: 'cal', bId: 'ann', seenAt: '2026-10-01T00:00:00Z' }],
        villagePaths: [{ introducerId: 'dee', targetId: 'ben', warmth: 0.6 }],
      }),
    );
    expect(ties.find((t) => t.kind === 'introduced_by')).toMatchObject({
      aId: 'ann',
      bId: 'ben',
      weight: 0.85,
      confidence: 0.95,
    });
    expect(ties.find((t) => t.kind === 'linkedin_mutual')).toMatchObject({
      aId: 'ann',
      bId: 'cal',
      weight: 0.3,
      confidence: 0.95,
    });
    expect(ties.find((t) => t.kind === 'village_path')).toMatchObject({
      aId: 'ben',
      bId: 'dee',
      weight: 0.6,
      confidence: 0.7,
    });
  });

  it('gives affiliation kinds a confidence from the overlap, the employer size and the age', () => {
    const aff = (
      pid: string,
      org: string,
      start: string,
      end?: string,
      kind: Affiliation['kind'] = 'employment',
    ): Affiliation => ({
      id: `${pid}-${org}`,
      userId: 'u',
      personId: pid,
      kind,
      nameRaw: org,
      startDate: start,
      endDate: end,
      isCurrent: !end,
      source: 'linkedin_csv',
    });
    const orgs = new Map<string, Organization>();
    const ties = inferTies(
      input({
        people: ['ann', 'ben', 'cal', 'dee', 'eve', 'fay'].map((p) => person(p)),
        affiliations: [
          aff('ann', 'Tiny Co', '2020-01-01', '2022-01-01'),
          aff('ben', 'Tiny Co', '2020-07-01', '2022-07-01'),
          aff('cal', 'Google', '2020-01-01', '2022-01-01'),
          aff('dee', 'Google', '2020-07-01', '2022-07-01'),
          aff('eve', 'Old Co', '2008-01-01', '2012-01-01'),
          aff('fay', 'Old Co', '2009-01-01', '2013-01-01'),
        ],
        organizations: orgs,
      }),
    );
    const c = (a: string) => ties.find((t) => t.aId === a && t.kind === 'co_tenure')!.confidence;
    // 18 months of overlap: 0.3 + 0.9, capped at 0.8
    expect(c('ann')).toBeCloseTo(0.8, 10);
    // Google: halved over 5,000 people and ×0.7 again over 10,000 (plan 21 §3.6)
    expect(c('cal')).toBeCloseTo(0.8 * 0.5 * 0.7, 10);
    expect(c('eve')).toBeCloseTo(0.8 * 0.6, 10);
  });

  it('keeps inferEdges working for existing callers', () => {
    const inp = input({ threads: [thread('t1', ['ann', 'ben'])] });
    const edges = inferEdges(inp);
    expect(edges.map((e) => e.type)).toEqual(['email_cothread']);
    expect(edges[0]!.weight).toBe(0.5);
  });
});

describe('combining ties', () => {
  const tie = (kind: Tie['kind'], weight: number, confidence: number, lastSeenAt?: string): Tie => ({
    id: kind,
    userId: 'u',
    aId: 'a',
    bId: 'b',
    kind,
    weight,
    confidence,
    evidence: {},
    lastSeenAt,
  });

  it('noisy-ORs w·c and c', () => {
    const p = combineTies([tie('email_exchange', 0.6, 0.95), tie('co_tenure', 0.5, 0.4)], NOW).get('a|b')!;
    expect(p.weight).toBeCloseTo(1 - (1 - 0.57) * (1 - 0.2), 10);
    expect(p.confidence).toBeCloseTo(1 - 0.05 * 0.6, 10);
    expect(p.kinds).toEqual(['email_exchange', 'co_tenure']);
  });

  it('decays interaction kinds by half every two years', () => {
    const old = tie('email_exchange', 0.8, 0.95, '2024-10-14T12:00:00Z');
    expect(decayedTieWeight(old, NOW)).toBeCloseTo(0.4, 2);
    expect(decayedTieWeight(tie('co_tenure', 0.8, 0.5, '2010-01-01T00:00:00Z'), NOW)).toBe(0.8);
  });

  it('routes only confident pairs or real interactions', () => {
    expect(isRoutable({ confidence: 0.3, kinds: ['same_school_cohort'] })).toBe(false);
    expect(isRoutable({ confidence: 0.55, kinds: ['co_tenure', 'same_school_cohort'] })).toBe(true);
    expect(isRoutable({ confidence: 0.2, kinds: ['linkedin_mutual'] })).toBe(true);
    expect(isRoutable({ confidence: 0.5, kinds: ['email_cothread'] })).toBe(true);
    expect(isRoutable({ confidence: 0.45, kinds: ['email_cc'] })).toBe(true);
  });

  it('turns ties into edges whose noisy-OR is w_pair, and reads them back', () => {
    const ties = [tie('email_exchange', 0.6, 0.95, '2026-09-01T00:00:00Z'), tie('co_tenure', 0.5, 0.4)];
    const edges = tiesToEdges(ties, NOW);
    expect(edges[0]).toMatchObject({ type: 'email_exchange', confidence: 0.95, kinds: ['email_exchange'] });
    const w = combinedPairWeights(edges).get('a|b')!.weight;
    expect(w).toBeCloseTo(combineTies(ties, NOW).get('a|b')!.weight, 10);
    const back = pairsFromEdges(edges).get('a|b')!;
    expect(back.weight).toBeCloseTo(w, 10);
    expect(back.confidence).toBeCloseTo(1 - 0.05 * 0.6, 10);
    // a v1 edge (no confidence) takes its confidence from its evidence, as the server does: no overlap known is 0.3,
    // 12 months at a 30-person company between peers is (0.3 + 0.6) capped 0.8, ×1.3 small, ×1.15 peers, capped 0.9
    const v1 = pairsFromEdges([{ ...edges[1]!, confidence: undefined, kinds: undefined, weight: 0.5 }]).get(
      'a|b',
    )!;
    expect(v1.weight).toBeCloseTo(0.5 * 0.3, 10);
    const sharp = pairsFromEdges([
      {
        ...edges[1]!,
        confidence: undefined,
        kinds: undefined,
        weight: 0.5,
        evidence: { overlapMonths: 12, sizeBucket: '11-50', peers: 'same' },
      },
    ]).get('a|b')!;
    expect(sharp.confidence).toBeCloseTo(0.9, 10);
    expect(TIE_CONFIDENCE.co_tenure).toBe(0.5);
  });

  it('describes the new kinds in hop texts', () => {
    const a = person('ann');
    const b = person('ben');
    const text = (type: Tie['kind'], evidence = {}) =>
      describePairHop(a, b, [
        { id: 'e', userId: 'u', personAId: 'ann', personBId: 'ben', type, weight: 0.5, evidence },
      ]);
    expect(text('email_exchange', { threads: 2, lastAt: '2026-09-01T00:00:00Z' })).toBe(
      'Ann and Ben both wrote on 2 email threads with you (last in Sep 2026)',
    );
    expect(text('email_cc')).toBe('Ann and Ben were on the same email to you');
    expect(text('linkedin_mutual')).toBe('Ann and Ben are connected on LinkedIn');
    expect(text('village_path')).toBe('Ann knows Ben (via Village)');
  });
});
