import type { AuditEntry, FeedbackEvent, Notification, Person, Touchpoint } from '@orbit/core';
import { computeStrength, newId } from '@orbit/core';
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

export async function recomputePersonStrength(
  personId: string,
  now = new Date(),
): Promise<Person | undefined> {
  const person = await db.people.get(personId);
  if (!person) return undefined;
  const tps = await db.touchpoints.where('personId').equals(personId).toArray();
  const { strength, breakdown } = computeStrength(tps, now);
  const last = breakdown.lastInteractionAt;
  await db.people.update(personId, {
    strength,
    strengthBreakdown: breakdown,
    lastInteractionAt: last,
    interactionCount: tps.length,
    updatedAt: now.toISOString(),
  });
  return {
    ...person,
    strength,
    strengthBreakdown: breakdown,
    lastInteractionAt: last,
    interactionCount: tps.length,
  };
}

export async function recomputeAllStrengths(userId: string, now = new Date()): Promise<void> {
  const people = await db.people.where('userId').equals(userId).toArray();
  const tps = await db.touchpoints.where('userId').equals(userId).toArray();
  const byPerson = new Map<string, Touchpoint[]>();
  for (const t of tps) {
    const arr = byPerson.get(t.personId) ?? [];
    arr.push(t);
    byPerson.set(t.personId, arr);
  }
  await db.transaction('rw', db.people, async () => {
    for (const p of people) {
      const { strength, breakdown } = computeStrength(byPerson.get(p.id) ?? [], now);
      await db.people.update(p.id, {
        strength,
        strengthBreakdown: breakdown,
        lastInteractionAt: breakdown.lastInteractionAt,
        interactionCount: (byPerson.get(p.id) ?? []).length,
      });
    }
  });
}
