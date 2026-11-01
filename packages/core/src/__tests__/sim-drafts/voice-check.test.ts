/**
 * The voice check against the draft simulation (plan 29 §B7): the template writer's drafts that the reply rubric
 * already passes are, by construction, in the persona's own style, so `voiceCheck` should pass almost all of them.
 * Run twice: with the persona's preset card as drafting used it, and with a card learned the way Orbit learns one, from
 * the persona's other drafts (every scenario but the one checked), standing in for mail the student really sent; the
 * greeting, sign-off and contraction rules apply to that one. False positives stay under 5% in both.
 *
 * Run: cd packages/core && npx vitest run src/__tests__/sim-drafts
 */
import { describe, expect, it } from 'vitest';
import { generateDraft } from '../../drafts/templates';
import { buildStyleCard } from '../../style/card';
import { voiceCheck } from '../../style/voice';
import { buildContext, RECIPIENTS, SCENARIOS } from './harness';
import { buildPersonas } from './personas';
import { grade, RUBRIC_IDS } from './rubric';

const passing = buildPersonas()
  .flatMap((p) =>
    RECIPIENTS.flatMap((r) =>
      SCENARIOS.filter(
        (s) => !(s === 'referral_ask' && ['fundraising', 'cofounder'].includes(p.goal.id)),
      ).map((s) => {
        const b = buildContext(p, r, s);
        return grade(b, generateDraft(b.ctx));
      }),
    ),
  )
  .filter((g) => RUBRIC_IDS.every((id) => g.grade[id].pass !== false));

/** The card Orbit would learn from this persona's mail: their other passing drafts, the checked scenario left out. */
const learnedCards = new Map<string, ReturnType<typeof buildStyleCard>>();
function learnedCard(g: (typeof passing)[number]) {
  const key = `${g.persona.id}/${g.scenario}`;
  let card = learnedCards.get(key);
  if (!card) {
    const bodies = passing
      .filter((x) => x.persona.id === g.persona.id && x.scenario !== g.scenario && x.ctx.channel === 'gmail')
      .map((x) => x.draft.body);
    card = buildStyleCard(bodies, g.persona.name.first, g.persona.tone);
    learnedCards.set(key, card);
  }
  return card;
}

function falsePositives(learned: boolean) {
  const flagged = passing
    .map((g) => {
      const card = learned ? learnedCard(g) : g.ctx.styleCard;
      return { g, r: voiceCheck({ body: g.draft.body, subject: g.draft.subject }, { card }) };
    })
    .filter((x) => !x.r.ok);
  return { flagged, rate: flagged.length / passing.length };
}

describe('voiceCheck on the draft simulation', () => {
  it('has enough rubric-passing drafts to measure', () => {
    expect(passing.length).toBeGreaterThan(500);
  });
  for (const learned of [false, true])
    it(`flags under 5% of the drafts the rubric passes (${learned ? 'a learned card' : 'the preset card'})`, () => {
      const { flagged, rate } = falsePositives(learned);
      const byCode = new Map<string, number>();
      for (const f of flagged)
        for (const p of f.r.problems) byCode.set(p.code, (byCode.get(p.code) ?? 0) + 1);
      console.log(
        `voiceCheck (${learned ? 'learned' : 'preset'}): ${flagged.length} of ${passing.length} flagged (${(rate * 100).toFixed(1)}%)`,
        Object.fromEntries(byCode),
        flagged
          .slice(0, 3)
          .map(
            (f) =>
              `${f.g.persona.id}/${f.g.recipient}/${f.g.scenario}: ${f.r.problems.map((p) => p.detail).join(' | ')}`,
          ),
      );
      expect(rate).toBeLessThan(0.05);
    });
});
