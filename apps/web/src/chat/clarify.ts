/**
 * Plan 37 §3: one short question when a name in the ask fits several things. A tool that finds two referents returns
 * `clarifyResult(...)` instead of guessing; the card shows the options as buttons; a tap sends `pickMessage(...)` as the
 * student's next turn. The student sees only the label ("Triumph Law"); the bracket carries the id, the words that were
 * unclear and the ask to finish, for the model and the no-key router alike.
 */
import { orgKey } from '@orbit/core/search';
import type { ClarifyAbout, ClarifyData, Resolution, ResultEnvelope } from './types';

/** What the model reads instead of the options' details: ask, then stop. */
export const CLARIFY_INSTRUCTION =
  'The ask fits several things, so nothing ran. Write one short question that names the choices in a clause ("Triumph Law or Triumph Education Group?") and stop. Do not describe, compare or pick between them, answer for one of them, or offer next steps. The choices are under your line as buttons; the student taps one and the ask runs again with it.';

const ABOUT_WORD: Record<ClarifyAbout, string> = { company: 'company', person: 'person', draft: 'draft' };

export function clarifyResult(
  about: ClarifyAbout,
  term: string,
  options: ClarifyData['options'],
  question = about === 'draft' ? 'Which draft?' : `Which ${term.trim()}?`,
): ResultEnvelope<{ ui: ClarifyData; forModel: unknown }> {
  const ui: ClarifyData = { about, term: term.trim(), question, options };
  const names = options.map((o) => o.label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
  return {
    kind: 'clarify',
    data: {
      ui,
      forModel: {
        clarify: true,
        question,
        choices: options.map((o) => (o.sub ? `${o.label} (${o.sub})` : o.label)),
        howToAnswer: CLARIFY_INSTRUCTION,
      },
    },
    summary: `"${ui.term}" fits ${options.length} ${ABOUT_WORD[about]}s: ${list}. Asked which one.`,
  };
}

/** The bracket a pick carries. Ids are URI-encoded so a company named by its words still fits in one token. */
const PICK = /\s*\[picked (company|person|draft) (\S+) for "([^"]*)"(?::\s*([^\]]*))?\]/;

/** The student's next turn after tapping an option: the label they see, the bracket the model and router read. */
export function pickMessage(
  about: ClarifyAbout,
  term: string,
  option: { id: string; label: string },
  ask?: string,
): string {
  const clean = (s: string) =>
    s
      .replace(/[[\]"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const tail = ask?.trim() ? `: ${clean(ask).slice(0, 240)}` : '';
  return `${option.label} [picked ${about} ${encodeURIComponent(option.id)} for "${clean(term)}"${tail}]`;
}

export interface Pick {
  about: ClarifyAbout;
  id: string;
  term: string;
  label: string;
  /** the ask the question interrupted, when the card knew it */
  ask?: string;
}

export function parsePick(text: string): Pick | undefined {
  const m = PICK.exec(text);
  if (!m) return undefined;
  let id = m[2]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    // a hand-typed bracket: keep it as written
  }
  return {
    about: m[1] as ClarifyAbout,
    id,
    term: m[3]!.trim(),
    label: text.slice(0, m.index).trim(),
    ask: m[4]?.trim() || undefined,
  };
}

/** The words of a message without a pick's bracket. */
export const withoutPick = (text: string) => text.replace(PICK, '').trim();

/** The data of a clarify envelope, read defensively (an old row, a hand-made test envelope). */
export function readClarify(d: unknown): ClarifyData | undefined {
  const o = (d && typeof d === 'object' ? d : {}) as { ui?: unknown };
  const u = (o.ui && typeof o.ui === 'object' ? o.ui : o) as Partial<ClarifyData>;
  if (!u.about || !Array.isArray(u.options)) return undefined;
  const options = u.options.filter(
    (x): x is ClarifyData['options'][number] =>
      !!x && typeof x.id === 'string' && typeof x.label === 'string' && !!x.label.trim(),
  );
  if (options.length < 2) return undefined;
  return {
    about: u.about,
    term: typeof u.term === 'string' ? u.term : '',
    question: typeof u.question === 'string' && u.question.trim() ? u.question : 'Which one?',
    options,
  };
}

/** The key a pick is remembered under: a company's orgKey ("Triumph, Inc." and "triumph" agree), else the words. */
export function resolutionTerm(about: ClarifyAbout, term: string): string {
  return about === 'company' ? orgKey(term) : term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** What a pick means for the rest of the conversation. */
export function resolutionOf(pick: Pick, organizationId?: string): Resolution {
  return {
    about: pick.about,
    term: resolutionTerm(pick.about, pick.term),
    id: pick.id,
    label: pick.label,
    organizationId,
  };
}

/** The words the no-key router should read for a message: a pick finishes the ask it interrupted. */
export function routedText(text: string): string {
  const pick = parsePick(text);
  if (!pick) return text;
  if (!pick.ask) return pick.label;
  // the router reads names itself: the words that fit several things become the one picked ("Lena" is Lena Novak)
  const esc = pick.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${esc}\\b`, 'i');
  return pick.term && re.test(pick.ask) ? pick.ask.replace(re, pick.label) : pick.ask;
}
