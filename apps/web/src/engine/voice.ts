/**
 * The student's voice in the browser (plan 29 §B2.4, §B5).
 *
 * Keeping the card current: every tenth send learns the card again from what the student wrote (`learnStyle`) and,
 * for an account, gives it to the server through /settings/profile, so the server's drafts and its voice check read
 * the same card this browser drafts with.
 */
import type { StyleCard, User } from '@orbit/core';
import { VOICE_LEARN_EVERY } from '@orbit/core';
import { db } from '../db/schema';
import { isServerUser } from '../integrations/orbitApi';
import { pushProfileSettings } from './settings';
import { learnStyle } from './style';

const sendsKey = (userId: string) => `voice.sends:${userId}`;

/** Give the card this browser drafts with to the server (account mode only); resolves to whether it took it. */
export async function shareStyleCard(userId: string, card?: StyleCard): Promise<boolean> {
  if (!isServerUser(userId)) return false;
  const c = card ?? (await db.styles.get(userId))?.card;
  if (!c) return false;
  return pushProfileSettings(userId, { styleCard: c });
}

/**
 * One more message went out: every VOICE_LEARN_EVERY sends the card is learned again from everything the student
 * wrote, and an account's server gets the new card. Never throws; returns whether it learned this time.
 */
export async function noteSendForVoice(
  user: Pick<User, 'id' | 'firstName'>,
  now = new Date(),
): Promise<boolean> {
  try {
    const key = sendsKey(user.id);
    const had = Number((await db.kv.get(key))?.value) || 0;
    const count = had + 1;
    if (count < VOICE_LEARN_EVERY) {
      await db.kv.put({ key, value: count });
      return false;
    }
    await db.kv.put({ key, value: 0 });
    const r = await learnStyle(user, { now });
    if (!r.ok) return false;
    await shareStyleCard(user.id, r.card);
    return true;
  } catch {
    return false;
  }
}
