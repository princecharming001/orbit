/**
 * The student's voice, kept honest (plan 29 §B2.4). Three pieces, none of which calls a model:
 *
 *   1. the card as sentences, for Settings and the chat ("You greet with Hi and sign off with Thanks");
 *   2. what Orbit learned from the student's edits: notes merged with the ones already kept, at most eight live at
 *      once, and a forgotten note never learned again (the texts are compared after normalising), plus the plain
 *      observations a browser without a Claude key shows instead (the phrases the student cuts or replaces most);
 *   3. `voiceCheck`, run before anything Orbit sends on its own: the sentence length band from the card, the greeting
 *      and sign-off, the phrases the student never says, the notes a word search can check, and contractions.
 *
 * The prompts for the two model calls (distilling edits into notes, and the judge for first messages) live here too,
 * so the server and the browser ask the same question.
 */
import type { VoiceNote } from '../server/api';
import { wordCount } from '../text/email';
import type { StyleCard } from '../types';
import { personalStyle } from './card';

/** At most this many notes are live at once (kept or newly learned); forgotten ones are remembered beside them. */
export const VOICE_NOTES_MAX = 8;
/** The edits one distillation reads, newest first. */
export const VOICE_EDITS_FOR_DISTILL = 30;
/** The card is learned again after this many sends. */
export const VOICE_LEARN_EVERY = 10;
/** A judge score under this holds an auto first message for approval (0 to 3, "written by the same person?"). */
export const VOICE_JUDGE_MIN = 2;
/** The reason a held draft carries, in the student's words. */
export const VOICE_HOLD_REASON = "didn't sound like you";
/** Forgotten notes remembered so they are never learned again; the oldest go past this. */
const FORGOTTEN_KEEP = 100;

/** One edit as the voice reads it: what Orbit wrote, what the student sent instead. */
export interface VoiceEdit {
  id: string;
  before: string;
  after: string;
  kind?: string;
}

/** A note the distiller (or the observations) proposes, before it is merged. */
export interface LearnedNote {
  text: string;
  /** a phrase the note says the student never uses, exactly as they would write it */
  avoid?: string | null;
  evidence: string[];
}

// ---- the card in plain sentences ---------------------------------------------------------------------------------

const firstLine = (s: string) => (s.split('\n')[0] ?? '').trim();

/** "Hi {first}," → "Hi"; "{first}," → their name alone. */
function greetingWords(pattern: string): string {
  const p = pattern.replace(/[,.:]\s*$/, '').trim();
  if (/^\{first\}$/.test(p)) return 'their first name alone';
  return p.replace(/\s*\{first\}\s*/g, ' ').trim() || 'their first name';
}

function signoffWords(s: string): string {
  return firstLine(s)
    .replace(/[,.:]\s*$/, '')
    .trim();
}

const listWords = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * The card as a few sentences in the second person, for Settings, Voice and the chat. Plain words, no dashes:
 * "You greet with Hi and sign off with Thanks." "You write short, with contractions and no exclamation marks."
 */
export function cardProse(card: StyleCard): string[] {
  const out: string[] = [];
  const greet = [...new Set(card.greetingPatterns.map(greetingWords).filter(Boolean))].slice(0, 2);
  const sign = [...new Set(card.signoffs.map(signoffWords).filter(Boolean))].slice(0, 2);
  const g = greet.length ? `You greet with ${greet.join(' or ')}` : '';
  const s = sign.length ? `sign off with ${sign.join(' or ')}` : '';
  if (g && s) out.push(`${g} and ${s}.`);
  else if (g) out.push(`${g}.`);
  else if (s) out.push(`You ${s}.`);
  const words = Math.round(card.avgMessageWords);
  const length = words <= 70 ? 'short' : words <= 130 ? 'at medium length' : 'long';
  const marks =
    card.exclamationsPerMessage <= 0.05
      ? 'no exclamation marks'
      : card.exclamationsPerMessage < 0.5
        ? 'an exclamation mark now and then'
        : 'exclamation marks often';
  const parts = [
    card.contractions ? 'contractions' : 'no contractions',
    marks,
    ...(card.emoji ? ['the odd emoji'] : []),
  ];
  out.push(`You write ${length}, about ${words} words, with ${listWords(parts)}.`);
  out.push(`Your sentences run about ${Math.round(card.avgSentenceWords)} words.`);
  if (card.characteristicPhrases.length)
    out.push(`Phrases of yours: ${listWords(card.characteristicPhrases.slice(0, 5).map((p) => `'${p}'`))}.`);
  if (card.avoid.length) out.push(`You never say ${listWords(card.avoid.slice(0, 6).map((p) => `'${p}'`))}.`);
  if (card.custom && card.notes.trim()) out.push(`Your notes for Orbit: ${card.notes.trim()}`);
  out.push(
    card.builtFromCount > 0
      ? `Learned from ${card.builtFromCount} messages you wrote.`
      : card.custom
        ? 'Set by you.'
        : 'This is a starting style; Orbit has not learned from your messages yet.',
  );
  return out.map(plainText);
}

/** No dashes and no exclamation marks in anything shown to the student (house style). */
export function plainText(s: string): string {
  return s
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/!+/g, '.')
    .replace(/\.\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- notes: normalising, merging, and into the card ---------------------------------------------------------------

/** Two notes are the same note when they read the same after this: lower case, quotes and punctuation gone. */
export function normaliseNoteText(t: string): string {
  return t
    .toLowerCase()
    .replace(/[‘’“”'"`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(you|your)\s+/, '')
    .trim();
}

const QUOTED = /(?:^|[\s(:])['"‘“]([^'"‘’“”\n]{2,80}?)['"’”](?=$|[\s.,;:?)])/g;
const NEGATIVE =
  /\b(cut|cuts|drop|drops|delete|deletes|remove|removes|never|avoid|avoids|stop|skip|skips|strike|take out|takes out|don'?t|do not|change|changes|swap|swaps|replace|replaces)\b/i;

/** The phrases a note quotes ("You cut 'Thanks either way'"). */
export function quotedPhrases(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => m[1]!.trim()).filter((p) => p.length >= 2);
}

/** The phrase a note says the student never uses: its own `avoid`, else the first phrase it quotes after a "cut". */
export function avoidOf(note: Pick<VoiceNote, 'text'> & { avoid?: string | null }): string | undefined {
  const own = note.avoid?.trim();
  if (own) return own;
  if (!NEGATIVE.test(note.text)) return undefined;
  return quotedPhrases(note.text)[0];
}

/** Notes still in force: kept or newly learned, not forgotten. */
export function activeVoiceNotes<T extends Pick<VoiceNote, 'forgottenAt'>>(notes: T[] | undefined): T[] {
  return (notes ?? []).filter((n) => !n.forgottenAt);
}

/**
 * The card drafting uses: the student's card with the notes in force added to its notes, and each phrase a note
 * says they never use added to its avoid list. Without notes in force the card is returned as it was.
 */
export function withVoiceNotes(
  card: StyleCard,
  notes: (Pick<VoiceNote, 'text' | 'forgottenAt'> & { avoid?: string | null })[] | undefined,
): StyleCard {
  const live = activeVoiceNotes(notes);
  if (!live.length) return card;
  const lines = live.map((n) => n.text.trim().replace(/[.]$/, '')).filter(Boolean);
  const avoid = [...card.avoid];
  const seen = new Set(avoid.map((a) => a.toLowerCase()));
  for (const n of live) {
    const a = avoidOf(n);
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      avoid.push(a);
    }
  }
  const learned = `What Orbit learned from your edits: ${lines.join('; ')}.`;
  return { ...card, avoid, notes: card.notes.trim() ? `${card.notes.trim()}\n${learned}` : learned };
}

/** A learned note's words made safe to show: one line, plain, at most 160 characters. */
export function cleanNoteText(t: string): string {
  const one = plainText(t.replace(/\s+/g, ' '));
  return one.length > 160 ? `${one.slice(0, 157).replace(/\s+\S*$/, '')}...` : one;
}

/**
 * New notes laid over the ones the student has. A note whose text (or avoided phrase) matches a forgotten one is
 * never added again; one that matches a note already live adds its evidence to it. At most VOICE_NOTES_MAX notes are
 * live afterwards: the kept ones first, then this round's, then the older unkept ones. Forgotten notes are kept
 * (the newest hundred) so the rule holds next time.
 */
export function mergeVoiceNotes(
  current: VoiceNote[] | undefined,
  learned: LearnedNote[],
  opts: { now: Date; newId: () => string },
): { notes: VoiceNote[]; added: VoiceNote[] } {
  const all = (current ?? []).map((n) => ({ ...n, evidence: [...(n.evidence ?? [])] }));
  const forgotten = all.filter((n) => n.forgottenAt);
  const gone = new Set(forgotten.map((n) => normaliseNoteText(n.text)));
  const goneAvoid = new Set(
    forgotten
      .map((n) => avoidOf(n))
      .filter((a): a is string => !!a)
      .map(normaliseNoteText),
  );
  const at = opts.now.toISOString();
  const added: VoiceNote[] = [];
  const touched = new Set<string>();
  for (const l of learned) {
    const text = cleanNoteText(l.text);
    if (!text) continue;
    const key = normaliseNoteText(text);
    const avoid = l.avoid?.trim() ? l.avoid.trim().slice(0, 80) : null;
    if (!key || gone.has(key) || (avoid && goneAvoid.has(normaliseNoteText(avoid)))) continue;
    const same = all.find(
      (n) =>
        !n.forgottenAt &&
        (normaliseNoteText(n.text) === key ||
          (!!avoid && normaliseNoteText(avoidOf(n) ?? '') === normaliseNoteText(avoid))),
    );
    if (same) {
      same.evidence = [...new Set([...same.evidence, ...l.evidence])].slice(-30);
      touched.add(same.id);
      continue;
    }
    const note: VoiceNote = {
      id: opts.newId(),
      text,
      ...(avoid ? { avoid } : {}),
      evidence: [...new Set(l.evidence)].slice(-30),
      createdAt: at,
      keptAt: null,
      forgottenAt: null,
    };
    all.push(note);
    added.push(note);
    touched.add(note.id);
  }
  const live = all.filter((n) => !n.forgottenAt);
  const rank = (n: VoiceNote) => (n.keptAt ? 0 : touched.has(n.id) ? 1 : 2);
  const keep = new Set(
    [...live]
      .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, VOICE_NOTES_MAX)
      .map((n) => n.id),
  );
  const kept = forgotten
    .sort((a, b) => String(b.forgottenAt).localeCompare(String(a.forgottenAt)))
    .slice(0, FORGOTTEN_KEEP);
  const notes = [...live.filter((n) => keep.has(n.id)), ...kept];
  return { notes, added: added.filter((n) => keep.has(n.id)) };
}

/** Keep or forget one note; a forgotten note stays in the list so it is never learned again. */
export function decideVoiceNote(
  notes: VoiceNote[] | undefined,
  id: string,
  action: 'keep' | 'forget',
  now: Date,
): { notes: VoiceNote[]; note: VoiceNote | undefined } {
  let note: VoiceNote | undefined;
  const at = now.toISOString();
  const out = (notes ?? []).map((n) => {
    if (n.id !== id) return n;
    note = action === 'keep' ? { ...n, keptAt: at, forgottenAt: null } : { ...n, forgottenAt: at };
    return note;
  });
  return { notes: out, note };
}

/** The note a phrase the student said means: by id, else the live note whose words contain theirs. */
export function findVoiceNote(notes: VoiceNote[] | undefined, said: string): VoiceNote | undefined {
  const live = activeVoiceNotes(notes);
  const byId = live.find((n) => n.id === said.trim());
  if (byId) return byId;
  const want = normaliseNoteText(said);
  if (!want) return undefined;
  return (
    live.find((n) => normaliseNoteText(n.text) === want) ??
    live.find((n) => normaliseNoteText(n.text).includes(want)) ??
    live.find((n) => {
      const a = avoidOf(n);
      return !!a && want.includes(normaliseNoteText(a));
    })
  );
}

// ---- edits read without a model -------------------------------------------------------------------------------

const MAX_TOKENS = 400;
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const bare = (w: string) => w.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');

type Hunk = { del: string[]; ins: string[] };

/** The longest common subsequence alignment of two lists by key, as runs of deleted and inserted items. */
function align<T>(a: T[], b: T[], key: (x: T) => string): { del: T[]; ins: T[] }[] {
  const A = a.map(key);
  const B = b.map(key);
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { del: T[]; ins: T[] }[] = [];
  let cur: { del: T[]; ins: T[] } = { del: [], ins: [] };
  const flush = () => {
    if (cur.del.length || cur.ins.length) out.push(cur);
    cur = { del: [], ins: [] };
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) cur.ins.push(b[j++]!);
    else cur.del.push(a[i++]!);
  }
  flush();
  return out;
}

/** A body as its sentences, line by line. */
const unitsOf = (s: string) =>
  s
    .split('\n')
    .flatMap((l) => l.trim().split(/(?<=[.?!])\s+/))
    .map((u) => u.trim())
    .filter(Boolean);
const unitKey = (u: string) => tokens(u).map(bare).join(' ');

/**
 * The word-level changes between two texts: sentences first (a sentence cut whole is one change), then the words
 * inside a sentence that was changed rather than replaced. Undefined when either text is too long to compare.
 */
function hunksOf(before: string, after: string): Hunk[] | undefined {
  const a = unitsOf(before);
  const b = unitsOf(after);
  if (
    tokens(before).length > MAX_TOKENS ||
    tokens(after).length > MAX_TOKENS ||
    a.length > 80 ||
    b.length > 80
  )
    return undefined;
  const out: Hunk[] = [];
  const similar = (x: string, y: string) => {
    const xw = tokens(x).map(bare);
    const yw = tokens(y).map(bare);
    const shared = xw.filter((w) => yw.includes(w)).length;
    return shared / Math.max(xw.length, yw.length, 1);
  };
  for (const h of align(a, b, unitKey)) {
    // a sentence changed in place: its words are compared; the best match of at least half its words
    const dels = h.del.map((u) => ({ u, used: false }));
    const ins: string[] = [];
    for (const i of h.ins) {
      let best: (typeof dels)[number] | undefined;
      let score = 0.5;
      for (const d of dels)
        if (!d.used && similar(d.u, i) >= score) {
          best = d;
          score = similar(d.u, i);
        }
      if (best) {
        best.used = true;
        for (const w of align(tokens(best.u), tokens(i), bare)) out.push(w);
      } else ins.push(i);
    }
    // what is left: short lines swapped at the end (a sign-off for another), the rest cut or added whole
    const left = dels.filter((d) => !d.used).map((d) => d.u);
    while (
      left.length &&
      ins.length &&
      wordCount(left[left.length - 1]!) <= 6 &&
      wordCount(ins[ins.length - 1]!) <= 6
    )
      out.push({ del: tokens(left.pop()!), ins: tokens(ins.pop()!) });
    for (const d of left) out.push({ del: tokens(d), ins: [] });
    for (const i of ins) out.push({ del: [], ins: tokens(i) });
  }
  return out;
}

/** How many words were taken out or put in between Orbit's draft and what was sent. */
export function wordEditDistance(before: string, after: string): number {
  const h = hunksOf(before, after);
  if (!h) return Math.abs(wordCount(before) - wordCount(after)) + 1;
  return h.reduce((n, x) => n + x.del.length + x.ins.length, 0);
}

const GLUE = new Set(
  'a an the and or but so to of in on at for with from by is am are was be it its this that i me my you your we just very'.split(
    ' ',
  ),
);
const phraseOf = (ws: string[]) =>
  ws
    .join(' ')
    .replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9')]+$/g, '')
    .trim();
const meaningful = (ws: string[]) =>
  ws.map(bare).some((w) => w.length >= 4 && !GLUE.has(w)) ||
  (ws.length >= 2 && ws.some((w) => !GLUE.has(bare(w))));

/** A phrase of two words or more is avoided in drafts; one word ("quick", "Best") would catch too much. */
const avoidable = (p: string) => (wordCount(p) >= 2 ? p : null);

/**
 * What the edits show without a model: the phrases the student cut, and the ones they replaced, in two or more
 * edits, most frequent first, as notes ("You cut 'Thanks either way' in 3 edits"). The shorter of two phrases that
 * always went together is left out.
 */
export function editObservations(edits: VoiceEdit[], max = VOICE_NOTES_MAX): LearnedNote[] {
  const cuts = new Map<string, { phrase: string; ids: Set<string> }>();
  const swaps = new Map<string, { from: string; to: string; ids: Set<string> }>();
  for (const e of edits) {
    const hunks = hunksOf(e.before, e.after);
    if (!hunks) continue;
    for (const h of hunks) {
      if (h.del.length && !h.ins.length && h.del.length <= 12 && meaningful(h.del)) {
        const phrase = phraseOf(h.del);
        const key = normaliseNoteText(phrase);
        if (!key) continue;
        const c = cuts.get(key) ?? { phrase, ids: new Set<string>() };
        c.ids.add(e.id);
        cuts.set(key, c);
      } else if (h.del.length && h.ins.length && h.del.length <= 6 && h.ins.length <= 6) {
        const from = phraseOf(h.del);
        const to = phraseOf(h.ins);
        const key = `${normaliseNoteText(from)}>${normaliseNoteText(to)}`;
        if (!normaliseNoteText(from) || !normaliseNoteText(to) || !meaningful([...h.del, ...h.ins])) continue;
        const s = swaps.get(key) ?? { from, to, ids: new Set<string>() };
        s.ids.add(e.id);
        swaps.set(key, s);
      }
    }
  }
  const floor = edits.length >= 2 ? 2 : 1;
  const found = [
    ...[...cuts.values()].map((c) => ({
      key: normaliseNoteText(c.phrase),
      n: c.ids.size,
      note: {
        text: `You cut '${c.phrase}' in ${c.ids.size} ${c.ids.size === 1 ? 'edit' : 'edits'}`,
        avoid: avoidable(c.phrase),
        evidence: [...c.ids],
      },
    })),
    ...[...swaps.values()].map((s) => ({
      key: normaliseNoteText(s.from),
      n: s.ids.size,
      note: {
        text: `You change '${s.from}' to '${s.to}' (${s.ids.size} ${s.ids.size === 1 ? 'edit' : 'edits'})`,
        avoid: avoidable(s.from),
        evidence: [...s.ids],
      },
    })),
  ].filter((f) => f.n >= floor);
  // a phrase inside a longer one found as often says nothing new
  const kept = found.filter(
    (f) => !found.some((g) => g !== f && g.n >= f.n && g.key.length > f.key.length && g.key.includes(f.key)),
  );
  return kept
    .sort((a, b) => b.n - a.n || b.key.length - a.key.length)
    .slice(0, max)
    .map((f) => f.note);
}

// ---- the check before Orbit sends on its own ------------------------------------------------------------------

export type VoiceProblemCode =
  | 'sentence_length'
  | 'greeting'
  | 'signoff'
  | 'avoid'
  | 'note'
  | 'exclamation'
  | 'emoji'
  | 'contractions';

export interface VoiceProblem {
  code: VoiceProblemCode;
  /** one sentence, plain words */
  detail: string;
}

export interface VoiceCheckResult {
  ok: boolean;
  problems: VoiceProblem[];
}

export interface VoiceCheckContext {
  card: StyleCard;
  notes?: (Pick<VoiceNote, 'text' | 'forgottenAt'> & { avoid?: string | null })[];
  /** a few messages the student sent (the server's closest sent mail): their greeting and sign-off count as theirs */
  exemplars?: string[];
}

const GREETING_RE = /^(hi|hey|hello|dear|good (?:morning|afternoon|evening)|greetings|hiya|yo)\b/i;
const SIGNOFF_RE =
  /^(best|thanks|thank you|cheers|regards|warmly|all the best|talk soon|sincerely|take care|thanks so much|many thanks|best regards|kind regards|warm regards|thanks again|appreciate it|thank you so much|best wishes|warm wishes|with thanks|gratefully)[,!.]?$/i;

function greetingFamily(line: string): string | undefined {
  const t = line.trim();
  const m = t.match(GREETING_RE);
  if (m) return m[1]!.toLowerCase().replace(/^good .*/, 'good');
  // "Maya," on its own line: their name and a comma
  if (/^\{first\},?$/.test(t) || /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)?,$/.test(t)) return 'name';
  return undefined;
}

function signoffFamily(line: string): string | undefined {
  const t = line
    .trim()
    .replace(/[,!.]$/, '')
    .toLowerCase();
  if (!SIGNOFF_RE.test(line.trim())) return undefined;
  if (/^(thank|many thanks|with thanks|appreciate|gratefully)/.test(t)) return 'thanks';
  if (/regards|sincerely|warmly|warm wishes|best wishes/.test(t)) return 'regards';
  if (/^(best|all the best)$/.test(t)) return 'best';
  return t;
}

/** The lines of a body without blank ones. */
const linesOf = (body: string) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Where the sign-off sits (its index among the lines), looking at the last four, or -1. */
function signoffAt(lines: string[]): number {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--)
    if (signoffFamily(lines[i]!)) return i;
  return -1;
}

const CONTRACTION = /\b[a-z]+'(m|re|ve|ll|d|t)\b|\b(it|that|there|here|what|who|he|she|let)'s\b/gi;
const EXPANDED =
  /\b(i am|do not|does not|did not|cannot|can not|it is|that is|you are|we are|they are|i will|is not|are not|was not|would not|could not|should not|have not|will not|i have not|let us|there is)\b/gi;

const has = (body: string, phrase: string) => {
  const p = phrase.trim().toLowerCase();
  if (p.length < 3) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(body);
};

/**
 * Does a draft sound like the student? No model: the sentence length band from the card, the greeting and sign-off
 * (only when the card is their own, or their sent mail shows them), the phrases they never say, what their notes say
 * that a word search can see, exclamation marks and emoji they never use, and contractions. Each problem is one plain
 * sentence; `ok` when there are none.
 */
export function voiceCheck(
  draft: { body: string; subject?: string | null },
  ctx: VoiceCheckContext,
): VoiceCheckResult {
  const { card } = ctx;
  const problems: VoiceProblem[] = [];
  const body = draft.body.replace(/\r/g, '');
  const lines = linesOf(body);
  const own = personalStyle(card);
  const exemplars = (ctx.exemplars ?? []).filter((e) => e.trim());

  // the greeting and the sign-off: theirs when the card is learned or set, or when their sent mail shows them
  const cardGreet = new Set(
    card.greetingPatterns.map((p) => greetingFamily(p)).filter((x): x is string => !!x),
  );
  const cardSign = new Set(
    card.signoffs.map((s) => signoffFamily(firstLine(s))).filter((x): x is string => !!x),
  );
  for (const e of exemplars) {
    const el = linesOf(e);
    const g = el[0] ? greetingFamily(el[0]) : undefined;
    if (g) cardGreet.add(g);
    const at = signoffAt(el);
    if (at >= 0) cardSign.add(signoffFamily(el[at]!)!);
  }
  const knows = own || exemplars.length > 0;
  const greet = lines[0] ? greetingFamily(lines[0]) : undefined;
  if (knows && greet && cardGreet.size && !cardGreet.has(greet))
    problems.push({
      code: 'greeting',
      detail: `It opens with ${greet === 'name' ? 'their name alone' : `'${lines[0]!.split(/[\s,]/)[0]}'`}; you open with ${[...cardGreet].map((g) => (g === 'name' ? 'their name' : `'${g[0]!.toUpperCase()}${g.slice(1)}'`)).join(' or ')}.`,
    });
  const signIdx = signoffAt(lines);
  const sign = signIdx >= 0 ? signoffFamily(lines[signIdx]!) : undefined;
  if (knows && sign && cardSign.size && !cardSign.has(sign))
    problems.push({
      code: 'signoff',
      detail: `It signs off '${lines[signIdx]!.replace(/[,.]$/, '')}'; you sign off ${[...cardSign].map((s) => `'${s[0]!.toUpperCase()}${s.slice(1)}'`).join(' or ')}.`,
    });

  // the sentences of the body itself: not the greeting, the sign-off or the name under it
  const end = signIdx >= 0 ? signIdx : lines.length;
  const middle = lines.slice(greet ? 1 : 0, end).join(' ');
  const sentences = middle
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => wordCount(s) >= 3);
  if (sentences.length >= 3 && card.avgSentenceWords > 0) {
    const avg = sentences.reduce((n, s) => n + wordCount(s), 0) / sentences.length;
    const top = Math.max(card.avgSentenceWords * 1.75, card.avgSentenceWords + 9);
    if (avg > top)
      problems.push({
        code: 'sentence_length',
        detail: `Its sentences run about ${Math.round(avg)} words; yours run about ${Math.round(card.avgSentenceWords)}.`,
      });
    else if (card.avgSentenceWords >= 18 && avg < card.avgSentenceWords * 0.45)
      problems.push({
        code: 'sentence_length',
        detail: `Its sentences run about ${Math.round(avg)} words; yours run about ${Math.round(card.avgSentenceWords)}.`,
      });
  }

  // the phrases they never say, and what their notes say a word search can see
  const said = `${draft.subject ?? ''}\n${body}`;
  for (const a of card.avoid)
    if (has(said, a)) problems.push({ code: 'avoid', detail: `It says '${a.trim()}', which you never say.` });
  const seen = new Set(card.avoid.map((a) => a.trim().toLowerCase()));
  for (const n of activeVoiceNotes(ctx.notes)) {
    const a = avoidOf(n);
    if (a && !seen.has(a.toLowerCase()) && has(said, a)) {
      seen.add(a.toLowerCase());
      problems.push({ code: 'note', detail: `It says '${a}'; ${lowerFirst(n.text.replace(/[.]$/, ''))}.` });
      continue;
    }
    const t = n.text.toLowerCase();
    if (/exclamation/.test(t) && /\b(never|no|cut|drop|without|don'?t)\b/.test(t) && /!/.test(body))
      problems.push({
        code: 'note',
        detail: `It has an exclamation mark; ${lowerFirst(n.text.replace(/[.]$/, ''))}.`,
      });
    else if (
      /emoji/.test(t) &&
      /\b(never|no|cut|drop|without|don'?t)\b/.test(t) &&
      /\p{Extended_Pictographic}/u.test(body)
    )
      problems.push({ code: 'note', detail: `It has an emoji; ${lowerFirst(n.text.replace(/[.]$/, ''))}.` });
    else if (/first name only|only your first name|just your first name/.test(t) && signIdx >= 0) {
      const name = lines[signIdx + 1];
      if (name && name.split(/\s+/).length >= 2 && name.length < 40)
        problems.push({
          code: 'note',
          detail: `It signs with your full name; ${lowerFirst(n.text.replace(/[.]$/, ''))}.`,
        });
    }
  }

  // exclamation marks and emoji the student never uses
  const bangs = (body.match(/!/g) ?? []).length;
  if (card.exclamationsPerMessage < 0.1 && (bangs >= 2 || (own && bangs >= 1)))
    problems.push({ code: 'exclamation', detail: 'It uses exclamation marks; you write without them.' });
  const emoji = (body.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (!card.emoji && (emoji >= 2 || (own && emoji >= 1)))
    problems.push({ code: 'emoji', detail: 'It has emoji; you write without them.' });

  // contractions, one way or the other
  const contracted = (body.match(CONTRACTION) ?? []).length;
  const expanded = (body.match(EXPANDED) ?? []).length;
  if (own && !card.contractions && contracted >= 2)
    problems.push({ code: 'contractions', detail: "It uses contractions like I'm; you write them out." });
  else if (own && card.contractions && contracted === 0 && expanded >= 2 && wordCount(body) >= 40)
    problems.push({ code: 'contractions', detail: 'It writes out I am and do not; you use contractions.' });

  return { ok: problems.length === 0, problems };
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** 0 to 3: how much a draft sounds like the student by the check (3 is no problem at all). */
export function voiceScore(r: VoiceCheckResult): number {
  return Math.max(0, 3 - r.problems.length);
}

/** The mean of a few scores to one decimal, or null with none. */
export function meanVoiceScore(scores: number[]): number | null {
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

// ---- the prompts ------------------------------------------------------------------------------------------------

/** The instructions for distilling edits into notes; the edits and card follow in the user turn. */
export const VOICE_DISTILL_SYSTEM = [
  'You read how a college student edited the networking emails Orbit drafted for them, and write down what the edits show about how they write.',
  `Return at most ${VOICE_NOTES_MAX} notes. Each note is one short line in the second person, in plain words the student would use about themselves, such as "You cut 'Thanks either way' every time" or "You sign with your first name only".`,
  'A note must be backed by at least two edits, and its evidence lists the ids of those edits exactly as given. Leave out anything a single edit shows, anything the style card already says, and anything about a particular person or company.',
  'When a note is about a phrase the student always removes or replaces, put that phrase in `avoid` exactly as Orbit wrote it; otherwise leave `avoid` empty.',
  'Never repeat a note the student forgot, in any wording. Use no dashes and no exclamation marks.',
].join('\n');

/** The user turn: the card, the notes kept and forgotten, and the edits, newest first. */
export function voiceDistillUser(input: {
  card: StyleCard;
  edits: VoiceEdit[];
  kept: string[];
  forgotten: string[];
}): string {
  const clip = (s: string) => (s.length > 1500 ? `${s.slice(0, 1500)}...` : s);
  return [
    `<style_card>\n${cardProse(input.card).join('\n')}\n</style_card>`,
    input.kept.length ? `<kept_notes>\n${input.kept.join('\n')}\n</kept_notes>` : '',
    input.forgotten.length
      ? `<forgotten_notes never_repeat="true">\n${input.forgotten.join('\n')}\n</forgotten_notes>`
      : '',
    '<edits>',
    ...input.edits.map(
      (e) =>
        `<edit id="${e.id}"${e.kind ? ` kind="${e.kind}"` : ''}>\n<orbit_wrote>\n${clip(e.before)}\n</orbit_wrote>\n<student_sent>\n${clip(e.after)}\n</student_sent>\n</edit>`,
    ),
    '</edits>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The judge's instructions (plan 29 §B2.4c), for auto first messages only. */
export const VOICE_JUDGE_SYSTEM = [
  'You compare one draft email against a few emails a college student really sent, and judge whether the same person wrote all of them.',
  'Read the voice, not the topic: greeting and sign-off, sentence length and rhythm, contractions, how direct the ask is, warmth, punctuation, the words they reach for.',
  'Score 0 to 3: 3, clearly the same person; 2, plausibly the same person; 1, probably someone else; 0, clearly someone else. Give the reason in one plain sentence, with no dashes and no exclamation marks.',
].join('\n');

export function voiceJudgeUser(
  draft: { subject?: string | null; body: string },
  exemplars: string[],
): string {
  return [
    '<sent_by_the_student>',
    ...exemplars.map((e, i) => `<email n="${i + 1}">\n${e.slice(0, 1500)}\n</email>`),
    '</sent_by_the_student>',
    `<draft>\n${draft.subject ? `Subject: ${draft.subject}\n` : ''}${draft.body.slice(0, 3000)}\n</draft>`,
  ].join('\n');
}
