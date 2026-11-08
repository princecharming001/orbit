/**
 * The student's typing habit per channel (packages/core drafts/typing): read from their newest sent messages here,
 * kept a few minutes so a batch of drafts reads the history once.
 */
import { applyTyping, learnTyping, TYPING_SAMPLES, type TypingStyle, type User } from '@orbit/core';
import { db } from '../db/schema';

const KEEP_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; style: TypingStyle | undefined }>();

export async function typingStyle(
  userId: string,
  channel: 'gmail' | 'linkedin',
): Promise<TypingStyle | undefined> {
  const key = `${userId}:${channel}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.style;
  const sent = await db.messages
    .orderBy('sentAt')
    .reverse()
    .filter(
      (m) =>
        m.userId === userId &&
        m.direction === 'outbound' &&
        (m.channel ?? 'gmail') === channel &&
        !m.isAutomated &&
        !!m.bodyText,
    )
    .limit(TYPING_SAMPLES * 2)
    .toArray();
  const user = await db.users.get(userId);
  const style = learnTyping(
    sent.map((m) => m.bodyText),
    user?.firstName,
  );
  cache.set(key, { at: Date.now(), style });
  return style;
}

/** A draft body in the student's casing for the channel it goes out on. */
export async function inTheirTyping(
  user: Pick<User, 'id' | 'firstName'>,
  channel: 'gmail' | 'linkedin',
  body: string,
): Promise<string> {
  const style = await typingStyle(user.id, channel).catch(() => undefined);
  return applyTyping(body, style, { channel, firstName: user.firstName });
}

export function resetTypingForTests(): void {
  cache.clear();
}
