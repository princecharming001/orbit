import { describe, expect, it } from 'vitest';
import { buildDemoDataset } from '../demo/seed';
import { personalizedPageRank } from '../graph/ppr';
import {
  firstHopFloor,
  hopEvidence,
  MIN_PATH_P,
  MUTUAL_MIN_SCORE,
  pAsk,
  pathBand,
  pKnow,
  type RoutePerson,
  rankCompanyTargets,
  rankWarmPaths,
  targetReceptivity,
  USER_NODE,
  type WarmPathInput,
} from '../graph/route';
import { combineTies, inferTies, type Tie, type TiePair } from '../graph/ties';
import type { EmailMessage, EmailThread } from '../types';

const NOW = new Date('2026-10-14T12:00:00Z');

const rp = (id: string, score: number, extra: Partial<RoutePerson> = {}): RoutePerson => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  score,
  ...extra,
});

const tie = (
  a: string,
  b: string,
  kind: Tie['kind'],
  weight: number,
  confidence: number,
  evidence = {},
  lastSeenAt?: string,
): Tie => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return {
    id: `${x}|${y}|${kind}`,
    userId: 'u',
    aId: x,
    bId: y,
    kind,
    weight,
    confidence,
    evidence,
    lastSeenAt,
  };
};

const input = (people: RoutePerson[], ties: Tie[], extra: Partial<WarmPathInput> = {}): WarmPathInput => ({
  targetId: 't',
  people: new Map(people.map((p) => [p.id, p])),
  pairs: combineTies(ties, NOW),
  now: NOW,
  ...extra,
});

describe('§4.2 acceptance', () => {
  it('1: on the demo graph, a mutual who wrote on a thread with Priya Ahmed beats a same-company-only colleague', () => {
    const d = buildDemoDataset({ now: NOW });
    const priya = d.people.find((p) => p.displayName === 'Priya Ahmed')!;
    const hannah = d.people.find((p) => p.displayName === 'Hannah Brooks')!;
    const daniel = d.people.find((p) => p.displayName === 'Daniel Okafor')!;
    // Hannah and Priya both wrote on a thread the student is on
    const t: EmailThread = {
      id: 'thread-hp',
      userId: d.user.id,
      externalThreadId: 'thread-hp',
      messageCount: 2,
      participantEmails: [hannah.primaryEmail!, priya.primaryEmail!],
      participantPersonIds: [hannah.id, priya.id],
      isNetworking: true,
      lastMessageAt: '2026-09-20T15:00:00Z',
    };
    const m = (id: string, from: typeof priya, to: string[]): EmailMessage => ({
      id,
      userId: d.user.id,
      threadId: t.id,
      externalMessageId: id,
      direction: 'inbound',
      fromEmail: from.primaryEmail!,
      fromPersonId: from.id,
      toEmails: to,
      ccEmails: [],
      sentAt: '2026-09-20T15:00:00Z',
      bodyText: '',
      headers: {},
      isAutomated: false,
    });
    const ties = inferTies({
      userId: d.user.id,
      people: d.people,
      affiliations: d.affiliations,
      organizations: new Map(d.organizations.map((o) => [o.id, o])),
      threads: [...d.threads, t],
      events: d.events,
      messages: [
        ...d.messages,
        m('mh', hannah, [d.user.email]),
        m('mp', priya, [d.user.email, hannah.primaryEmail!]),
      ],
      now: NOW,
    });
    const pairs = combineTies(ties, NOW);
    const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    expect(pairs.get(key(hannah.id, priya.id))!.kinds).toContain('email_exchange');
    expect(pairs.get(key(daniel.id, priya.id))!.kinds).toEqual(['co_tenure']);
    const people = new Map(
      d.people.map((p) => [
        p.id,
        rp(p.id, p.id === hannah.id || p.id === daniel.id ? 60 : 0, { name: p.firstName }),
      ]),
    );
    const r = rankWarmPaths({ targetId: priya.id, target: { name: 'Priya' }, people, pairs, now: NOW });
    expect(r.paths[0]!.firstHopId).toBe(hannah.id);
    expect(r.paths[0]!.reasonText).toMatch(/^Hannah \(Strong · 60\) emails with Priya\./);
    const viaDaniel = r.paths.findIndex((p) => p.firstHopId === daniel.id);
    expect(viaDaniel === -1 || viaDaniel > 0).toBe(true);
  });

  it('1b: where a company-only pair is routable, it still ranks below a two-way thread', () => {
    const r = rankWarmPaths(
      input(
        [rp('mia', 60), rp('sam', 60), rp('t', 0)],
        [
          tie('mia', 't', 'email_exchange', 0.6, 0.95, {}, '2026-10-14T12:00:00Z'),
          tie('sam', 't', 'co_tenure', 0.7, 0.8, { orgName: 'Tiny Co', fromYear: 2024, ongoing: true }),
        ],
      ),
    );
    expect(r.paths.map((p) => p.firstHopId)).toEqual(['mia', 'sam']);
    expect(r.paths[1]!.reasonText).toBe(
      'Sam (Strong · 60) worked with T at Tiny Co (since 2024). 1 other way in.',
    );
  });

  it('2: p_ask is monotonic in the score and lower after a recent ask', () => {
    let prev = -1;
    for (let s = 0; s <= 100; s += 5) {
      const p = pAsk({ score: s, reciprocity: 0.5 });
      expect(p).toBeGreaterThan(prev);
      prev = p;
      expect(pAsk({ score: s, reciprocity: 0.5, askedRecently: true })).toBeLessThan(p);
    }
    expect(pAsk({ score: 50 })).toBeCloseTo(0.5, 10);
    expect(pAsk({ score: 50, introducedUserBefore: true })).toBeGreaterThan(pAsk({ score: 50 }));
    expect(pAsk({ score: 50, owesReply: true })).toBeLessThan(pAsk({ score: 50 }));
  });

  it('3: PPR on a star graph returns the hub first and its mass sums to 1', () => {
    const adj = new Map<string, Map<string, number>>([
      ['user', new Map([['hub', 1]])],
      ['hub', new Map(['a', 'b', 'c', 'd', 'e'].map((x) => [x, 1]))],
      ...['a', 'b', 'c', 'd', 'e'].map((x) => [x, new Map([['hub', 1]])] as [string, Map<string, number>]),
    ]);
    const mass = personalizedPageRank(adj, 'user');
    const ranked = [...mass].filter(([n]) => n !== 'user').sort((x, y) => y[1] - x[1]);
    expect(ranked[0]![0]).toBe('hub');
    expect([...mass.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    // dangling mass restarts at the source
    const dangling = personalizedPageRank(new Map([['user', new Map([['x', 1]])]]), 'user');
    expect(dangling.get('user')! + dangling.get('x')!).toBeCloseTo(1, 9);
  });
});

describe('hop probabilities', () => {
  it('p_know is the confidence-weighted pair weight', () => {
    const pairs = combineTies([tie('a', 'b', 'linkedin_mutual', 0.3, 0.95)], NOW);
    expect(pKnow(pairs.get('a|b')!)).toBeCloseTo(0.285, 10);
  });

  it('target receptivity follows school and seniority, within [0.7, 1.3]', () => {
    expect(targetReceptivity({})).toBe(1);
    expect(targetReceptivity({ isAlum: true, title: 'Product Manager' })).toBeCloseTo(1.25, 10);
    expect(targetReceptivity({ title: 'CEO' })).toBeCloseTo(0.85, 10);
    expect(targetReceptivity({ title: 'General Partner' })).toBeCloseTo(0.85, 10);
    expect(targetReceptivity({ title: 'VP Engineering' })).toBe(1);
  });

  it('goal floors and bands', () => {
    expect(firstHopFloor('fundraising')).toBe(40);
    expect(firstHopFloor('recruiting')).toBe(20);
    expect(firstHopFloor('advice')).toBe(20);
    expect(firstHopFloor('sales')).toBe(0);
    expect([0.5, 0.35, 0.2, 0.15, 0.1].map(pathBand)).toEqual(['high', 'high', 'medium', 'medium', 'low']);
  });
});

describe('rankWarmPaths', () => {
  const ex = (a: string, b: string) => tie(a, b, 'email_exchange', 0.8, 0.95, {}, '2026-10-14T12:00:00Z');

  it('computes P = p_ask · Π p_know · r_T · 0.85^(hops − 2)', () => {
    const r = rankWarmPaths(input([rp('a', 70), rp('b', 0), rp('t', 0)], [ex('a', 'b'), ex('b', 't')]));
    const p = r.paths[0]!;
    expect(p.nodes).toEqual([USER_NODE, 'a', 'b', 't']);
    expect(p.p).toBeCloseTo(pAsk({ score: 70 }) * 0.76 * 0.76 * 0.85, 10);
    expect(p.reasonText).toBe('A (Strong · 70) emails with B, who emails with T.');
    expect(p.hops.map((h) => h.kind)).toEqual(['strength', 'email_exchange', 'email_exchange']);
  });

  it('applies the goal floor, and skips hidden people and recent decliners', () => {
    const ties = [ex('a', 't'), ex('b', 't'), ex('c', 't'), ex('d', 't')];
    const people = [
      rp('a', 30),
      rp('b', 80, { hidden: true }),
      rp('c', 80, { declinedIntroAt: '2026-09-01T00:00:00Z' }),
      rp('d', 80, { declinedIntroAt: '2026-01-01T00:00:00Z' }),
      rp('t', 0),
    ];
    expect(rankWarmPaths(input(people, ties)).paths.map((p) => p.firstHopId)).toEqual(['d', 'a']);
    expect(
      rankWarmPaths(input(people, ties, { goal: 'fundraising' })).paths.map((p) => p.firstHopId),
    ).toEqual(['d']);
  });

  it('keeps the best route per first hop and at most two routes through one middle person', () => {
    const ties = [ex('a', 'm'), ex('b', 'm'), ex('c', 'm'), ex('m', 't'), ex('a', 'n'), ex('n', 't')];
    const r = rankWarmPaths(
      input([rp('a', 90), rp('b', 85), rp('c', 80), rp('m', 0), rp('n', 0), rp('t', 0)], ties),
    );
    expect(r.paths.map((p) => p.nodes.join('>'))).toEqual(['user>a>m>t', 'user>b>m>t']);
    expect(r.paths[0]!.otherWays).toBe(2);
    expect(r.paths[0]!.reasonText.endsWith(' 2 other ways in.')).toBe(true);
  });

  it('returns at most five routes', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const r = rankWarmPaths(
      input(
        [...ids.map((x, i) => rp(x, 90 - i)), rp('t', 0)],
        ids.map((x) => ex(x, 't')),
      ),
    );
    expect(r.paths).toHaveLength(5);
    expect(r.paths[0]!.p).toBeGreaterThanOrEqual(r.paths[4]!.p);
  });

  it('does not route to someone the student knows, and falls back to cold without a decent route', () => {
    const known = rankWarmPaths(
      input([rp('a', 80), rp('t', 72)], [ex('a', 't')], { target: { name: 'Priya' } }),
    );
    expect(known).toEqual({
      paths: [],
      direct: { score: 72, band: 'Strong', text: 'You know Priya (Strong · 72)' },
    });
    const cold = rankWarmPaths(input([rp('a', 5), rp('t', 0)], [tie('a', 't', 'email_cothread', 0.3, 0.5)]));
    expect(cold).toEqual({ paths: [], fallback: 'cold' });
  });

  it('offers a faint direct tie at the chance they answer', () => {
    const r = rankWarmPaths(
      input([rp('a', 20), rp('t', 15)], [ex('a', 't')], { target: { name: 'Tia', pReply: 0.4 } }),
    );
    expect(r.paths[0]!.nodes).toEqual([USER_NODE, 't']);
    expect(r.paths[0]!.p).toBe(0.4);
    expect(r.paths[0]!.reasonText).toBe('Write to Tia directly (Faint · 15). 1 other way in.');
  });

  it('merges LinkedIn mutuals and Village introducers as routes', () => {
    const r = rankWarmPaths(
      input([rp('a', 70), rp('v', 70), rp('t', 0)], [], {
        candidates: [
          { introducerId: 'a', kind: 'linkedin_mutual' },
          { introducerId: 'v', kind: 'village_path', warmth: 0.8 },
        ],
      }),
    );
    expect(r.paths.map((p) => p.firstHopId)).toEqual(['v', 'a']);
    expect(r.paths[0]!.p).toBeCloseTo(pAsk({ score: 70 }) * 0.56, 10);
    expect(r.paths[0]!.reasonText).toMatch(/^V \(Strong · 70\) knows T \(via Village\)\./);
    expect(r.paths[1]!.reasonText).toMatch(
      /^Through A, a strong tie \(70\): A is connected to T on LinkedIn\./,
    );
  });

  describe('LinkedIn mutuals are never dropped', () => {
    const mutual = (id: string) => ({ introducerId: id, kind: 'linkedin_mutual' as const });

    it('keeps a LinkedIn-only mutual under MIN_PATH_P, as a weaker route, explained by the tie to the mutual', () => {
      // a bare LinkedIn connection (12) asking about a C-level target: 0.18 · 0.285 · 0.85 < 0.05
      const r = rankWarmPaths(
        input([rp('mia', 12), rp('t', 0)], [], {
          candidates: [mutual('mia')],
          target: { name: 'Kenji', title: 'CEO' },
        }),
      );
      expect(r.fallback).toBeUndefined();
      const p = r.paths[0]!;
      expect(p.nodes).toEqual([USER_NODE, 'mia', 't']);
      expect(p.p).toBeLessThanOrEqual(MIN_PATH_P);
      expect(p.weak).toBe(true);
      expect(p.band).toBe('low');
      expect(p.hops.map((h) => h.kind)).toEqual(['strength', 'linkedin_mutual']);
      expect(p.reasonText).toBe(
        'Through Mia, a faint tie (12): Mia is connected to Kenji on LinkedIn. A weaker route, but a real connection.',
      );
    });

    it('lifts a mutual Orbit has no score for to a LinkedIn connection, and skips the goal floor for that hop only', () => {
      const ex2 = (a: string, b: string) =>
        tie(a, b, 'email_exchange', 0.9, 0.95, {}, '2026-10-01T00:00:00Z');
      const r = rankWarmPaths(
        input([rp('mia', 0), rp('b', 0), rp('t', 0)], [ex2('mia', 'b'), ex2('b', 't')], {
          candidates: [mutual('mia')],
          goal: 'recruiting',
        }),
      );
      // Mia is asked about the person she is a mutual of, not routed further (under the floor, she would not be)
      expect(r.paths.map((p) => p.nodes.join('>'))).toEqual(['user>mia>t']);
      expect(r.paths[0]!.hops[0]!.p).toBeCloseTo(pAsk({ score: MUTUAL_MIN_SCORE }), 10);
      expect(r.paths[0]!.weak).toBe(true);
    });

    it('ranks mutual routes by the student’s tie to each mutual, and keeps every one', () => {
      const r = rankWarmPaths(
        input([rp('ana', 12), rp('bo', 55), rp('cy', 30), rp('t', 0)], [], {
          candidates: [mutual('ana'), mutual('bo'), mutual('cy')],
        }),
      );
      expect(r.paths.map((p) => p.firstHopId)).toEqual(['bo', 'cy', 'ana']);
      expect(r.paths[0]!.reasonText).toMatch(
        /^Through Bo, a warm tie \(55\): Bo is connected to T on LinkedIn\./,
      );
      expect(r.paths[0]!.reasonText).toMatch(/ 2 other ways in\.$/);
      expect(r.paths[0]!.weak).toBeUndefined();
    });

    it('treats a stored linkedin_mutual tie (the server’s) like a candidate', () => {
      const r = rankWarmPaths(
        input([rp('mia', 12), rp('t', 0)], [tie('mia', 't', 'linkedin_mutual', 0.3, 0.95)], {
          goal: 'fundraising',
        }),
      );
      expect(r.paths.map((p) => p.nodes.join('>'))).toEqual(['user>mia>t']);
      expect(r.paths[0]!.weak).toBe(true);
    });

    it('adds a mutual route that Yen’s k shortest paths never reached', () => {
      const strong = ['a', 'b', 'c'];
      const r = rankWarmPaths(
        input(
          [...strong.map((x) => rp(x, 90)), rp('mia', 12), rp('t', 0)],
          strong.map((x) => tie(x, 't', 'email_exchange', 0.9, 0.95, {}, '2026-10-01T00:00:00Z')),
          { candidates: [mutual('mia')], k: 2 },
        ),
      );
      expect(r.paths.map((p) => p.firstHopId)).toContain('mia');
    });

    it('says when a mutual also has other evidence with the target', () => {
      const r = rankWarmPaths(
        input(
          [rp('mia', 45), rp('t', 0)],
          [tie('mia', 't', 'same_current_company', 0.5, 0.9, { orgName: 'Figma' })],
          { candidates: [mutual('mia')] },
        ),
      );
      expect(r.paths[0]!.reasonText).toBe(
        'Through Mia, a warm tie (45): Mia works with T at Figma (and is connected to them on LinkedIn).',
      );
    });

    it('still skips a hidden mutual or one who declined an intro lately', () => {
      const r = rankWarmPaths(
        input(
          [
            rp('h', 50, { hidden: true }),
            rp('d', 50, { declinedIntroAt: '2026-10-01T00:00:00Z' }),
            rp('t', 0),
          ],
          [],
          { candidates: [mutual('h'), mutual('d')] },
        ),
      );
      expect(r).toEqual({ paths: [], fallback: 'cold' });
    });
  });

  it('discounts routes whose evidence is more than three years old', () => {
    const fresh = rankWarmPaths(input([rp('a', 70), rp('t', 0)], [ex('a', 't')])).paths[0]!.p;
    const stale = rankWarmPaths(
      input([rp('a', 70, { lastContactAt: '2022-01-01T00:00:00Z' }), rp('t', 0)], [ex('a', 't')]),
    ).paths[0]!.p;
    expect(stale).toBeCloseTo(fresh * 0.7, 10);
  });

  it('scales the last hop by the target receptivity', () => {
    const base = rankWarmPaths(input([rp('a', 70), rp('t', 0)], [ex('a', 't')])).paths[0]!.p;
    const ceo = rankWarmPaths(input([rp('a', 70), rp('t', 0)], [ex('a', 't')], { target: { title: 'CEO' } }))
      .paths[0]!.p;
    expect(ceo).toBeCloseTo(base * 0.85, 10);
  });
});

describe('hopEvidence', () => {
  const t = (kind: Tie['kind'], evidence = {}, lastSeenAt?: string) =>
    tie('a', 'b', kind, 0.5, 0.5, evidence, lastSeenAt);
  it('phrases the strongest kind on a hop', () => {
    expect(hopEvidence('a', t('meeting_coattendee', { lastAt: '2026-03-05T00:00:00Z' }), 'Bo')).toBe(
      'met Bo (Mar 2026)',
    );
    expect(hopEvidence('a', t('co_tenure', { orgName: 'Stripe', fromYear: 2021, toYear: 2023 }), 'Bo')).toBe(
      'worked with Bo at Stripe (2021–2023)',
    );
    expect(hopEvidence('a', t('introduced_by', { introducerId: 'a' }), 'Bo')).toBe('introduced you to Bo');
    expect(hopEvidence('b', t('introduced_by', { introducerId: 'a' }), 'Al')).toBe(
      'was introduced to you by Al',
    );
    expect(hopEvidence('a', t('same_school_cohort', { school: 'Cornell' }), 'Bo')).toBe(
      'went to Cornell with Bo',
    );
    expect(hopEvidence('a', t('same_current_company', { orgName: 'Figma' }), 'Bo')).toBe(
      'works with Bo at Figma',
    );
    expect(hopEvidence('a', undefined, 'Bo')).toBe('knows Bo');
  });
});

describe('rankCompanyTargets', () => {
  const ex = (a: string, b: string, w = 0.8) =>
    tie(a, b, 'email_exchange', w, 0.95, {}, '2026-10-14T12:00:00Z');

  it('routes everyone at a small company and returns at most two routes per target', () => {
    const r = rankCompanyTargets({
      people: new Map([rp('a', 80), rp('b', 70), rp('c', 60), rp('x', 0), rp('y', 0)].map((p) => [p.id, p])),
      pairs: combineTies([ex('a', 'x'), ex('b', 'x'), ex('c', 'x'), ex('a', 'y', 0.4)], NOW),
      targets: [
        { id: 'x', name: 'X' },
        { id: 'y', name: 'Y' },
      ],
      now: NOW,
    });
    expect(r.map((x) => `${x.target.id}<${x.path.firstHopId}`)).toEqual(['x<a', 'x<b', 'y<a']);
  });

  it('uses PPR to pick ten people at a big company', () => {
    const targets = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
    const pairs: TiePair[] = [];
    const ties = targets.slice(0, 3).map((t) => ex('a', t.id));
    pairs.push(...combineTies(ties, NOW).values());
    const r = rankCompanyTargets({
      people: new Map([rp('a', 80), ...targets.map((t) => rp(t.id, 0))].map((p) => [p.id, p])),
      pairs: new Map(pairs.map((p) => [`${p.aId}|${p.bId}`, p])),
      targets,
      now: NOW,
    });
    expect(new Set(r.map((x) => x.target.id))).toEqual(new Set(['t0', 't1', 't2']));
  });
});
