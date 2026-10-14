import type {
  Affiliation,
  AuditEntry,
  FeedbackEvent,
  MeetingNote,
  Notification,
  Person,
  TieStrength,
  Touchpoint,
} from '@orbit/core';
import { knowEachOther, newId, pairsFromEdges, tieStrength, warmthValue } from '@orbit/core';
import { db } from './schema';

export const CURRENT_USER_KEY = 'currentUserId';

export async function getCurrentUserId(): Promise<string | undefined> {
  const row = await db.kv.get(CURRENT_USER_KEY);
  return row?.value as string | undefined;
}
export async function setCurrentUserId(id: string): Promise<void> {
  await db.kv.put({ key: CURRENT_USER_KEY, value: id });
}

export async function audit(userId: string, action: string, extra: Partial<AuditEntry> = {}): Promise<void> {
  await db.audit.add({
    id: newId('aud'),
    userId,
    actor: 'user',
    action,
    metadata: {},
    createdAt: new Date().toISOString(),
    ...extra,
  });
}

export async function feedback(
  userId: string,
  kind: FeedbackEvent['kind'],
  extra: Partial<FeedbackEvent> = {},
): Promise<void> {
  await db.feedback.add({ id: newId('fb'), userId, kind, createdAt: new Date().toISOString(), ...extra });
}

export async function notify(
  userId: string,
  kind: Notification['kind'],
  title: string,
  body?: string,
  link?: string,
): Promise<void> {
  await db.notifications.add({
    id: newId('ntf'),
    userId,
    kind,
    title,
    body,
    link,
    createdAt: new Date().toISOString(),
  });
}

/** Insert a touchpoint if not already present for (person, ref). Returns true when inserted. */
export async function addTouchpoint(tp: Omit<Touchpoint, 'id'>): Promise<boolean> {
  const existing = await db.touchpoints
    .where('[personId+refTable+refId]')
    .equals([tp.personId, tp.refTable, tp.refId])
    .first();
  if (existing) return false;
  await db.touchpoints.add({ id: newId('tp'), ...tp });
  return true;
}

/** What the tie score needs to know about the student: their school and city, and where they have worked. */
interface TieContext {
  user?: { school?: string; currentCity?: string };
  userEmployers: { name: string; startDate?: string; endDate?: string }[];
}

async function loadTieContext(userId: string): Promise<TieContext> {
  const [user, resumes] = await Promise.all([
    db.users.get(userId),
    db.resumes.where('userId').equals(userId).toArray(),
  ]);
  const current = resumes.find((r) => r.isCurrent) ?? resumes[0];
  const facets = current ? await db.resumeFacets.where('resumeId').equals(current.id).toArray() : [];
  return {
    user: user ? { school: user.school, currentCity: user.currentCity } : undefined,
    userEmployers: facets
      .filter((f) => f.kind === 'experience' && !f.excluded && f.organizationName)
      .map((f) => ({ name: f.organizationName!, startDate: f.startDate, endDate: f.endDate })),
  };
}

/** Warmth of the student's notes about each person (f13), from the notes' extractions. */
function noteWarmthByPerson(notes: MeetingNote[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const n of notes) {
    if (!n.extraction || n.matchStatus === 'rejected' || n.matchStatus === 'unmatched') continue;
    for (const pid of n.personIds) {
      const arr = out.get(pid) ?? [];
      arr.push(warmthValue(n.extraction.warmth));
      out.set(pid, arr);
    }
  }
  return out;
}

function tieFields(
  r: TieStrength,
): Pick<Person, 'strength' | 'strengthBreakdown' | 'tieScore' | 'tieBand' | 'tieExplanation'> {
  return {
    strength: r.strength,
    strengthBreakdown: r.breakdown,
    tieScore: r.tie.score,
    tieBand: r.tie.band,
    tieExplanation: r.tie.explanation,
  };
}

/**
 * Rescore one person after new contact (plan 16 §3: strength = tie score / 100). The structural feature (how close
 * the student is to this person's contacts) is the nightly run's: the mutuals it kept are reused, not recomputed.
 */
export async function recomputePersonStrength(
  personId: string,
  now = new Date(),
): Promise<Person | undefined> {
  const person = await db.people.get(personId);
  if (!person) return undefined;
  const [tps, affiliations, ctx, notes] = await Promise.all([
    db.touchpoints.where('personId').equals(personId).toArray(),
    db.affiliations.where('personId').equals(personId).toArray(),
    loadTieContext(person.userId),
    db.notes
      .where('userId')
      .equals(person.userId)
      .filter((n) => n.personIds.includes(personId))
      .toArray(),
  ]);
  const mutuals = person.strengthBreakdown?.tieScore?.mutuals ?? [];
  const r = tieStrength(
    {
      person,
      touchpoints: tps,
      affiliations,
      ...ctx,
      noteWarmth: noteWarmthByPerson(notes).get(personId) ?? [],
      mutualScores: mutuals.map((m) => m.score),
      mutualNames: mutuals.map((m) => m.name),
    },
    now,
  );
  const last = r.breakdown.lastInteractionAt;
  const fields = { ...tieFields(r), lastInteractionAt: last, interactionCount: tps.length };
  await db.people.update(personId, { ...fields, updatedAt: now.toISOString() });
  return { ...person, ...fields };
}

/**
 * Rescore everyone (the daily run). The structural feature reads the strengths the previous run left: the mean of
 * the five strongest contacts this person is known to know (they wrote, met or were introduced; not colleagues alone).
 */
export async function recomputeAllStrengths(userId: string, now = new Date()): Promise<void> {
  const [people, tps, affs, edges, notes, ctx] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.touchpoints.where('userId').equals(userId).toArray(),
    db.affiliations.where('userId').equals(userId).toArray(),
    db.edges.where('userId').equals(userId).toArray(),
    db.notes.where('userId').equals(userId).toArray(),
    loadTieContext(userId),
  ]);
  const byPerson = new Map<string, Touchpoint[]>();
  for (const t of tps) {
    const arr = byPerson.get(t.personId) ?? [];
    arr.push(t);
    byPerson.set(t.personId, arr);
  }
  const affsByPerson = new Map<string, Affiliation[]>();
  for (const a of affs) {
    const arr = affsByPerson.get(a.personId) ?? [];
    arr.push(a);
    affsByPerson.set(a.personId, arr);
  }
  const byId = new Map(people.map((p) => [p.id, p]));
  const neighbours = new Map<string, Set<string>>();
  for (const pair of pairsFromEdges(edges).values()) {
    if (!knowEachOther(pair)) continue;
    for (const [x, y] of [
      [pair.aId, pair.bId],
      [pair.bId, pair.aId],
    ] as const) {
      const set = neighbours.get(x) ?? new Set<string>();
      set.add(y);
      neighbours.set(x, set);
    }
  }
  const warmth = noteWarmthByPerson(notes);
  const updates = people.map((p) => {
    const mutuals = [...(neighbours.get(p.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((m): m is Person => !!m && m.isHuman && !m.hiddenAt && m.strength > 0)
      .map((m) => ({ name: m.firstName || m.displayName, score: Math.round(m.strength * 100) }));
    const r = tieStrength(
      {
        person: p,
        touchpoints: byPerson.get(p.id) ?? [],
        affiliations: affsByPerson.get(p.id) ?? [],
        ...ctx,
        noteWarmth: warmth.get(p.id) ?? [],
        mutualScores: mutuals.map((m) => m.score),
        mutualNames: mutuals.map((m) => m.name),
      },
      now,
    );
    return {
      id: p.id,
      changes: {
        ...tieFields(r),
        lastInteractionAt: r.breakdown.lastInteractionAt,
        interactionCount: (byPerson.get(p.id) ?? []).length,
      },
    };
  });
  await db.transaction('rw', db.people, async () => {
    for (const u of updates) await db.people.update(u.id, u.changes);
  });
}
