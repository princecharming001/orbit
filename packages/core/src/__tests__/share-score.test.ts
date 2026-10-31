import { describe, expect, it } from 'vitest';
import {
  computeTieFeatures,
  SHARE_MASKED_FEATURES,
  scoreTie,
  shareCloseness,
  shareFeatures,
  shareScore,
  TIE_FEATURES,
} from '../scoring/tieScore';
import { ANCHORS, at, empty, msg } from './fixtures/tie-anchors';

const NOW = new Date('2026-10-14T12:00:00Z');

/** Weekly two-way email for six months, three meetings: the A4 anchor, a close tie by every Google-derived sign. */
const a4 = () => ANCHORS.find((a) => a.id === 'A4')!.history(NOW);

describe('shareScore (plan 29 §A2.2): what a friend may see of a tie', () => {
  it('masks every Google-derived feature and keeps LinkedIn, shared context, warmth, engagement', () => {
    const kept = TIE_FEATURES.filter((f) => !SHARE_MASKED_FEATURES.includes(f));
    expect(kept.sort()).toEqual(['engagement', 'linkedin', 'shared', 'warmth'].sort());
    const { features } = computeTieFeatures(a4(), NOW);
    const masked = shareFeatures(features);
    for (const f of SHARE_MASKED_FEATURES) expect(masked[f], f).toBe(0);
    for (const f of kept) expect(masked[f], f).toBe(features[f]);
  });

  it('a person whose only ties are email threads shares as closeness 1 at most, however close the score says', () => {
    const history = a4();
    expect(scoreTie(history, NOW).score).toBeGreaterThanOrEqual(80);
    const shared = shareScore(history, NOW);
    expect(shared).toBeLessThan(40);
    expect(shareCloseness(shared)).toBe(1);
    // a thread with a stranger and a long two-way history land in the same place: the history never crosses
    const stranger = empty({ messages: [msg(NOW, 2, 'out', 't1')] });
    expect(shareScore(stranger, NOW)).toBe(shared);
  });

  it("a LinkedIn connection with nothing more reads as knows; the student's own label stands in for everything", () => {
    const linkedin = empty({ linkedinConnected: true, connectedAt: at(NOW, 400) });
    const s = shareScore(linkedin, NOW);
    expect(s).toBeGreaterThan(shareScore(empty(), NOW));
    expect(shareCloseness(s)).toBe(1);
    // a label is the student's own word: 3 is "knows well", 4 and 5 "close", 1 and 2 "knows"
    const labelled = (closeness: number) =>
      shareCloseness(shareScore(empty({ label: { closeness, at: at(NOW, 1) } }), NOW));
    expect([1, 2, 3, 4, 5].map(labelled)).toEqual([1, 1, 2, 3, 3]);
    // shared school and an overlapping employer lift it without any mail
    const shared = empty({
      linkedinConnected: true,
      shared: { sameSchool: true, overlappingEmployer: true, sameCity: true },
      noteWarmth: [1],
    });
    expect(shareScore(shared, NOW)).toBeGreaterThan(s);
  });

  it('shareCloseness cuts at the warm and strong bands', () => {
    expect(shareCloseness(0)).toBe(1);
    expect(shareCloseness(39)).toBe(1);
    expect(shareCloseness(40)).toBe(2);
    expect(shareCloseness(59)).toBe(2);
    expect(shareCloseness(60)).toBe(3);
    expect(shareCloseness(100)).toBe(3);
  });
});
