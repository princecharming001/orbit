/**
 * Put someone on the student's pipeline at "To contact" (a chat at `identified`), the way Add a person, a LinkedIn
 * search pick and the chat all do it. Someone already on it keeps their card and its stage; only an archived chat is
 * left behind for a new one.
 */
import type { Channel, CoffeeChat, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../db/schema';

export async function addToPipeline(
  user: Pick<User, 'id'>,
  personId: string,
  opts: { source?: CoffeeChat['source']; channel?: Channel; reason?: string; now?: Date } = {},
): Promise<{ chat: CoffeeChat; added: boolean } | undefined> {
  const person = await db.people.get(personId);
  if (!person || person.userId !== user.id) return undefined;
  const open = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => c.stage !== 'archived')
    .first();
  if (open) return { chat: open, added: false };
  const at = (opts.now ?? new Date()).toISOString();
  const channel: Channel =
    opts.channel ?? (person.primaryEmail ? 'gmail' : person.linkedinUrl ? 'linkedin' : 'gmail');
  const chat: CoffeeChat = {
    id: newId('c'),
    userId: user.id,
    personId,
    organizationId: person.currentOrganizationId,
    stage: 'identified',
    stageEnteredAt: at,
    source: opts.source ?? 'manual',
    goalTags: [],
    outreachChannel: channel,
    bumpCount: 0,
    priority: 2,
    createdAt: at,
    updatedAt: at,
  };
  await db.chats.add(chat);
  await db.stageEvents.add({
    id: newId('se'),
    userId: user.id,
    chatId: chat.id,
    toStage: 'identified',
    status: 'applied',
    actor: 'user',
    reason: opts.reason ?? 'user:added',
    createdAt: at,
    decidedAt: at,
  });
  return { chat, added: true };
}
