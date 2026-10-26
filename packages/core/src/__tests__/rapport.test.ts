import { describe, expect, it } from 'vitest';
import { asRapportReading, rapportFromLlm, replyRapport, styleMatch } from '../scoring/rapport';
import {
  gatherRapport,
  RAPPORT_MAX_POINTS,
  rapportSentence,
  scoreTie,
  type TieHistory,
  type TieRapport,
} from '../scoring/tieScore';
import { vaderValence } from '../scoring/vader';
import { ANCHORS, at, empty, msg } from './fixtures/tie-anchors';

const NOW = new Date('2026-10-14T12:00:00Z');
const read = (text: string, answering?: string) =>
  replyRapport({ text, answering, studentFirstName: 'Alex', valence: vaderValence });

const WARM =
  "Hey Alex! So good to hear from you. How did the Stripe interview go? Happy to intro you to my old manager there, and let's grab coffee when you're back in the city.";
const OK = 'ok';
const SOUNDS_GOOD = 'Sounds good, thanks.';
const DECLINE = "Unfortunately I can't make time this month, but good luck with the search!";
const STOP = 'Please stop emailing me.';
const DISTANT = "I'm not the right person for this and I don't take informational calls.";
const FORMAL =
  'Dear Alex, Thank you for your note. I will review and respond in due course. Kind regards, J. Smith';

describe('replyRapport: one reply', () => {
  it('reads a warm, personal reply as warm and names why', () => {
    const r = read(WARM);
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.by).toBe('lexical');
    expect(r.cues).toEqual(
      expect.arrayContaining([
        'asks_about_you',
        'offers_help',
        'plans_together',
        'glad_to_hear',
        'uses_your_name',
      ]),
    );
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('reads a short "ok" or "sounds good" as neutral, never cold', () => {
    for (const t of [OK, SOUNDS_GOOD, 'Thanks', 'Will do']) {
      const r = read(t);
      expect(Math.abs(r.score)).toBeLessThan(0.2);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
    expect(read(OK).confidence).toBeLessThan(0.5);
  });

  it('a polite decline that wishes them well is not cold', () => {
    expect(read(DECLINE).score).toBeGreaterThanOrEqual(0);
  });

  it('a request to stop is as cold as it gets', () => {
    const r = read(STOP);
    expect(r.score).toBe(-1);
    expect(r.cues).toContain('asked_to_stop');
  });

  it('distancing reads cold; formal register pulls toward neutral without going negative', () => {
    expect(read(DISTANT).score).toBeLessThan(-0.2);
    expect(read(DISTANT).cues).toContain('distant');
    const formal = read(FORMAL);
    expect(formal.cues).toContain('formal');
    expect(formal.score).toBeGreaterThanOrEqual(0);
    expect(formal.score).toBeLessThan(read(WARM).score);
  });

  it('works without a valence function and keeps cues as labels, never words', () => {
    const r = replyRapport({ text: WARM, studentFirstName: 'Alex' });
    expect(r.score).toBeGreaterThan(0.5);
    for (const c of r.cues) expect(c).toMatch(/^[a-z_]+$/);
  });

  it('a long reply to a short message reads as thoughtful', () => {
    const long = `Thanks for reaching out. ${'I spent four years on the payments team and learned a lot about the interview loop there. '.repeat(4)}`;
    expect(read(long, 'Hi, could I ask you about your time at Stripe?').cues).toContain('thoughtful');
  });

  it('emoji and "haha" read as casual', () => {
    expect(read('haha yes 🙂 for sure').cues).toContain('casual');
  });

  it('style matching is high for similar function-word use and needs enough text', () => {
    const a =
      'I think we should talk about it because I was not sure if the plan is going to work for all of us here.';
    const b =
      'I think you are right about it and I was not sure if the timing is going to work for all of us either.';
    expect(styleMatch(a, b)).toBeGreaterThan(0.6);
    expect(styleMatch('ok', b)).toBeUndefined();
  });
});

describe('LLM readings', () => {
  it('maps warmth, familiarity and effort, and keeps only known cues', () => {
    const r = rapportFromLlm({
      warmth: 2,
      familiarity: 'friend',
      effort: 2,
      cues: ['offers_help', 'made_up'],
    });
    expect(r.by).toBe('llm');
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.cues).toEqual(['offers_help']);
    expect(rapportFromLlm({ warmth: 0, familiarity: 'professional', effort: 0 }).score).toBe(0);
    expect(
      rapportFromLlm({ warmth: 1, familiarity: 'friendly', effort: 1, cues: ['asked_to_stop'] }).score,
    ).toBe(-1);
  });

  it('accepts stored readings and rejects anything else', () => {
    expect(asRapportReading({ score: 0.4, by: 'llm', cues: ['offers_help', 'x'], confidence: 2 })).toEqual({
      score: 0.4,
      by: 'llm',
      cues: ['offers_help'],
      confidence: 1,
      v: 1,
    });
    expect(asRapportReading('{"score":0.4}')).toBeUndefined();
    expect(asRapportReading({ score: Number.NaN })).toBeUndefined();
    expect(asRapportReading(null)).toBeUndefined();
  });
});

describe('gatherRapport', () => {
  const reading = read(WARM);
  const row = {
    at: at(NOW, 1),
    inbound: true,
    automated: false,
    participants: 2,
    channel: 'email' as const,
    reading,
  };
  it('keeps their own replies only', () => {
    expect(gatherRapport([row])).toHaveLength(1);
    expect(gatherRapport([{ ...row, inbound: false }])).toHaveLength(0);
    expect(gatherRapport([{ ...row, automated: true }])).toHaveLength(0);
    expect(gatherRapport([{ ...row, participants: 6 }])).toHaveLength(0);
    expect(gatherRapport([{ ...row, fromEmail: 'no-reply@greenhouse.io' }])).toHaveLength(0);
    expect(gatherRapport([{ ...row, reading: undefined }])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the plan 27 anchors

const readings = (text: string, daysAgo: number[]): TieRapport[] =>
  daysAgo.map((d) => ({ at: at(NOW, d), reading: read(text), channel: 'email' as const }));
const score = (h: TieHistory) => scoreTie(h, NOW).score;
const anchor = (id: string) => ANCHORS.find((a) => a.id === id)!.history(NOW);

describe('plan 27 anchors', () => {
  it('R1: a stranger with one effusive reply stays below Warm', () => {
    const h = anchor('A3');
    const s = score({ ...h, rapport: readings(WARM, [14.25]) });
    expect(s).toBeGreaterThan(score(h));
    expect(s).toBeLessThan(40);
  });

  it('R2: a five-year friend whose replies are all "ok" loses no more than 3 points', () => {
    const h = anchor('A4');
    const days = Array.from({ length: 26 }, (_, w) => 3 + 7 * w);
    for (const text of [OK, SOUNDS_GOOD]) {
      const s = score({ ...h, rapport: readings(text, days) });
      expect(score(h) - s).toBeLessThanOrEqual(3);
    }
  });

  it('R3: three months of warm replies gain 5 to 10 points', () => {
    const messages = [];
    for (let w = 0; w < 12; w++) {
      messages.push(msg(NOW, 3 + 7 * w + 0.2, 'out', `t${w}`));
      messages.push(msg(NOW, 3 + 7 * w, 'in', `t${w}`, { isReplyLatencyHours: 30 }));
    }
    const h = empty({ messages });
    const base = score(h);
    const s = score({
      ...h,
      rapport: readings(
        WARM,
        Array.from({ length: 12 }, (_, w) => 3 + 7 * w),
      ),
    });
    expect(s - base).toBeGreaterThanOrEqual(5);
    expect(s - base).toBeLessThanOrEqual(10);
    const t = scoreTie({ ...h, rapport: readings(WARM, [3, 10, 17]) }, NOW);
    expect(t.explanation.join(' ')).toContain('Their replies are warm');
  });

  it('R4: a polite decline does not lower closeness', () => {
    const h = anchor('A3');
    expect(score({ ...h, rapport: readings(DECLINE, [14.25]) })).toBeGreaterThanOrEqual(score(h));
  });

  it('R5: "please stop emailing me" lowers it and the explanation says so', () => {
    const h = anchor('A7');
    const t = scoreTie({ ...h, rapport: readings(STOP, [29.5]) }, NOW);
    expect(t.score).toBeLessThan(score(h));
    expect(t.explanation).toContain('They asked you not to contact them');
  });

  it('R6: recruiter templates and auto-replies change nothing', () => {
    const h = anchor('A4');
    const rapport = gatherRapport([
      {
        at: at(NOW, 2),
        inbound: true,
        automated: true,
        participants: 2,
        channel: 'email',
        reading: read(WARM),
      },
      {
        at: at(NOW, 2),
        inbound: true,
        automated: false,
        participants: 2,
        channel: 'email',
        reading: read(WARM),
        fromEmail: 'notifications@lever.co',
      },
    ]);
    expect(score({ ...h, rapport })).toBe(score(h));
  });

  it(`never moves a score more than ${RAPPORT_MAX_POINTS} points`, () => {
    const days = Array.from({ length: 60 }, (_, i) => i + 1);
    for (const id of ['A3', 'A5', 'A7', 'A8']) {
      const h = anchor(id);
      const confident = (text: string): TieRapport[] =>
        readings(text, days).map((r) => ({ ...r, reading: { ...r.reading, confidence: 1 } }));
      expect(score({ ...h, rapport: confident(WARM) }) - score(h)).toBeLessThanOrEqual(RAPPORT_MAX_POINTS);
      expect(score(h) - score({ ...h, rapport: confident(STOP) })).toBeLessThanOrEqual(RAPPORT_MAX_POINTS);
    }
  });

  it('no replies means f16 = 0: silence never lowers closeness', () => {
    const h = anchor('A5');
    expect(scoreTie(h, NOW).features.rapport).toBe(0);
    expect(score({ ...h, rapport: [] })).toBe(score(h));
  });
});

describe('rapportSentence', () => {
  it('names the two most frequent warm cues', () => {
    expect(rapportSentence(['asks_about_you', 'offers_help', 'casual'])).toBe(
      "Their replies are warm: they ask how you're doing and offer to help",
    );
    expect(rapportSentence(['casual'])).toBe('Their replies are warm');
  });
});
