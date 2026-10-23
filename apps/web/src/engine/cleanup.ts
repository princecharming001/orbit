/**
 * One-time cleanup of what older versions of Orbit saved from guesses, for a student's own profile (never the demo):
 *
 * - chats Orbit opened from mail that only came in (a cold pitch, a newsletter) the student never wrote back to,
 *   with their proposed stage moves, cards, drafts and "replied" notifications;
 * - the alum label given to anyone who emailed from the student's school domain (staff, professors), when nothing
 *   else says they studied there (engine/alumni.ts: the school itself stays);
 * - closeness scores, recomputed under the rule that mail that only came in is not a relationship;
 * - the demo's sample rows, when the student moved from the demo to their own profile by signing in.
 *
 * Runs once per profile per cleanup version, recorded in `kv`; then the later repairs (engine/repair.ts), which have
 * their own versions.
 */
import type { User } from '@orbit/core';
import { recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { recomputeAlumni } from './alumni';
import { DEMO_USER_ID } from './demo';
import { repairClaims } from './repair';

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
  if (await db.kv.get(key)) {
    // the later repairs (engine/repair.ts) run on every visit, with their own versions
    await repairClaims(user, now);
    return undefined;
  }
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

  // 2. the alum label from the school's email domain alone: set again from evidence (engine/alumni.ts), keeping the
  // school itself (a classmate or a professor is at the student's school, just not an alum)
  if (user.school) stats.alumni = (await recomputeAlumni(user, now)).lost.length;

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
  await repairClaims(user, now);
  return stats;
}
