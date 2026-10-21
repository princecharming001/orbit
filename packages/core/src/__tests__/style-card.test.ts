import { describe, expect, it } from 'vitest';
import {
  buildStyleCard,
  defaultStyleCard,
  mergeStyleCard,
  personalStyle,
  presetStyleCard,
  stripAvoided,
} from '../style/card';

const linkedin = [
  'Hey Maya! Thanks so much for connecting, super curious how you made the jump to Stripe.',
  'Hey Diego, loved your post on the infra team, super curious how you think about on-call.',
  'Thanks again for the chat, super curious to see where the payments team goes next!',
  'Hey Priya, fellow Cornellian here, super curious how you picked your first team.',
];

describe('the style card', () => {
  it('learns from LinkedIn messages too, counts each place, and picks up a phrase used in several', () => {
    const card = buildStyleCard(
      linkedin.map((text) => ({ text, source: 'linkedin' as const })),
      'Alex',
    );
    expect(card.builtFromCount).toBe(4);
    expect(card.sources).toEqual({ linkedin: 4 });
    expect(card.greetingPatterns[0]).toBe('Hey {first},');
    expect(card.characteristicPhrases).toContain('super curious how');
    expect(card.notes).toBe('');
    expect(personalStyle(card)).toBe(true);
  });

  it('needs three usable messages; fewer gives the preset', () => {
    const card = buildStyleCard(linkedin.slice(0, 2), 'Alex', 'direct');
    expect(card.builtFromCount).toBe(0);
    expect(card.greetingPatterns).toEqual(defaultStyleCard('direct', 'Alex').greetingPatterns);
    expect(personalStyle(card)).toBe(false);
  });

  it('a hand-made card keeps its choices when Orbit learns again, and takes the new counts and phrases', () => {
    const mine = {
      ...presetStyleCard('formal', 'Alex'),
      avoid: ['pick your brain'],
      notes: 'never mention GPA',
    };
    const learned = buildStyleCard(
      linkedin.map((text) => ({ text, source: 'linkedin' as const })),
      'Alex',
    );
    const merged = mergeStyleCard(learned, mine);
    expect(merged.greetingPatterns).toEqual(mine.greetingPatterns);
    expect(merged.formality).toBe(mine.formality);
    expect(merged.avoid).toEqual(['pick your brain']);
    expect(merged.notes).toBe('never mention GPA');
    expect(merged.builtFromCount).toBe(4);
    expect(merged.characteristicPhrases).toContain('super curious how');
  });

  it('a learned card that nobody edited is replaced, but the never-say list stays', () => {
    const old = { ...buildStyleCard(linkedin, 'Alex'), avoid: ['circle back'] };
    const merged = mergeStyleCard(buildStyleCard(linkedin, 'Alex'), old);
    expect(merged.avoid).toEqual(['circle back']);
    expect(merged.custom).toBeFalsy();
  });

  it('a phrase the student never says is taken out of the draft, sentence by sentence', () => {
    const body =
      'Hi Sarah,\n\nI hope this email finds you well. I am a junior at Cornell. Could I pick your brain for 15 minutes?\n\nBest,\nAlex';
    const out = stripAvoided(body, ['I hope this email finds you well']);
    expect(out).not.toMatch(/finds you well/);
    expect(out).toMatch(/^Hi Sarah,/);
    expect(out).toMatch(/I am a junior at Cornell\./);
    // a list that would gut the message leaves it alone
    expect(stripAvoided('Could I pick your brain?', ['pick your brain'])).toBe('Could I pick your brain?');
  });
});
