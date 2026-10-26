import { type EmailMessage, type RapportReading, replyRapport, type User, type Valence } from '@orbit/core';
import { recomputeAllStrengths, recomputePersonStrength } from '../db/repo';
import { db } from '../db/schema';
import { claudeReachable, llmRapport } from '../integrations/anthropic';
import { isServerUser } from '../integrations/orbitApi';

/**
 * Reply readings in the browser (plan 27). VADER's lexicon (137 KB) loads on the first reply read, not with the app;
 * without it the reading still comes from the cues.
 */
let valence: Promise<Valence | undefined> | undefined;

function loadValence(): Promise<Valence | undefined> {
  valence ??= import('@orbit/core/vader').then((m) => m.vaderValence).catch(() => undefined);
  return valence;
}

/** The lexical reading of one reply from someone to the student; the classifier's reading replaces it later. */
export async function readReply(
  text: string,
  studentFirstName?: string,
  answering?: string,
): Promise<RapportReading> {
  return replyRapport({ text, studentFirstName, answering, valence: await loadValence() });
}

/** Replies refined per run, newest first, and how far back a reply still gets the classifier's reading. */
const REFINE_PER_RUN = 20;
const REFINE_WITHIN_DAYS = 30;

/**
 * Give recent replies that only have the lexical reading the classifier's (plan 27), then rescore the people who
 * wrote them. Runs after each reply check; does nothing when Claude is out of reach or the student turned the tone
 * reading off. Returns how many replies were refined.
 */
export async function refineRapport(userId: string, now = new Date()): Promise<number> {
  if (!claudeReachable('emailTriage', 'rapport')) return 0;
  const settings = await db.settings.get(userId);
  if (settings?.readReplyTone === false) return 0;
  const since = new Date(now.getTime() - REFINE_WITHIN_DAYS * 86_400_000).toISOString();
  const todo = (
    await db.messages
      .where('sentAt')
      .above(since)
      .filter(
        (m) =>
          m.userId === userId &&
          m.direction === 'inbound' &&
          !m.isAutomated &&
          !!m.fromPersonId &&
          m.extraction?.rapport?.by === 'lexical' &&
          m.bodyText.trim().length >= 20,
      )
      .toArray()
  )
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, REFINE_PER_RUN);
  const people = new Set<string>();
  for (const m of todo) {
    const answering = (await db.messages.where('threadId').equals(m.threadId).sortBy('sentAt'))
      .filter((x) => x.direction === 'outbound' && x.sentAt < m.sentAt)
      .at(-1)?.bodyText;
    const reading = await llmRapport(m.bodyText, answering).catch(() => undefined);
    if (!reading) break;
    const fresh = await db.messages.get(m.id);
    if (!fresh?.extraction) continue;
    await db.messages.update(m.id, { extraction: { ...fresh.extraction, rapport: reading } });
    people.add(m.fromPersonId!);
  }
  for (const pid of people) await recomputePersonStrength(pid, now);
  return todo.length && people.size ? people.size : 0;
}

export const RAPPORT_BACKFILL_VERSION = 'rapport-v1';

/**
 * Once per version (plan 27): lexical readings for the replies and post comments stored before readings existed,
 * then everyone rescored. Local mode only; the server backfills account mode. Returns how many were read.
 */
export async function backfillRapport(user: User, now = new Date()): Promise<number | undefined> {
  if (isServerUser(user.id)) return undefined;
  const key = `repair:${RAPPORT_BACKFILL_VERSION}:${user.id}`;
  if (await db.kv.get(key)) return undefined;
  const threads = new Map((await db.threads.where('userId').equals(user.id).toArray()).map((t) => [t.id, t]));
  const messages = await db.messages
    .where('userId')
    .equals(user.id)
    .filter(
      (m) =>
        m.direction === 'inbound' &&
        !m.isAutomated &&
        !!m.fromPersonId &&
        !m.extraction?.rapport &&
        !!m.bodyText.trim() &&
        (threads.get(m.threadId)?.participantPersonIds.length ?? 1) <= 2,
    )
    .toArray();
  const byThread = new Map<string, EmailMessage[]>();
  for (const m of await db.messages.where('userId').equals(user.id).toArray()) {
    if (m.direction !== 'outbound') continue;
    byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  }
  let read = 0;
  for (const m of messages) {
    const answering = (byThread.get(m.threadId) ?? [])
      .filter((x) => x.sentAt < m.sentAt)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
      .at(-1)?.bodyText;
    const rapport = await readReply(m.bodyText, user.firstName, answering);
    await db.messages.update(m.id, {
      extraction: {
        ...(m.extraction ?? {
          proposedTimes: [],
          asksOfUser: [],
          offers: [],
          factsAboutSender: [],
          sentiment: 'neutral',
        }),
        rapport,
      },
    });
    read++;
  }
  const comments = await db.touchpoints
    .where('userId')
    .equals(user.id)
    .filter((t) => t.kind === 'linkedin_comment_in' && !t.rapport && !!t.summary?.includes(': '))
    .toArray();
  for (const t of comments) {
    const text = t.summary!.slice(t.summary!.indexOf(': ') + 2);
    await db.touchpoints.update(t.id, { rapport: await readReply(text) });
    read++;
  }
  if (read) await recomputeAllStrengths(user.id, now);
  await db.kv.put({ key, value: { at: now.toISOString(), read } });
  return read;
}
