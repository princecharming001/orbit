/**
 * Note now, follow up after they accept (the chat's LinkedIn card, plan 38 follow-up): a connection note is short and
 * asks nothing, and the real ask waits for the person to accept. The student writes the follow-up with the note; it
 * is kept here until LinkedIn shows them as a connection, then Orbit drafts it as a LinkedIn message and raises a card
 * ("Priya accepted. Your follow up is ready"). LinkedIn never sends without a tap, so the follow-up waits for one.
 */
import type { OutboundMessage, Suggestion, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../db/schema';

const KEY = 'afteraccept:';

export interface AfterAccept {
  personId: string;
  text: string;
  /** the connection note it follows */
  noteDraftId: string;
  savedAt: string;
}

/** The follow-up the student would send once they accept: their own words, or a short default. */
export function defaultFollowUp(first: string, company?: string): string {
  return `Thanks for connecting, ${first}. Would you have 15 minutes in the next couple of weeks to tell me about your work${company ? ` at ${company}` : ''}? Happy to work around your schedule.`;
}

export async function followUpFor(personId: string): Promise<AfterAccept | undefined> {
  return (await db.kv.get(`${KEY}${personId}`))?.value as AfterAccept | undefined;
}

export async function saveFollowUp(personId: string, text: string, noteDraftId: string): Promise<void> {
  const clean = text.trim();
  if (!clean) {
    await db.kv.delete(`${KEY}${personId}`);
    return;
  }
  await db.kv.put({
    key: `${KEY}${personId}`,
    value: { personId, text: clean, noteDraftId, savedAt: new Date().toISOString() } satisfies AfterAccept,
  });
}

/**
 * Every kept follow-up whose person has accepted (LinkedIn lists them as a connection) after their note went: drafted
 * as a LinkedIn message, with a card. One that was never sent (the note is still a draft) waits; one whose note was
 * dropped is let go.
 */
export async function draftAcceptedFollowUps(user: Pick<User, 'id'>, now = new Date()): Promise<number> {
  const rows = await db.kv.where('key').startsWith(KEY).toArray();
  let n = 0;
  for (const row of rows) {
    const f = row.value as AfterAccept;
    const [person, note] = await Promise.all([db.people.get(f.personId), db.outbound.get(f.noteDraftId)]);
    if (!person || person.userId !== user.id) continue;
    if (!note || note.status === 'cancelled') {
      await db.kv.delete(row.key);
      continue;
    }
    if (note.status !== 'sent' && note.status !== 'handed_off') continue;
    if (!person.linkedinConnectedOn) continue;
    const draft: OutboundMessage = {
      id: newId('out'),
      userId: user.id,
      personId: person.id,
      chatId: note.chatId,
      ...(note.goalId ? { goalId: note.goalId } : {}),
      channel: 'linkedin',
      kind: 'bump',
      toLinkedinUrl: person.linkedinUrl,
      bodyDraft: f.text,
      status: 'draft',
      generatedBy: 'template',
      draftedAt: now.toISOString(),
      createdAt: now.toISOString(),
    };
    const dedupeKey = `afteraccept:${person.id}:${f.noteDraftId}`;
    const raised = await db.transaction('rw', db.suggestions, db.outbound, async () => {
      if (await db.suggestions.where('dedupeKey').equals(dedupeKey).first()) return false;
      await db.outbound.add(draft);
      const card: Suggestion = {
        id: newId('s'),
        userId: user.id,
        kind: 'follow_up_bump',
        status: 'pending',
        dedupeKey,
        personId: person.id,
        chatId: note.chatId,
        outboundMessageId: draft.id,
        priorityScore: 0.85,
        reasonText: `${person.firstName} accepted your request. Your follow up is ready to send.`,
        signals: {},
        payload: { afterAccept: true },
        carriedOver: 0,
        expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
        createdAt: now.toISOString(),
      };
      await db.suggestions.add(card);
      await db.outbound.update(draft.id, { suggestionId: card.id });
      return true;
    });
    await db.kv.delete(row.key);
    if (raised) n++;
  }
  return n;
}
