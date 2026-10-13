import type {
  CoffeeChat,
  MessageKind,
  OutboundMessage,
  Person,
  ReachPath,
  Suggestion,
  User,
} from '@orbit/core';
import { composeKindFor, newId } from '@orbit/core';
import { db } from '../db/schema';
import { draftForSuggestion, draftMessage, needsWarmUp, startWarmUpOrOutreach, unsentDraftOf } from './brief';
import { currentResumeFacets, sharesOrgNow } from './resume';

// ---------- the student's edits ----------

/** Write the student's edits to a draft that is still a draft; the suggested text itself is never stored twice. */
export function saveDraftEdits(draft: OutboundMessage, body: string, subject: string): Promise<unknown> {
  const changedBody = body !== (draft.bodyFinal ?? draft.bodyDraft);
  const changedSubject = subject !== (draft.subject ?? '');
  if (!changedBody && !changedSubject) return Promise.resolve();
  return db.outbound
    .where('id')
    .equals(draft.id)
    .filter((m) => m.status === 'draft')
    .modify({
      bodyFinal: body.trim() === draft.bodyDraft.trim() ? undefined : body,
      ...(changedSubject ? { subject: subject || undefined } : {}),
    })
    .catch(() => undefined);
}

/** Set a draft's text by id (the chat's edit): the body, the subject, or both. */
export async function setDraftText(
  draftId: string,
  changes: { body?: string; subject?: string },
): Promise<OutboundMessage | undefined> {
  const draft = await db.outbound.get(draftId);
  if (draft?.status !== 'draft') return undefined;
  await saveDraftEdits(
    draft,
    changes.body ?? draft.bodyFinal ?? draft.bodyDraft,
    changes.subject ?? draft.subject ?? '',
  );
  return db.outbound.get(draftId);
}

/** "Reset to suggested": the student's edits go, Orbit's text stays. */
export async function resetDraftToSuggested(draftId: string): Promise<boolean> {
  const n = await db.outbound
    .where('id')
    .equals(draftId)
    .filter((m) => m.status === 'draft')
    .modify({ bodyFinal: undefined, bodyFinalHash: undefined });
  return n > 0;
}

/** "Undo changes": put the text back to what the editor showed when it opened. */
export async function restoreDraftText(
  draft: Pick<OutboundMessage, 'id' | 'bodyDraft'>,
  opened: { body: string; subject: string },
): Promise<unknown> {
  return db.outbound
    .where('id')
    .equals(draft.id)
    .filter((m) => m.status === 'draft')
    .modify({
      bodyFinal: opened.body.trim() === draft.bodyDraft.trim() ? undefined : opened.body,
      subject: opened.subject || undefined,
    });
}

/** Drop a draft the student started or a card's draft. Only a draft can be discarded; Undo is restoreDraft. */
export async function discardDraft(draftId: string): Promise<boolean> {
  const n = await db.outbound
    .where('id')
    .equals(draftId)
    .filter((m) => m.status === 'draft')
    .modify({ status: 'cancelled' });
  return n > 0;
}

export async function restoreDraft(draftId: string): Promise<boolean> {
  const n = await db.outbound
    .where('id')
    .equals(draftId)
    .filter((m) => m.status === 'cancelled')
    .modify({ status: 'draft' });
  return n > 0;
}

/** A snoozed card comes back to Today now instead of on its day. */
export async function unsnoozeSuggestion(suggestionId: string): Promise<boolean> {
  const s = await db.suggestions.get(suggestionId);
  if (s?.status !== 'snoozed') return false;
  await db.suggestions.update(suggestionId, { status: 'pending', snoozedUntil: undefined });
  return true;
}

/** "Open prep" on a Prep card: the card is done once the student has looked. */
export async function markPrepOpened(suggestionId: string, now = new Date()): Promise<boolean> {
  const s = await db.suggestions.get(suggestionId);
  if (s?.status !== 'pending') return false;
  await db.suggestions.update(suggestionId, { status: 'done', decidedAt: now.toISOString() });
  return true;
}

// ---------- "Write to X" ----------

/** The chat's thread, as the kind picker reads it: their last message and what it asked. */
export async function lastInboundOf(chat: CoffeeChat | undefined) {
  if (!chat?.threadId) return undefined;
  const msgs = await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt');
  const m = [...msgs].reverse().find((x) => x.direction === 'inbound');
  return m
    ? {
        lastInboundAt: m.sentAt,
        lastInboundBody: m.bodyText,
        lastSignal: m.signal,
        asksOfUser: m.extraction?.asksOfUser,
        proposedTimes: m.extraction?.proposedTimes,
      }
    : undefined;
}

/** The person's live chat: the one not archived, else the newest. */
export async function liveChatOf(personId: string): Promise<CoffeeChat | undefined> {
  const chats = await db.chats.where('personId').equals(personId).toArray();
  return chats.find((c) => c.stage !== 'archived') ?? chats[0];
}

/** What to write to someone next, from where the chat stands and what the thread says: a kind, or a wait. */
export async function nextMessageKind(
  user: Pick<User, 'timezone'>,
  personId: string,
  now = new Date(),
): Promise<ReturnType<typeof composeKindFor> & { chat?: CoffeeChat }> {
  const chat = await liveChatOf(personId);
  const next = composeKindFor(chat, now, { lastInbound: await lastInboundOf(chat), timezone: user.timezone });
  return { ...next, chat };
}

export type ComposeOutcome =
  /** a draft to edit and send (a draft already started for this kind is reopened, never written twice) */
  | { kind: 'draft'; draft: OutboundMessage; reopened: boolean }
  /** a LinkedIn warm-up started instead of a first message; its first step is in Drafts */
  | { kind: 'warmup_started'; chat: CoffeeChat }
  /** a cold LinkedIn-only contact: the student chooses between a warm-up and writing now before anything starts */
  | { kind: 'warmup_choice' }
  | { kind: 'no_person' };

/**
 * Create (or reopen) a draft of a given kind for a person, the way the person page's "Write to" does it: a draft
 * already started is reopened; a first message to a cold LinkedIn-only stranger asks about the warm-up first
 * (unless `confirmed`); a first message with no chat, or in a warm-up being skipped, goes through
 * startWarmUpOrOutreach; anything else is drafted in the person's chat.
 */
export async function composeDraft(
  user: User,
  personId: string,
  kind: MessageKind,
  opts: { skipWarmUp?: boolean; confirmed?: boolean; chat?: CoffeeChat | null } = {},
): Promise<ComposeOutcome> {
  const person = await db.people.get(personId);
  if (!person) return { kind: 'no_person' };
  const channel = person.primaryEmail ? 'gmail' : 'linkedin';
  const chat = opts.chat === undefined ? await liveChatOf(personId) : (opts.chat ?? undefined);
  const started = await unsentDraftOf(personId, kind);
  if (started) return { kind: 'draft', draft: started, reopened: true };
  if (kind === 'outreach' && !chat && !opts.confirmed) {
    const settings = await db.settings.get(user.id);
    if (
      needsWarmUp(
        person,
        channel,
        settings?.warmUpEnabled ?? true,
        sharesOrgNow(person, await currentResumeFacets(user.id)),
      )
    )
      return { kind: 'warmup_choice' };
  }
  if (kind === 'outreach' && (!chat || (chat.stage === 'warming' && opts.skipWarmUp))) {
    const r = await startWarmUpOrOutreach(user, personId, channel, 'manual', { skipWarmUp: opts.skipWarmUp });
    if (!r.draft) return { kind: 'warmup_started', chat: r.chat! };
    return { kind: 'draft', draft: r.draft, reopened: false };
  }
  const draft = await draftMessage(user, personId, kind, channel, chat?.id);
  return { kind: 'draft', draft, reopened: false };
}

// ---------- intro requests from the Map ----------

/**
 * "Ask X for an intro": the first hop of a route becomes an intro-request card for that person, drafted at once.
 * The same pair is never asked twice (dedupeKey intro:<connector>:<target>).
 */
export async function requestIntro(
  user: User,
  connectorId: string,
  targetId: string,
  opts: { path?: Pick<ReachPath, 'score'>; now?: Date } = {},
): Promise<{ suggestion: Suggestion; draft?: OutboundMessage; existed: boolean } | undefined> {
  const [connector, target] = await Promise.all([db.people.get(connectorId), db.people.get(targetId)]);
  if (!connector || !target) return undefined;
  const now = opts.now ?? new Date();
  const dedupeKey = `intro:${connectorId}:${target.id}`;
  const existing = await db.suggestions.where('dedupeKey').equals(dedupeKey).first();
  if (existing) {
    const draft = existing.outboundMessageId ? await db.outbound.get(existing.outboundMessageId) : undefined;
    return { suggestion: existing, draft, existed: true };
  }
  const s: Suggestion = {
    id: newId('s'),
    userId: user.id,
    kind: 'intro_request',
    personId: connectorId,
    priorityScore: 0.55,
    reasonText: `Ask ${connector.firstName} to introduce you to ${target.displayName}`,
    signals: { path: opts.path?.score ?? 0 },
    payload: {
      target: {
        name: target.displayName,
        title: target.currentTitle,
        org: target.currentOrganizationRaw,
        why: target.currentOrganizationRaw ? `their work at ${target.currentOrganizationRaw}` : undefined,
      },
      channel: connector.primaryEmail ? 'gmail' : 'linkedin',
    },
    status: 'pending',
    dedupeKey,
    carriedOver: 0,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    createdAt: now.toISOString(),
  };
  await db.suggestions.add(s);
  const draft = await draftForSuggestion(user, s, now);
  return { suggestion: s, draft, existed: false };
}

/** The person a draft is to, for the words around it. */
export async function personOfDraft(draft: Pick<OutboundMessage, 'personId'>): Promise<Person | undefined> {
  return db.people.get(draft.personId);
}
