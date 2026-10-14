/**
 * The 0–100 tie score as the student sees it (plan 16 §3): "78 · Strong", the sentences that explain it, and the
 * student's own 1–5 rating ("Not right?"), which wins until there is new contact. Local mode reads the score the
 * browser computed; account mode asks orbit-api, which scores from the whole mailbox.
 */
import type { Person, User } from '@orbit/core';
import { TIE_BAND_LABELS, TIE_LABEL_MIDPOINTS, type TieBand, tieBand } from '@orbit/core';
import { db, type TieLabelRow } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';

export type Closeness = 1 | 2 | 3 | 4 | 5;

/** The five answers to "how close are you?", in the student's words. */
export const CLOSENESS_LABELS: Record<Closeness, string> = {
  1: 'Barely know them',
  2: 'Know them a little',
  3: 'Friendly',
  4: 'Good friends',
  5: 'Very close',
};

export interface ScoreView {
  personId: string;
  score: number;
  band: TieBand;
  bandLabel: string;
  /** "78 · Strong" */
  label: string;
  explanation: string[];
  /** the student's rating, when they gave one; the score shown is then its band's midpoint */
  labelled?: Closeness;
  /** the model's own score, when a rating overrides it */
  modelScore?: number;
  source: 'server' | 'local';
}

function view(
  personId: string,
  score: number,
  explanation: string[],
  source: ScoreView['source'],
  label?: TieLabelRow,
  band?: string,
): ScoreView {
  const model = Math.max(0, Math.min(100, Math.round(score)));
  const shown = label ? TIE_LABEL_MIDPOINTS[label.closeness]! : model;
  const b = (label ? tieBand(shown) : ((band as TieBand) ?? tieBand(shown))) as TieBand;
  const bandLabel = TIE_BAND_LABELS[b] ?? TIE_BAND_LABELS[tieBand(shown)];
  return {
    personId,
    score: shown,
    band: b,
    bandLabel,
    label: `${shown} · ${bandLabel}`,
    explanation: label
      ? [`You rated them "${CLOSENESS_LABELS[label.closeness].toLowerCase()}"`, ...explanation]
      : explanation,
    labelled: label?.closeness,
    modelScore: label ? model : undefined,
    source,
  };
}

/** The score from what this browser holds: the tie score, or strength × 100 for older rows. */
export function localScore(person: Person): { score: number; explanation: string[]; band?: string } {
  const score =
    person.tieScore ?? person.strengthBreakdown?.tieScore?.score ?? Math.round(person.strength * 100);
  const explanation = person.tieExplanation ?? person.strengthBreakdown?.tieScore?.explanation ?? [];
  return { score, explanation, band: person.tieBand };
}

/** The score, band and explanation for one person. */
export async function explainScore(
  user: Pick<User, 'id'>,
  personId: string,
): Promise<{ ok: true; view: ScoreView } | { ok: false; message: string }> {
  const person = await db.people.get(personId);
  if (!person || person.userId !== user.id)
    return { ok: false, message: 'Orbit has no person with that id. Search for them first.' };
  const label = await db.tieLabels.get(personId);
  if (isServerUser(user.id)) {
    const r = await callApi('/scores/explain', { personId });
    if (r.ok) {
      const lab = r.value.labelled
        ? ({ ...label, personId, userId: user.id, closeness: r.value.labelled, updatedAt: '' } as TieLabelRow)
        : label;
      return {
        ok: true,
        view: view(personId, r.value.score, r.value.explanation, 'server', lab, r.value.band),
      };
    }
    if (r.reason !== 'network' && r.reason !== 'unconfigured') return { ok: false, message: r.message };
    // the server cannot be reached: the copy the last pull brought is still right
  }
  const s = localScore(person);
  return { ok: true, view: view(personId, s.score, s.explanation, 'local', label, s.band) };
}

/** The same view, synchronously, from a person row and their rating (the person page renders with it). */
export function scoreViewOf(person: Person, label?: TieLabelRow): ScoreView {
  const s = localScore(person);
  return view(person.id, s.score, s.explanation, 'local', label, s.band);
}

/** Save the student's rating of how close they are. */
export async function rateCloseness(
  user: Pick<User, 'id'>,
  personId: string,
  closeness: Closeness,
  now = new Date(),
): Promise<{ ok: true; view: ScoreView } | { ok: false; message: string }> {
  const person = await db.people.get(personId);
  if (!person || person.userId !== user.id)
    return { ok: false, message: 'Orbit has no person with that id. Search for them first.' };
  const row: TieLabelRow = {
    personId,
    userId: user.id,
    closeness,
    modelScore: localScore(person).score,
    updatedAt: now.toISOString(),
  };
  if (isServerUser(user.id)) {
    const r = await callApi('/scores/label', { personId, closeness });
    if (!r.ok) return { ok: false, message: r.message };
    // the server has it: kept here without queueing it to go up again
    await writeFromServer('tie_labels', [row as unknown as Record<string, unknown>], user.id);
  } else await db.tieLabels.put(row);
  return { ok: true, view: scoreViewOf(person, row) };
}

/**
 * Ten people to rate in setup (§3.5): spread across the scores, so the ratings say something about every band, and
 * only people the student has a tie with.
 */
export async function peopleToRate(userId: string, n = 10): Promise<Person[]> {
  const [people, labels] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.tieLabels.where('userId').equals(userId).toArray(),
  ]);
  const rated = new Set(labels.map((l) => l.personId));
  const pool = people
    .filter((p) => p.isHuman && !p.hiddenAt && !rated.has(p.id) && localScore(p).score > 0)
    .sort((a, b) => localScore(b).score - localScore(a).score || a.displayName.localeCompare(b.displayName));
  if (pool.length <= n) return pool;
  const out: Person[] = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.round((i * (pool.length - 1)) / (n - 1))]!);
  return out;
}
