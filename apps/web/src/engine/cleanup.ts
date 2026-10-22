/**
 * One-time cleanup of what older versions of Orbit saved from guesses, for a student's own profile (never the demo):
 *
 * - chats Orbit opened from mail that only came in (a cold pitch, a newsletter) the student never wrote back to,
 *   with their proposed stage moves, cards, drafts and "replied" notifications;
 * - the alum label given to anyone who emailed from the student's school domain (staff, professors), when nothing
 *   else says they studied there;
 * - closeness scores, recomputed under the rule that mail that only came in is not a relationship;
 * - the demo's sample rows, when the student moved from the demo to their own profile by signing in.
 *
 * Runs once per profile per cleanup version, recorded in `kv`.
 */
import type { User } from '@orbit/core';
import { recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { DEMO_USER_ID } from './demo';

export const CLEANUP_VERSION = '2026-10-22';
const OUTBOUND = new Set(['email_out', 'linkedin_out', 'text_out', 'meeting', 'manual_log']);

export interface CleanupStats {
  chats: number;
  alumni: number;
  people: number;
  demoRows: number;
}

export async function cleanUpGuesses(user: User, now = new Date()): Promise<CleanupStats | undefined> {
  if (user.id === DEMO_USER_ID) return undefined;
  const key = `cleanup:${CLEANUP_VERSION}:${user.id}`;
  if (await db.kv.get(key)) return undefined;
  const stats: CleanupStats = { chats: 0, alumni: 0, people: 0, demoRows: 0 };

  // 1. chats opened from mail the student never answered
  const detected = await db.chats
    .where('userId')
    .equals(user.id)
    .filter((c) => c.source === 'detected')
    .toArray();
  for (const c of detected) {
    const tps = await db.touchpoints.where('personId').equals(c.personId).toArray();
    const studentActed = tps.some((t) => OUTBOUND.has(t.kind));
    const events = await db.stageEvents.where('chatId').equals(c.id).toArray();
    const studentMoved = events.some(
      (e) => e.actor === 'user' && (e.status === 'applied' || e.status === 'confirmed'),
    );
    if (studentActed || studentMoved) continue;
    await db.transaction(
      'rw',
      [db.chats, db.stageEvents, db.suggestions, db.outbound, db.notifications, db.threads],
      async () => {
        await db.stageEvents.where('chatId').equals(c.id).delete();
        await db.suggestions
          .where('chatId')
          .equals(c.id)
          .filter((s) => s.status === 'pending' || s.status === 'snoozed')
          .delete();
        await db.outbound
          .where('chatId')
          .equals(c.id)
          .filter((o) => o.status === 'draft')
          .delete();
        await db.notifications
          .where('userId')
          .equals(user.id)
          .filter((n) => n.kind === 'reply_received' && !!n.link && n.link.includes(c.personId))
          .delete();
        await db.threads.where('chatId').equals(c.id).modify({ chatId: undefined, isNetworking: false });
        await db.chats.delete(c.id);
      },
    );
    stats.chats++;
  }

  // 2. the alum label from the school's email domain alone
  if (user.school) {
    const labelled = await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !!p.isAlumni && p.school === user.school)
      .toArray();
    for (const p of labelled) {
      const studied = await db.affiliations
        .where('personId')
        .equals(p.id)
        .filter((a) => a.kind === 'education')
        .count();
      if (studied) continue;
      await db.people.update(p.id, { isAlumni: false, school: undefined });
      stats.alumni++;
    }
  }

  // 3. closeness under the new rule
  const ids = await db.people.where('userId').equals(user.id).primaryKeys();
  for (const id of ids) {
    await recomputePersonStrength(id, now);
    stats.people++;
  }

  // 4. the demo's sample rows left behind
  if (await db.users.get(DEMO_USER_ID)) {
    for (const table of db.tables) {
      if (!table.schema.indexes.some((i) => i.name === 'userId')) continue;
      stats.demoRows += await table.where('userId').equals(DEMO_USER_ID).delete();
    }
    await db.users.delete(DEMO_USER_ID);
    await db.settings.delete(DEMO_USER_ID);
    await db.goals.delete(DEMO_USER_ID);
  }

  await db.kv.put({ key, value: { at: now.toISOString(), ...stats } });
  return stats;
}
