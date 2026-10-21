import { wordCount } from '../text/email';
import type { StyleCard, StyleSource } from '../types';

export type StylePreset = 'warm' | 'direct' | 'formal';

/** One message the student wrote, and where it came from. */
export interface StyleSample {
  text: string;
  source: StyleSource;
}

export function defaultStyleCard(preset: StylePreset, firstName: string): StyleCard {
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

/** The card is the student's own: learned from their messages, or set by hand. Drafts then follow it closely. */
export function personalStyle(card: Pick<StyleCard, 'builtFromCount' | 'custom'>): boolean {
  return card.builtFromCount > 0 || !!card.custom;
}

/** Fewer samples than this and a learned card would be guesswork: the preset stays. */
export const STYLE_MIN_SAMPLES = 3;

const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^,!\n]*[,!]?/i;
const SIGNOFF =
  /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks|best regards|kind regards|warm regards|thanks again|appreciate it)[,!.]?$/i;
/** Words too common to make a phrase someone's own: function words and the everyday words of asking for a chat. */
const PLAIN = new Set(
  (
    'a an the and or but so to of in on at for with from by about as is am are was were be been it its this that ' +
    'i me my you your we our they them he she his her would could can will should do did have has had not if just ' +
    'how what when where who which there here up out any some more very really also than then too all one ' +
    'next week weeks couple time day days minutes min chat call quick talk meet meeting coffee happy free ' +
    'thanks thank hope know let like love get got make sure please best hi hey hello dear'
  ).split(' '),
);

/** Three-word runs this common say nothing about a person's voice. */
const FILLER = new Set(
  'i hope you|hope you are|let me know|thank you for|thanks for the|i would love|would love to|you have time|have time to|look forward to|i wanted to|to hear from|hear from you|if you have|in the next|for your time'.split(
    '|',
  ),
);

/** What a sample counts for: email bodies are letters; LinkedIn and pasted messages may be a few words long. */
function usable(s: StyleSample): boolean {
  const n = wordCount(s.text);
  return n <= 300 && n >= (s.source === 'email' ? 8 : 4);
}

/** Runs of three words the student uses in several different messages: their own turns of phrase. */
function phrasesOf(bodies: string[], firstName: string): string[] {
  const seen = new Map<string, number>();
  const name = firstName.toLowerCase();
  for (const b of bodies) {
    const lines = b
      .split('\n')
      .map((l) => l.trim().replace(GREETING, '').trim())
      .filter((l) => l && !SIGNOFF.test(l));
    const words = lines
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const mine = new Set<string>();
    for (let i = 0; i + 3 <= words.length; i++) {
      const g = words.slice(i, i + 3).join(' ');
      const parts = words.slice(i, i + 3);
      if (g.includes(name) || FILLER.has(g) || parts.some((w) => /\d/.test(w))) continue;
      // at least two words of the three must be the student's own, not glue
      if (parts.filter((w) => !PLAIN.has(w) && w.length > 2).length < 2) continue;
      mine.add(g);
    }
    for (const g of mine) seen.set(g, (seen.get(g) ?? 0) + 1);
  }
  const floor = Math.max(3, Math.ceil(bodies.length * 0.2));
  return [...seen.entries()]
    .filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
}

/**
 * Learn how the student writes from messages they sent: greetings, sign-offs, sentence and message length,
 * contractions, exclamation marks, emoji and their recurring phrases. Accepts plain strings (sent email) or tagged
 * samples from several places. With fewer than three usable samples it returns the preset.
 */
export function buildStyleCard(
  samples: (string | StyleSample)[],
  firstName: string,
  fallback: StylePreset = 'warm',
): StyleCard {
  const tagged = samples
    .map((s) => (typeof s === 'string' ? { text: s, source: 'email' as const } : s))
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter(usable);
  const bodies = tagged.map((s) => s.text);
  if (bodies.length < STYLE_MIN_SAMPLES) return defaultStyleCard(fallback, firstName);
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
    const g = first.match(GREETING);
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
      if (SIGNOFF.test(l)) {
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
  const sources: Partial<Record<StyleSource, number>> = {};
  for (const s of tagged) sources[s.source] = (sources[s.source] ?? 0) + 1;
  return {
    greetingPatterns: top(greetings, 2).length ? top(greetings, 2) : def.greetingPatterns,
    signoffs: top(signoffs, 2).length ? top(signoffs, 2) : def.signoffs,
    formality,
    avgSentenceWords: Math.round(avgSentenceWords),
    avgMessageWords: Math.round(totalWords / bodies.length),
    contractions: contractions / bodies.length > 0.5,
    exclamationsPerMessage: exclamations / bodies.length,
    emoji: emoji / bodies.length > 0.3,
    characteristicPhrases: phrasesOf(bodies, firstName),
    avoid: [],
    // the student's own notes for Orbit; where the samples came from is in `sources`
    notes: '',
    builtFromCount: bodies.length,
    version: 2,
    sources,
  };
}

/** Each place a writing sample comes from, in plain words. */
export const STYLE_SOURCE_WORDS: Record<StyleSource, string> = {
  email: 'sent emails',
  linkedin: 'LinkedIn messages',
  orbit: 'messages you edited in Orbit',
  pasted: 'examples you pasted',
};

/**
 * A freshly learned card, laid over what the student already has. What they set by hand wins: a customised card
 * keeps its greeting, sign-off, tone, length and switches, and takes only the new counts and phrases. Their "never
 * say" list and notes for Orbit are always kept.
 */
export function mergeStyleCard(learned: StyleCard, current: StyleCard | undefined): StyleCard {
  if (!current) return learned;
  const kept = { avoid: current.avoid, notes: current.custom ? current.notes : learned.notes };
  if (!current.custom) return { ...learned, ...kept };
  return {
    ...current,
    ...kept,
    characteristicPhrases: [
      ...new Set([...current.characteristicPhrases, ...learned.characteristicPhrases]),
    ].slice(0, 8),
    builtFromCount: learned.builtFromCount,
    sources: learned.sources,
    version: 2,
  };
}

/** Start the card over from a preset, keeping the student's "never say" list and notes. */
export function presetStyleCard(preset: StylePreset, firstName: string, current?: StyleCard): StyleCard {
  return {
    ...defaultStyleCard(preset, firstName),
    avoid: current?.avoid ?? [],
    custom: true,
    notes: current?.custom ? current.notes : '',
    version: 2,
  };
}

/**
 * Take out the sentences that use a phrase the student never says. A greeting or sign-off line is never dropped,
 * and a body that would be left empty is returned as it was.
 */
export function stripAvoided(body: string, avoid: string[]): string {
  const phrases = avoid.map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 3);
  if (!phrases.length) return body;
  const hit = (t: string) => phrases.some((p) => t.toLowerCase().includes(p));
  const out = body
    .split('\n')
    .map((line) => {
      if (!hit(line)) return line;
      return line
        .split(/(?<=[.!?])\s+/)
        .filter((sent) => !hit(sent))
        .join(' ');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.replace(/\s/g, '').length >= body.replace(/\s/g, '').length * 0.4 ? out : body;
}
