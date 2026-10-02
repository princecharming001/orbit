import { wordCount } from '../text/email';
import type { StyleCard } from '../types';

export function defaultStyleCard(preset: 'warm' | 'direct' | 'formal', firstName: string): StyleCard {
  const base = {
    avgSentenceWords: 14,
    avgMessageWords: 90,
    contractions: true,
    exclamationsPerMessage: 0.3,
    emoji: false,
    characteristicPhrases: [],
    avoid: [],
    builtFromCount: 0,
    version: 1,
  };
  if (preset === 'formal')
    return {
      ...base,
      greetingPatterns: ['Dear {first},', 'Hello {first},'],
      signoffs: [`Kind regards,\n${firstName}`, `Best regards,\n${firstName}`],
      formality: 0.85,
      contractions: false,
      exclamationsPerMessage: 0,
      notes: 'Formal preset.',
    };
  if (preset === 'direct')
    return {
      ...base,
      greetingPatterns: ['Hi {first},', '{first},'],
      signoffs: [`Thanks,\n${firstName}`, `Best,\n${firstName}`],
      formality: 0.5,
      avgSentenceWords: 11,
      avgMessageWords: 70,
      notes: 'Direct preset: short sentences, one ask.',
    };
  return {
    ...base,
    greetingPatterns: ['Hi {first},', 'Hey {first},'],
    signoffs: [`Best,\n${firstName}`, `Thanks so much,\n${firstName}`],
    formality: 0.4,
    exclamationsPerMessage: 0.6,
    notes: 'Warm preset.',
  };
}

export function buildStyleCard(
  sentBodies: string[],
  firstName: string,
  fallback: 'warm' | 'direct' | 'formal' = 'warm',
): StyleCard {
  const bodies = sentBodies.map((b) => b.trim()).filter((b) => wordCount(b) >= 8 && wordCount(b) <= 300);
  if (bodies.length < 5) return defaultStyleCard(fallback, firstName);
  const greetings = new Map<string, number>();
  const signoffs = new Map<string, number>();
  let sentenceWords = 0;
  let sentenceCount = 0;
  let totalWords = 0;
  let contractions = 0;
  let exclamations = 0;
  let emoji = 0;
  for (const b of bodies) {
    const first = b.split('\n')[0]!.trim();
    const g = first.match(/^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^,!]*[,!]?/i);
    if (g) {
      const pat = g[0]
        .replace(/\b[A-Z][a-z]+\b/g, (w) =>
          /^(Hi|Hey|Hello|Dear|Good|Morning|Afternoon|Evening)$/.test(w) ? w : '{first}',
        )
        .trim();
      greetings.set(pat, (greetings.get(pat) ?? 0) + 1);
    }
    const lines = b
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      const l = lines[i]!;
      if (
        /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks)[,!.]?$/i.test(
          l,
        )
      ) {
        const name = lines[i + 1] && lines[i + 1]!.length < 30 ? lines[i + 1] : firstName;
        const key = `${l.replace(/[,!.]$/, '')},\n${name}`;
        signoffs.set(key, (signoffs.get(key) ?? 0) + 1);
        break;
      }
    }
    const sents = b.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    sentenceCount += sents.length;
    sentenceWords += sents.reduce((n, s) => n + wordCount(s), 0);
    totalWords += wordCount(b);
    contractions += (b.match(/\b\w+'(m|re|s|ve|ll|d|t)\b/gi) ?? []).length;
    exclamations += (b.match(/!/g) ?? []).length;
    if (/[\p{Extended_Pictographic}]/u.test(b)) emoji++;
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);
  const avgSentenceWords = sentenceCount ? sentenceWords / sentenceCount : 14;
  const formality = Math.min(
    1,
    Math.max(
      0,
      0.5 +
        (avgSentenceWords - 14) * 0.02 -
        (contractions / bodies.length) * 0.08 -
        (exclamations / bodies.length) * 0.1 +
        (greetings.has('Dear {first},') ? 0.2 : 0),
    ),
  );
  const def = defaultStyleCard(fallback, firstName);
  return {
    greetingPatterns: top(greetings, 2).length ? top(greetings, 2) : def.greetingPatterns,
    signoffs: top(signoffs, 2).length ? top(signoffs, 2) : def.signoffs,
    formality,
    avgSentenceWords: Math.round(avgSentenceWords),
    avgMessageWords: Math.round(totalWords / bodies.length),
    contractions: contractions / bodies.length > 0.5,
    exclamationsPerMessage: exclamations / bodies.length,
    emoji: emoji / bodies.length > 0.3,
    characteristicPhrases: [],
    avoid: [],
    notes: `Built from ${bodies.length} sent emails.`,
    builtFromCount: bodies.length,
    version: 1,
  };
}
