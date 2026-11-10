/**
 * Plan 38 §E, §G in the browser: the "Answer simple replies for me" switch and each group's funnel. Both are kept in
 * this browser's settings and sent to the server (users.settings.auto_replies, reply_funnels, with the server's person
 * ids), which answers replies for an account. Here, the switch also hands over the ladder's reply kinds (scheduling
 * replies and thank-yous), and a group's words replace an interested reply or a follow-up when Orbit drafts one.
 */
import type { CoffeeChat, MessageKind, Person, ReplyFunnel, User } from '@orbit/core';
import { classifyReply, fillFunnelText, funnelFor, funnelReply } from '@orbit/core';
import { db } from '../db/schema';
import { pushProfileSettings } from './settings';

const REPLY_KINDS: MessageKind[] = ['schedule', 'thank_you'];

export async function autoRepliesOn(userId: string): Promise<boolean> {
  return (await db.settings.get(userId))?.autoReplies === true;
}

export async function setAutoReplies(userId: string, on: boolean): Promise<void> {
  const settings = await db.settings.get(userId);
  const kinds = new Set(settings?.autoKinds ?? []);
  for (const k of REPLY_KINDS) on ? kinds.add(k) : kinds.delete(k);
  const autoKinds = [...kinds];
  await db.settings.update(userId, { autoReplies: on, autoKinds });
  await pushProfileSettings(userId, { autoReplies: on, autoKinds: autoKinds as never });
}

/** The funnels with the server's ids for the people, for an account. */
async function forServer(funnels: ReplyFunnel[]): Promise<ReplyFunnel[]> {
  const { serverIdOf } = await import('./serverSync');
  return funnels.map((f) => ({
    ...f,
    personIds: f.personIds.map((id) => serverIdOf(id)).filter((x): x is string => !!x),
  }));
}

/** Keep (add or replace) one group's funnel, here and on the server. */
export async function saveFunnel(userId: string, funnel: ReplyFunnel): Promise<void> {
  const settings = await db.settings.get(userId);
  const replyFunnels = [...(settings?.replyFunnels ?? []).filter((f) => f.id !== funnel.id), funnel]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-30);
  await db.settings.update(userId, { replyFunnels });
  await pushProfileSettings(userId, { replyFunnels: await forServer(replyFunnels) });
}

export async function funnelOfPerson(userId: string, personId: string): Promise<ReplyFunnel | undefined> {
  return funnelFor((await db.settings.get(userId))?.replyFunnels, personId);
}

/**
 * The words a draft gets under the person's group, when Orbit drafts an interested reply or a follow-up for them; else
 * undefined, and Orbit's own words stand.
 */
export async function funnelWords(
  user: Pick<User, 'id' | 'firstName'>,
  person: Pick<Person, 'id' | 'firstName' | 'currentOrganizationRaw'>,
  kind: MessageKind,
  replyClass?: string,
): Promise<string | undefined> {
  const settings = await db.settings.get(user.id);
  const f = funnelFor(settings?.replyFunnels, person.id);
  if (!f) return undefined;
  const v = {
    first: person.firstName,
    company: person.currentOrganizationRaw,
    link: settings?.schedulingLink,
    signOff: user.firstName,
  };
  if (kind === 'bump') return f.followUp ? fillFunnelText(f.followUp, v) : undefined;
  if (kind === 'reply' && replyClass === 'interested') return funnelReply(f, v);
  return undefined;
}

/** The group's words for a draft Orbit is writing to this person in this chat, when the group has some. */
export async function funnelWordsForDraft(
  user: Pick<User, 'id' | 'firstName' | 'timezone'>,
  person: Pick<Person, 'id' | 'firstName' | 'currentOrganizationRaw'>,
  kind: MessageKind,
  chat: Pick<CoffeeChat, 'personId' | 'threadId'> | undefined,
): Promise<string | undefined> {
  if (kind !== 'bump' && kind !== 'reply') return undefined;
  if (!(await funnelOfPerson(user.id, person.id))) return undefined;
  let cls: string | undefined;
  if (kind === 'reply' && chat) {
    const { latestReply } = await import('./conversation');
    const m = await latestReply(chat);
    if (m)
      cls =
        m.replyClass ??
        classifyReply(m.bodyText, { now: new Date(m.sentAt), timeZone: user.timezone || undefined }).class;
  }
  return funnelWords(user, person, kind, cls);
}
