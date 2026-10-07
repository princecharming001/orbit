import type { CalendarEvent, ChatStage, CoffeeChat, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../db/schema';
import { evaluateImmediateSuggestions } from './brief';
import { applyStage, MANUAL_EVENT_PREFIX } from './stages';

/**
 * The student moves a chat themselves (the board, the table, the person page). What the new stage calls for shows up
 * at once: a chat moved to Completed gets its thank-you card now, not at the next brief.
 */
export async function moveChat(
  user: Pick<User, 'id'>,
  chat: CoffeeChat,
  to: ChatStage,
  reason: string,
): Promise<'applied' | 'proposed' | 'rejected'> {
  const r = await applyStage(chat, to, 'user', reason);
  if (r === 'applied')
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: chat.personId }).catch(
      () => undefined,
    );
  return r;
}

/** The chat's upcoming meeting, from the calendar or entered by hand. */
export async function upcomingMeeting(
  chat: CoffeeChat,
  now = new Date(),
): Promise<CalendarEvent | undefined> {
  const evs = await db.events
    .where('userId')
    .equals(chat.userId)
    .filter(
      (e) =>
        e.status !== 'cancelled' &&
        (e.chatId === chat.id || e.attendeePersonIds.includes(chat.personId)) &&
        new Date(e.endAt).getTime() > now.getTime(),
    )
    .toArray();
  return evs.sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
}

/**
 * "When is the chat?" without a connected calendar: the time the student typed becomes a meeting Orbit knows about,
 * so it shows under Upcoming, gets a prep card the day before, and the chat moves to Completed once it has passed.
 */
export async function scheduleChatAt(
  user: Pick<User, 'id'>,
  chat: CoffeeChat,
  startAt: Date,
  minutes = 30,
  now = new Date(),
): Promise<CalendarEvent> {
  const person = await db.people.get(chat.personId);
  const existing = chat.scheduledEventId ? await db.events.get(chat.scheduledEventId) : undefined;
  const id = existing?.externalEventId.startsWith(MANUAL_EVENT_PREFIX) ? existing.id : newId('ev');
  const ev: CalendarEvent = {
    id,
    userId: user.id,
    externalEventId: `${MANUAL_EVENT_PREFIX}${id}`,
    title: `Coffee chat with ${person?.displayName ?? 'them'}`,
    startAt: startAt.toISOString(),
    endAt: new Date(startAt.getTime() + minutes * 60_000).toISOString(),
    status: 'confirmed',
    attendees: person?.primaryEmail ? [{ email: person.primaryEmail, displayName: person.displayName }] : [],
    attendeePersonIds: [chat.personId],
    isCoffeeChat: true,
    coffeeChatConfidence: 1,
    chatId: chat.id,
  };
  await db.events.put(ev);
  await db.chats.update(chat.id, { scheduledEventId: ev.id, updatedAt: now.toISOString() });
  const fresh = (await db.chats.get(chat.id))!;
  if (fresh.stage !== 'scheduled') await applyStage(fresh, 'scheduled', 'user', 'user:scheduled', { now });
  await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: chat.personId }, now).catch(
    () => undefined,
  );
  return ev;
}
