/**
 * Reading what the student tells the outreach coach ("shorter", "more casual, and never say 'circle back'") as
 * changes to their style card. Common phrasings map to a setting by rule; anything the rules do not understand is
 * handed back so it can go to Claude (when it is on) or into the notes every draft reads.
 */
import type { StyleCard, StyleChange } from '@orbit/core';

export const GREETING_CHOICES = [
  'Hi {first},',
  'Hey {first},',
  'Hello {first},',
  '{first},',
  'Dear {first},',
];
export const SIGNOFF_CHOICES = ['Best', 'Thanks', 'Thanks so much', 'Cheers', 'Best regards', 'Kind regards'];

/** The quick chips under the feedback box. */
export const FEEDBACK_CHIPS = [
  'Shorter',
  'More casual',
  'More formal',
  'No exclamation marks',
  'Different greeting',
  'Different sign-off',
  'Get to the ask faster',
] as const;

export interface FeedbackReading {
  changes: StyleChange[];
  /** the parts no rule understood, in the student's words */
  unmatched: string[];
}

const NEG =
  /\b(no|not|never|don'?t|do not|stop|without|drop|remove|cut|avoid|fewer|less|too many|tone down|quit|lose)\b/;
const POS = /\b(more|add|use|allow|some|include|with|keep)\b/;

const round10 = (n: number) => Math.round(n / 10) * 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const clampLen = (n: number) => Math.max(30, Math.min(180, n));

const SIGNOFF_WORDS_ORDERED = [
  'thanks so much',
  'thank you so much',
  'best regards',
  'kind regards',
  'warm regards',
  'all the best',
  'talk soon',
  'many thanks',
  'thank you',
  'sincerely',
  'warmly',
  'cheers',
  'thanks',
  'regards',
  'best',
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function nextOf<T>(list: readonly T[], current: T | undefined, same: (a: T, b: T) => boolean): T {
  const i = current === undefined ? -1 : list.findIndex((x) => same(x, current));
  return list[(i + 1) % list.length]!;
}

/** Quoted bits are kept whole while the feedback is split into clauses. */
function splitClauses(text: string): string[] {
  const quotes: string[] = [];
  const masked = text.replace(/["“”]([^"“”]+)["“”]|'([^']{2,}?)'(?=\s|$|[,.;!?])/g, (_m, a, b) => {
    quotes.push(a ?? b);
    return `\uE000${quotes.length - 1}\uE000`;
  });
  return masked
    .split(
      /[\n;]+|(?<=[a-z0-9)\uE000])[.!?]+(?:\s+|$)|,\s*(?:and\s+|but\s+)?|\s+(?:and|but|also|plus)\s+(?=(?:no|more|less|use|say|sign|start|open|end|make|be|don'?t|never|stop|get|keep|shorter|longer|fewer|drop|add|avoid|cut)\b)/i,
    )
    .map((c) => (c ?? '').replace(/\uE000(\d+)\uE000/g, (_m, i) => `"${quotes[Number(i)]}"`).trim())
    .filter((c) => c.replace(/["\s]/g, '').length > 0);
}

function quotedIn(c: string): string | undefined {
  return c.match(/"([^"]+)"/)?.[1]?.trim();
}

/** One clause as a change, or undefined when no rule fits. */
function readClause(c: string, card: StyleCard): StyleChange[] | undefined {
  c = c.replace(/[’]/g, "'");
  const l = c.toLowerCase();

  // exclamation marks
  if (/exclamation|\bbangs?\b|!{1,}\s*marks?/.test(l) || /\b(less|tone down the) enthusias/.test(l))
    return [{ kind: 'exclamations', on: !NEG.test(l) && (POS.test(l) || /\bexclamation/.test(l)) }];
  if (/\bless (excited|eager|peppy|bubbly)\b|\btoo (excited|eager|peppy|bubbly)\b/.test(l))
    return [{ kind: 'exclamations', on: false }];
  // emoji
  if (/\bemoji|\bemoticon|\bsmiley/.test(l)) return [{ kind: 'emoji', on: !NEG.test(l) }];
  // contractions
  if (/\bcontraction/.test(l)) return [{ kind: 'contractions', on: !NEG.test(l) }];

  // length
  const n = l.match(/\b(\d{2,3})\s*words?\b/);
  if (n) return [{ kind: 'length', words: clampLen(Number(n[1])) }];
  if (/\b(much|way|a lot|far|super|really) (shorter|more concise|briefer)\b|\bway too long\b/.test(l))
    return [{ kind: 'length', words: clampLen(round10(card.avgMessageWords * 0.5)) }];
  if (
    /\b(shorter|more concise|concise|too long|too wordy|less wordy|wordy|cut it down|tighter|briefer|brief|trim|less text|fewer words|shorten|long-winded|rambl)/.test(
      l,
    )
  )
    return [{ kind: 'length', words: clampLen(round10(card.avgMessageWords * 0.7)) }];
  if (/\b(much|way|a lot) longer\b/.test(l))
    return [{ kind: 'length', words: clampLen(round10(card.avgMessageWords * 1.5)) }];
  if (
    /\b(longer|more detail|more detailed|too short|too brief|expand|more context|fuller|lengthen)\b/.test(l)
  )
    return [{ kind: 'length', words: clampLen(round10(card.avgMessageWords * 1.3)) }];

  // greeting (before tone: "more casual greeting" is about the greeting)
  const greetingWord = l
    .replace(/\b(instead of|rather than|not|over)\s+["']?(hey|hi|hello|dear)\b.*$/, '')
    .match(/\b(hey|hello|dear|hi)\b/)?.[1];
  const aboutGreeting =
    /\bgreeting|\bopen(ing)? with|\bstart(ing)? with|\bbegin(ning)? with|\bsay\b|\binstead of\b|\buse\b/.test(
      l,
    );
  if (/\b(just|only) (their|the) (first )?name\b|\bno greeting\b|\bname only\b/.test(l))
    return [{ kind: 'greeting', pattern: '{first},' }];
  if (greetingWord && aboutGreeting) {
    const pattern = `${cap(greetingWord)} {first},`;
    if (NEG.test(l.split(greetingWord)[0] ?? '')) {
      // "don't open with Hey": move off it if that is what they use now
      if (!card.greetingPatterns[0]?.toLowerCase().startsWith(greetingWord)) return [];
      return [{ kind: 'greeting', pattern: greetingWord === 'hi' ? 'Hello {first},' : 'Hi {first},' }];
    }
    return [{ kind: 'greeting', pattern }];
  }
  if (/\b(different|another|other|new|change( the)?|switch( the)?) greeting\b/.test(l))
    return [
      {
        kind: 'greeting',
        pattern: nextOf(GREETING_CHOICES, card.greetingPatterns[0], (a, b) => a === b),
      },
    ];

  // sign-off
  const aboutSignoff =
    /\bsign[- ]?off|\bsign (with|it|as)|\bsigning off|\bend(ing)? with|\bclos(e|ing) with|\bclosing\b/.test(
      l,
    );
  if (/\b(different|another|other|new|change( the)?|switch( the)?) (sign[- ]?off|closing)\b/.test(l)) {
    const now = (card.signoffs[0] ?? '').split('\n')[0]!.replace(/,$/, '');
    return [
      { kind: 'signoff', word: nextOf(SIGNOFF_CHOICES, now, (a, b) => a.toLowerCase() === b.toLowerCase()) },
    ];
  }
  const signWord = SIGNOFF_WORDS_ORDERED.find((w) => new RegExp(`\\b${w}\\b`).test(l));
  if (aboutSignoff && signWord && !NEG.test(l.split(signWord)[0] ?? ''))
    return [{ kind: 'signoff', word: cap(signWord) }];

  // tone ("less formal" before "formal")
  if (
    /\b(more casual|less formal|too formal|too stiff|less stiff|stiff|more relaxed|relaxed|friendlier|more friendly|chill(er)?|laid[- ]back|conversational|warmer|less corporate|less robotic|robotic|more human|more natural|casual|less uptight)\b/.test(
      l,
    )
  )
    return [{ kind: 'formality', value: r2(Math.max(0.15, card.formality - 0.25)), contractions: true }];
  if (
    /\b(more formal|less casual|too casual|more professional|professional|polished|more polite|formal|too informal)\b/.test(
      l,
    )
  ) {
    const value = r2(Math.min(0.9, card.formality + 0.25));
    return [{ kind: 'formality', value, contractions: value >= 0.7 ? false : undefined }];
  }

  // structure
  if (
    /\b(get to the (point|ask)|(ask|point) (sooner|earlier|faster|first|up ?front)|lead with the ask|faster to the ask|to the point|less preamble|less intro|skip the intro|cut the intro|ask faster)\b/.test(
      l,
    )
  )
    return [{ kind: 'note', text: 'Get to the ask within the first two sentences.' }];
  if (
    /\b(more about (them|the person|the reader)|less about me|less "?i"?|fewer "?i"? sentences|too much about me)\b/.test(
      l,
    )
  )
    return [
      { kind: 'note', text: 'Write about them more than about me: fewer sentences starting with "I".' },
    ];
  if (/\b(one ask|single ask|fewer (asks|questions)|too many (asks|questions))\b/.test(l))
    return [{ kind: 'note', text: 'One ask per message.' }];

  // never say X
  const m = l.match(
    /\b(?:never|don'?t|do not|stop|no more|avoid|quit|ban)\s+(?:say(?:ing)?|us(?:e|ing)|writ(?:e|ing)|open(?:ing)? with|start(?:ing)? with|end(?:ing)? with|put)\s+(.+)$/,
  );
  // keep the student's casing: `l` is `c` lowercased, so the offsets line up
  const said = m
    ? (quotedIn(c) ?? c.slice(m.index! + m[0].length - m[1]!.length))
    : /^(no|remove|cut|drop|lose|ban)\b/.test(l)
      ? quotedIn(c)
      : undefined;
  if (said) {
    const phrase = said.replace(/^["'“]|["'”.!?]+$/g, '').trim();
    if (phrase.length >= 2 && phrase.split(/\s+/).length <= 12) return [{ kind: 'avoid', phrase }];
  }
  return undefined;
}

/** What the student said, as changes to their card, and what was left over. */
export function interpretFeedback(text: string, card: StyleCard): FeedbackReading {
  const changes: StyleChange[] = [];
  const unmatched: string[] = [];
  for (const clause of splitClauses(text)) {
    const r = readClause(clause, card);
    if (r) changes.push(...r);
    else unmatched.push(clause);
  }
  return { changes, unmatched };
}

/** A leftover clause as a note for drafts: a sentence, capitalised, with an end mark. */
export function asNote(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  return cap(/[.!?]$/.test(t) ? t : `${t}.`);
}

/** What Claude read in the feedback (every field optional), as the same changes the rules make. */
export interface LlmStyleReading {
  avgMessageWords?: number | null;
  formality?: number | null;
  contractions?: boolean | null;
  exclamations?: boolean | null;
  emoji?: boolean | null;
  greeting?: string | null;
  signoff?: string | null;
  avoid?: string[];
  note?: string | null;
}

export function changesFromLlm(r: LlmStyleReading): StyleChange[] {
  const out: StyleChange[] = [];
  if (typeof r.avgMessageWords === 'number' && Number.isFinite(r.avgMessageWords))
    out.push({ kind: 'length', words: clampLen(Math.round(r.avgMessageWords)) });
  if (typeof r.formality === 'number' && Number.isFinite(r.formality))
    out.push({
      kind: 'formality',
      value: Math.max(0, Math.min(1, r.formality)),
      contractions: r.contractions ?? undefined,
    });
  else if (typeof r.contractions === 'boolean') out.push({ kind: 'contractions', on: r.contractions });
  if (typeof r.exclamations === 'boolean') out.push({ kind: 'exclamations', on: r.exclamations });
  if (typeof r.emoji === 'boolean') out.push({ kind: 'emoji', on: r.emoji });
  const g = r.greeting?.trim();
  if (g && g.length <= 30) {
    const word = g.replace(/\{first\}|[,.!]/g, '').trim();
    out.push({
      kind: 'greeting',
      pattern: g.includes('{first}') ? g : word ? `${cap(word)} {first},` : '{first},',
    });
  }
  const s = r.signoff?.trim().replace(/,$/, '');
  if (s && s.split(/\s+/).length <= 4 && !/\n/.test(s)) out.push({ kind: 'signoff', word: cap(s) });
  for (const a of r.avoid ?? [])
    if (a.trim() && a.split(/\s+/).length <= 12) out.push({ kind: 'avoid', phrase: a.trim() });
  if (r.note?.trim()) out.push({ kind: 'note', text: asNote(r.note) });
  return out;
}
