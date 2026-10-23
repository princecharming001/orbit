/**
 * Any name in Latin letters, so the same person written in two scripts compares as one: "Łukasz" and "Lukasz",
 * "Иван Петров" and "Ivan Petrov", "王伟" and "Wang Wei", "김민준" and "Gim Min Jun". This is any-ascii's table
 * (ISC, Hunter WB; vendored as translit.data.ts, see anyascii.NOTICE) and its lookup: each character becomes the
 * ASCII any-ascii gives it, and a character it has no rendering for (or a block left out of the vendored part, such as
 * emoji) becomes nothing.
 */
import {
  CJK_INDEX,
  CJK_INDEX_ALPHABET,
  CJK_READINGS,
  HANGUL_FINALS,
  HANGUL_INITIALS,
  HANGUL_VOWELS,
  TRANSLIT_BLOCKS,
} from './translit.data';

const blocks = new Map<number, string[]>();
let readings: string[] | undefined;
const digit = new Map([...CJK_INDEX_ALPHABET].map((c, i) => [c, i]));

/** True for a CJK ideograph or a Hangul syllable: one syllable of a name, written surname first. */
export function isSyllableChar(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3);
}

/** The ASCII rendering of one code point (empty when there is none). */
export function transliterateChar(cp: number): string {
  if (cp <= 0x7f) return String.fromCodePoint(cp);
  if (cp >= 0x4e00 && cp <= 0x9fff) {
    readings ??= CJK_READINGS.split('|');
    const i = (cp - 0x4e00) * 2;
    const n =
      (digit.get(CJK_INDEX[i]!) ?? 0) * CJK_INDEX_ALPHABET.length + (digit.get(CJK_INDEX[i + 1]!) ?? 0);
    return readings[n] ?? '';
  }
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    const s = cp - 0xac00;
    const t = s % 28;
    const v = Math.floor(s / 28) % 21;
    const l = Math.floor(s / 28 / 21);
    const out = `${HANGUL_INITIALS[l]}${HANGUL_VOWELS[v]}${HANGUL_FINALS[t]}`;
    // any-ascii writes each syllable capitalised ("Gim"), which keeps syllables apart when they are run together
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  const num = cp >>> 8;
  let b = blocks.get(num);
  if (!b) {
    const raw = TRANSLIT_BLOCKS[num];
    if (raw === undefined) return '';
    b = raw.split('\t');
    blocks.set(num, b);
  }
  return b[cp & 0xff] ?? '';
}

/**
 * A string in ASCII, as any-ascii writes it. With `syllables`, each CJK ideograph and Hangul syllable stands as a
 * word of its own ("王伟" → "Wang Wei" rather than "WangWei"), which is how names compare.
 */
export function transliterate(s: string, opts: { syllables?: boolean } = {}): string {
  let out = '';
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    const t = transliterateChar(cp);
    out += opts.syllables && isSyllableChar(cp) && t ? ` ${t} ` : t;
  }
  return opts.syllables ? out.replace(/\s+/g, ' ').trim() : out;
}

/** True when a name is written in CJK ideographs or Hangul, whose order is surname first. */
export function writtenSurnameFirst(s: string): boolean {
  for (const c of s) if (isSyllableChar(c.codePointAt(0)!)) return true;
  return false;
}
