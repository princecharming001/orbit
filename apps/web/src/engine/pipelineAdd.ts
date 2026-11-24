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

const UUID_IN_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** A row's id without the prefix this browser gives the rows it makes: `c_<uuid>` and `<uuid>` are one row. */
const sameRowKey = (id: string) => UUID_IN_ID.exec(id)?.[1]?.toLowerCase() ?? id;

/**
 * The cards the board draws: one for each person. A person has one open card at a time (addToPipeline), so a second
 * open chat for them is a double (the same card stored twice, or two made in a race), and the board shows the one
 * touched last. Closed chats are history and all stay, except the same chat stored twice.
 */
export function oneCardEach<T extends Pick<CoffeeChat, 'id' | 'personId' | 'stage' | 'updatedAt'>>(
  chats: T[],
): T[] {
  const newest = (a: T, b: T) => ((b.updatedAt ?? '') > (a.updatedAt ?? '') ? b : a);
  const open = new Map<string, T>();
  const closed = new Map<string, T>();
  for (const c of chats) {
    const isClosed = c.stage === 'archived';
    const key = isClosed ? sameRowKey(c.id) : sameRowKey(c.personId);
    const into = isClosed ? closed : open;
    const had = into.get(key);
    into.set(key, had ? newest(had, c) : c);
  }
  const kept = new Set([...open.values(), ...closed.values()]);
  return chats.filter((c) => kept.has(c));
}
