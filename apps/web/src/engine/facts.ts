import type { PersonFact } from '@orbit/core';
import { newId } from '@orbit/core';
import { feedback } from '../db/repo';
import { db } from '../db/schema';

/** The kinds of fact a student can type in by hand on a person's page. */
export const MANUAL_FACT_TYPES = [
  'hook',
  'advice',
  'offer',
  'personal',
  'role_detail',
  'background',
] as const;
export type ManualFactType = (typeof MANUAL_FACT_TYPES)[number];

/** Something the student knows about a person, typed in by hand. Drafts of fact-led kinds pick it up. */
export async function addFact(
  userId: string,
  personId: string,
  type: ManualFactType,
  text: string,
  now = new Date(),
): Promise<PersonFact | undefined> {
  const value = text.trim().replace(/\s+/g, ' ');
  if (!value) return undefined;
  const person = await db.people.get(personId);
  if (!person || person.userId !== userId) return undefined;
  const fact: PersonFact = {
    id: newId('f'),
    userId,
    personId,
    type,
    text: value,
    sourceTable: 'manual',
    sourceId: 'manual',
    confidence: 1,
    occurredAt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  await db.facts.add(fact);
  return fact;
}

/** Soft-delete a fact: drafts stop using it, and Undo (restoreFact) brings it back. */
export async function deleteFact(userId: string, factId: string, now = new Date()): Promise<boolean> {
  const f = await db.facts.get(factId);
  if (!f || f.userId !== userId || f.deletedAt) return false;
  await db.facts.update(factId, { deletedAt: now.toISOString() });
  await feedback(userId, 'fact_delete', { refTable: 'facts', refId: factId });
  return true;
}

export async function restoreFact(factId: string): Promise<boolean> {
  const f = await db.facts.get(factId);
  if (!f?.deletedAt) return false;
  await db.facts.update(factId, { deletedAt: undefined });
  return true;
}

/** Tick a promise ("You promised"); a card that reminded about it is closed too. */
export async function markActionItemDone(
  actionItemId: string,
  suggestionId?: string,
  now = new Date(),
): Promise<boolean> {
  const item = await db.actionItems.get(actionItemId);
  if (!item) return false;
  await db.actionItems.update(actionItemId, { status: 'done' });
  if (suggestionId)
    await db.suggestions.update(suggestionId, { status: 'done', decidedAt: now.toISOString() });
  return true;
}

/** Three is the point: more than that and nothing gets asked properly. */
export const MAX_PREP_QUESTIONS = 3;

/** The questions the student picked for the next conversation, at most three, kept on the chat. */
export async function setPrepQuestions(
  chatId: string,
  questions: string[],
  now = new Date(),
): Promise<string[] | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  const next = [...new Set(questions.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_PREP_QUESTIONS);
  await db.chats.update(chatId, { prepQuestions: next, updatedAt: now.toISOString() });
  return next;
}

/** Tick or untick one prep question; a fourth pick is ignored, as on the page. */
export async function togglePrepQuestion(
  chatId: string,
  question: string,
  now = new Date(),
): Promise<string[] | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  const picked = chat.prepQuestions ?? [];
  if (picked.includes(question))
    return setPrepQuestions(
      chatId,
      picked.filter((x) => x !== question),
      now,
    );
  if (picked.length >= MAX_PREP_QUESTIONS) return picked;
  return setPrepQuestions(chatId, [...picked, question], now);
}
