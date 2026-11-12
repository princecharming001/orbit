import { describe, expect, it } from 'vitest';
import { hopEvidence, type RoutePerson, rankWarmPaths, type WarmPathInput } from '../graph/route';
import { combineTies, isRoutable, pKnowDirected, socialFollowWeight, type Tie } from '../graph/ties';
import {
  chatDays,
  chatGroupWeight,
  computeTieFeatures,
  localDay,
  scoreTie,
  type TieHistory,
  type TieMessage,
  tieStrength,
} from '../scoring/tieScore';
import {
  excludedBy,
  keepProvider,
  keepTie,
  keepTouch,
  parseExtraSources,
  sourceOfIdentity,
  sourceOfProvider,
  sourceOfTie,
  sourceOfTouch,
  sourcesInUse,
} from '../sources';
import type { Person, Touchpoint } from '../types';

const NOW = new Date('2026-11-12T12:00:00Z');
const daysAgo = (d: number, h = 12) =>
  new Date(NOW.getTime() - d * 86_400_000 + (h - 12) * 3_600_000).toISOString();

const history = (messages: TieMessage[], extra: Partial<TieHistory> = {}): TieHistory => ({
  name: 'Maya',
  messages,
  meetings: [],
  intros: 0,
  shared: { sameSchool: false, overlappingEmployer: false, sameCity: false },
  linkedinConnected: false,
  noteWarmth: [],
  mutualScores: [],
  ...extra,
});

const msg = (
  at: string,
  direction: 'in' | 'out',
  channel: TieMessage['channel'],
  extra: Partial<TieMessage> = {},
): TieMessage => ({
  at,
  direction,
  channel,
  threadId: `${channel}:1`,
  threadParticipants: 2,
  automated: false,
  ...extra,
});

describe('optional sources (plan 43 §3.1)', () => {
  it("reads the owner's list, ignoring unknown names, and accepts 'texts' for iMessage", () => {
    expect(parseExtraSources(undefined)).toEqual([]);
    expect(parseExtraSources('')).toEqual([]);
    expect(parseExtraSources('instagram, texts,bogus,instagram')).toEqual(['instagram', 'imessage']);
    expect(parseExtraSources('X IMESSAGE')).toEqual(['x', 'imessage']);
  });

  it('counts a source only when the owner offers it and the student has it on', () => {
    expect([...sourcesInUse(['instagram', 'x'], { instagram: 'on', x: 'off', imessage: 'on' })]).toEqual([
      'instagram',
    ]);
    expect(sourcesInUse([], { instagram: 'on' }).size).toBe(0);
    expect(sourcesInUse(['instagram'], undefined).size).toBe(0);
    for (const state of ['not_connected', 'off', 'removed'] as const)
      expect(sourcesInUse(['instagram'], { instagram: state }).size).toBe(0);
  });

  it('maps every row kind to its source, and leaves the always-on kinds alone', () => {
    expect(sourceOfTouch('instagram_in')).toBe('instagram');
    expect(sourceOfTouch('x_out')).toBe('x');
    expect(sourceOfTouch('text_in')).toBe('imessage');
    expect(sourceOfTouch('email_in')).toBeUndefined();
    expect(sourceOfTie('instagram_follow')).toBe('instagram');
    expect(sourceOfTie('linkedin_mutual')).toBeUndefined();
    expect(sourceOfProvider('x')).toBe('x');
    expect(sourceOfProvider('gmail')).toBeUndefined();
    expect(sourceOfIdentity('instagram_id')).toBe('instagram');
    expect(sourceOfIdentity('email')).toBeUndefined();
  });

  it('keeps always-on rows whatever is in use, and an optional source only while in use', () => {
    const none = new Set<never>();
    expect(keepTouch('email_in', none)).toBe(true);
    expect(keepTouch('text_in', none)).toBe(false);
    expect(keepTouch('text_in', new Set(['imessage'] as const))).toBe(true);
    expect(keepTie('x_mutual', new Set(['instagram'] as const))).toBe(false);
    expect(keepTie('student_says_close', none)).toBe(true);
    expect(keepProvider('linkedin', none)).toBe(true);
    expect(keepProvider('instagram', none)).toBe(false);
  });

  it('lists exactly what to leave out, and nothing when every source is in use', () => {
    const all = excludedBy(new Set(['instagram', 'x', 'imessage'] as const));
    expect(all).toEqual({ touchKinds: [], tieKinds: [], providers: [], identityKinds: [] });
    const onlyIg = excludedBy(new Set(['instagram'] as const));
    expect(onlyIg.providers).toEqual(['x']);
    expect(onlyIg.touchKinds.sort()).toEqual(['text_in', 'text_out', 'x_in', 'x_out']);
    expect(onlyIg.tieKinds.sort()).toEqual(['x_follow', 'x_mutual']);
    expect(onlyIg.identityKinds).toEqual(['x_id']);
  });
});

describe('chat closeness rules (plan 43 §3.8)', () => {
  it('weighs a chat by its size: two fully, three or four half, five to eight a quarter, more nothing', () => {
    expect([2, 3, 4, 5, 8, 9, 40].map(chatGroupWeight)).toEqual([1, 0.5, 0.5, 0.25, 0.25, 0, 0]);
  });

  it("counts days in the student's time zone, not UTC", () => {
    // 9pm and 11pm in New York on the 11th are the 12th in UTC for the second one
    expect(localDay('2026-11-12T02:00:00Z', 'America/New_York')).toBe('2026-11-11');
    expect(localDay('2026-11-12T04:00:00Z', 'America/New_York')).toBe('2026-11-11');
    expect(localDay('2026-11-12T04:00:00Z')).toBe('2026-11-12');
    expect(localDay('2026-11-12T04:00:00Z', 'Not/AZone')).toBe('2026-11-12');
  });

  it('turns fifty messages in one evening into one day each way', () => {
    const evening = Array.from({ length: 50 }, (_, i) =>
      msg(new Date(NOW.getTime() - 3_600_000 + i * 60_000).toISOString(), i % 2 ? 'in' : 'out', 'instagram'),
    );
    const { messages } = chatDays(history(evening, { timeZone: 'UTC' }));
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.direction).sort()).toEqual(['in', 'out']);
  });

  it('never reads reply speed from a chat, which was fitted on email', () => {
    const { messages } = chatDays(
      history([msg(daysAgo(1), 'out', 'x'), msg(daysAgo(1, 13), 'in', 'x', { isReplyLatencyHours: 0.01 })]),
    );
    expect(messages.every((m) => m.isReplyLatencyHours === undefined)).toBe(true);
    const fast = scoreTie(
      history([
        msg(daysAgo(1), 'out', 'instagram'),
        msg(daysAgo(1, 13), 'in', 'instagram', { isReplyLatencyHours: 0.02 }),
      ]),
      NOW,
    );
    expect(fast.features.latency).toBe(0);
  });

  it('gives no tie for messages from someone the student never answered', () => {
    const requests = history([msg(daysAgo(3), 'in', 'instagram'), msg(daysAgo(2), 'in', 'instagram')]);
    const { messages } = chatDays(requests);
    expect(messages).toHaveLength(0);
    const { features, facts } = computeTieFeatures(requests, NOW);
    expect(facts.never).toBe(true);
    expect(features.log_in).toBe(0);
    // once the student writes back on any channel, those days count
    const answered = history([...requests.messages, msg(daysAgo(1), 'out', 'email', { threadId: 'e1' })]);
    expect(chatDays(answered).messages.filter((m) => m.direction === 'in')).toHaveLength(2);
  });

  it('counts a day with no words as light engagement, not a conversation', () => {
    const h = history([
      msg(daysAgo(5), 'out', 'instagram'),
      msg(daysAgo(2), 'in', 'instagram', { words: false }),
    ]);
    const { messages, light } = chatDays(h);
    expect(messages.filter((m) => m.direction === 'in')).toHaveLength(0);
    expect(light).toHaveLength(1);
    expect(computeTieFeatures(h, NOW).features.engagement).toBeGreaterThan(0);
  });

  it('weighs a group chat down, and drops one bigger than eight', () => {
    const one = computeTieFeatures(
      history([msg(daysAgo(3), 'out', 'instagram'), msg(daysAgo(3, 14), 'in', 'instagram')]),
      NOW,
    ).features;
    const group = computeTieFeatures(
      history([
        msg(daysAgo(3), 'out', 'instagram', { threadParticipants: 6 }),
        msg(daysAgo(3, 14), 'in', 'instagram', { threadParticipants: 6 }),
      ]),
      NOW,
    ).features;
    const crowd = computeTieFeatures(
      history([
        msg(daysAgo(3), 'out', 'instagram', { threadParticipants: 12 }),
        msg(daysAgo(3, 14), 'in', 'instagram', { threadParticipants: 12 }),
      ]),
      NOW,
    );
    expect(group.log_in).toBeLessThan(one.log_in);
    expect(group.log_in).toBeGreaterThan(0);
    expect(crowd.facts.never).toBe(true);
  });

  it('leaves email and LinkedIn messages exactly as they were', () => {
    const mail = [
      msg(daysAgo(10), 'out', 'email', { threadId: 'e1' }),
      msg(daysAgo(10, 15), 'in', 'email', { threadId: 'e1', isReplyLatencyHours: 3 }),
      msg(daysAgo(9), 'in', 'email', { threadId: 'e1' }),
      msg(daysAgo(4), 'out', 'linkedin', { threadId: 'l1' }),
    ];
    const { messages, light } = chatDays(history(mail));
    expect(light).toEqual([]);
    expect(messages.map(({ weight, ...m }) => m)).toEqual(mail);
    expect(messages.every((m) => m.weight === 1)).toBe(true);
  });

  it('makes a tie exist when two people follow each other, without changing anyone else', () => {
    const person = { id: 'p', firstName: 'Maya', emails: [] } as unknown as Person;
    const touchpoints: Touchpoint[] = [];
    expect(tieStrength({ person, touchpoints }, NOW).strength).toBe(0);
    const follows = tieStrength({ person, touchpoints, follows: { instagram: true } }, NOW);
    expect(follows.strength).toBeGreaterThan(0);
    expect(follows.tie.explanation.join(' ')).toContain('You follow each other on Instagram');
    expect(follows.tie.explanation.join(' ')).not.toContain("haven't talked");
  });

  it('reads Instagram and X touch days as chat days with their group size and words', () => {
    const person = { id: 'p', firstName: 'Maya', emails: [] } as unknown as Person;
    const tp = (kind: Touchpoint['kind'], at: string, extra: Partial<Touchpoint> = {}): Touchpoint => ({
      id: `${kind}${at}`,
      userId: 'u',
      personId: 'p',
      kind,
      occurredAt: at,
      refTable: 'instagram_dm',
      refId: `${kind}${at}`,
      weight: 0.6,
      ...extra,
    });
    const s = tieStrength(
      {
        person,
        touchpoints: [
          tp('instagram_out', daysAgo(6)),
          tp('instagram_in', daysAgo(6, 14)),
          tp('x_in', daysAgo(2), { group: 6 }),
        ],
      },
      NOW,
    );
    expect(s.tie.facts.inCount).toBe(2);
    expect(s.tie.facts.outCount).toBe(1);
    expect(s.strength).toBeGreaterThan(0);
  });
});

describe('Instagram and X follows in paths (plan 43 §3.7)', () => {
  const tie = (a: string, b: string, kind: Tie['kind'], weight: number, evidence = {}): Tie => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return { id: `${x}|${y}|${kind}`, userId: 'u', aId: x, bId: y, kind, weight, confidence: 0.9, evidence };
  };
  const rp = (id: string, score: number): RoutePerson => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    score,
  });
  const input = (people: RoutePerson[], ties: Tie[], extra: Partial<WarmPathInput> = {}): WarmPathInput => ({
    targetId: 't',
    people: new Map(people.map((p) => [p.id, p])),
    pairs: combineTies(ties, NOW),
    now: NOW,
    ...extra,
  });

  it('weighs a follow back by how selective the busier follower is', () => {
    expect(socialFollowWeight()).toBe(0.3);
    expect(socialFollowWeight(150, 200)).toBe(0.3);
    expect(socialFollowWeight(150, 1200)).toBeCloseTo(0.15, 5);
    expect(socialFollowWeight(10, 1_000_000)).toBe(0.08);
  });

  it('routes through people who follow each other, and never through a one-way follow alone', () => {
    const mutual = combineTies([tie('maya', 't', 'instagram_mutual', 0.3)], NOW);
    expect(isRoutable(mutual.get('maya|t')!)).toBe(true);
    const fan = combineTies([tie('maya', 't', 'instagram_follow', 0.1, { followerId: 'maya' })], NOW);
    expect(isRoutable(fan.get('maya|t')!)).toBe(false);
    const r = rankWarmPaths(
      input([rp('maya', 0), rp('t', 0)], [tie('maya', 't', 'x_follow', 0.1, { followerId: 't' })]),
    );
    expect(r.paths).toEqual([]);
  });

  it('counts a one-way follow only toward the hop whose second person follows', () => {
    const pair = combineTies(
      [
        tie('maya', 't', 'instagram_mutual', 0.3),
        tie('maya', 't', 'instagram_follow', 0.2, { followerId: 't' }),
      ],
      NOW,
    ).get('maya|t')!;
    const toTarget = pKnowDirected(pair, 'maya', 't');
    const toMaya = pKnowDirected(pair, 't', 'maya');
    expect(toTarget).toBeGreaterThan(toMaya);
  });

  it('lifts a bridge with no score of its own, like a LinkedIn mutual, and marks the route weaker', () => {
    const r = rankWarmPaths(
      input([rp('maya', 0), rp('t', 0)], [], {
        candidates: [{ introducerId: 'maya', kind: 'instagram_mutual', warmth: 0.3 }],
      }),
    );
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.firstHopId).toBe('maya');
    expect(r.paths[0]!.weak).toBe(true);
  });

  it('makes one stronger bridge of the same person connected on LinkedIn and following back on Instagram', () => {
    const li = rankWarmPaths(input([rp('maya', 30), rp('t', 0)], [tie('maya', 't', 'linkedin_mutual', 0.3)]));
    const both = rankWarmPaths(
      input(
        [rp('maya', 30), rp('t', 0)],
        [tie('maya', 't', 'linkedin_mutual', 0.3), tie('maya', 't', 'instagram_mutual', 0.3)],
      ),
    );
    expect(both.paths[0]!.p).toBeGreaterThan(li.paths[0]!.p);
  });

  it('names the platform in the words', () => {
    const t = (kind: Tie['kind'], ev = {}) => tie('maya', 'priya', kind, 0.3, ev);
    expect(hopEvidence('maya', t('instagram_mutual'), 'Priya')).toBe(
      'follows Priya on Instagram and they follow back',
    );
    expect(hopEvidence('maya', t('x_mutual'), 'Priya')).toBe('follows Priya on X and they follow back');
    expect(hopEvidence('maya', t('instagram_follow', { followerId: 'maya' }), 'Priya')).toBe(
      'follows Priya on Instagram',
    );
    expect(hopEvidence('maya', t('x_follow', { followerId: 'priya' }), 'Priya')).toBe(
      'is followed by Priya on X',
    );
  });
});
