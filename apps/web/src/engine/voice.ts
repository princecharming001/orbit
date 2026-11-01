/**
 * The student's voice in the browser (plan 29 §B2.4, §B5).
 *
 * Keeping the card current: every tenth send learns the card again from what the student wrote (`learnStyle`) and,
 * for an account, gives it to the server through /settings/profile, so the server's drafts and its voice check read
 * the same card this browser drafts with.
 *
 * Edits: every send whose words the student changed is kept as a typed `draftEdits` row (what Orbit wrote, what
 * went), in both modes; the outbox takes an account's to orbit.draft_edits.
 */
import type { DraftEdit, OutboundMessage, StyleCard, Suggestion, User } from '@orbit/core';
import { newId, VOICE_LEARN_EVERY, wordEditDistance } from '@orbit/core';
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

/**
 * An edited send, typed (plan 29 §B2.4): what Orbit wrote and what the student sent, every time the words changed,
 * whether a card raised the draft or not. For an account the outbox takes it to orbit.draft_edits.
 */
export async function recordEdit(
  userId: string,
  msg: Pick<OutboundMessage, 'id' | 'kind' | 'bodyDraft' | 'bodyFinal'>,
  suggestion?: Pick<Suggestion, 'payload'>,
  now = new Date(),
): Promise<DraftEdit | undefined> {
  const after = (msg.bodyFinal ?? '').trim();
  const before = msg.bodyDraft.trim();
  if (!after || !before || after.replace(/\s+/g, ' ') === before.replace(/\s+/g, ' ')) return undefined;
  const cls = suggestion?.payload?.replyClass;
  const edit: DraftEdit = {
    id: newId('edit'),
    userId,
    draftId: msg.id,
    kind: msg.kind,
    ...(typeof cls === 'string' ? { replyClass: cls } : {}),
    before,
    after,
    distance: wordEditDistance(before, after),
    createdAt: now.toISOString(),
  };
  // one row per draft: sent again after another edit, the newer words replace the older
  const had = await db.draftEdits.where('draftId').equals(msg.id).first();
  if (had) await db.draftEdits.update(had.id, { after, distance: edit.distance });
  else await db.draftEdits.add(edit);
  return had ? { ...had, after, distance: edit.distance } : edit;
}
