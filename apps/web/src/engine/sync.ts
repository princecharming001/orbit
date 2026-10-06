import type { User } from '@orbit/core';
import { buildStyleCard, parseAddressList } from '@orbit/core';
import { notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import {
  currentGoogleToken,
  gcalList,
  gmailExtractText,
  gmailGet,
  gmailHeaders,
  gmailListIds,
} from '../integrations/google';
import { generateBrief, recommendationsRefresh } from './brief';
import { recomputeEdges } from './graph';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from './ingest';

function sentAtOf(internalDate: string | undefined, dateHeader: string | undefined): string {
  if (internalDate && Number.isFinite(Number(internalDate)))
    return new Date(Number(internalDate)).toISOString();
  const d = dateHeader ? new Date(dateHeader) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

export interface SyncProgress {
  phase: string;
  done: number;
  total: number;
}

/** Backfill: sent mail (90d) first, then inbox (90d), then calendar (−180d..+90d). Incremental runs use the stored checkpoint. */
export async function syncGoogle(
  user: User,
  opts: { onProgress?: (p: SyncProgress) => void; useLlm?: boolean; days?: number } = {},
): Promise<{ messages: number; events: number }> {
  const token = currentGoogleToken();
  if (!token) throw new Error('Google is not connected.');
  const account = await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'google')
    .first();
  const state = (account?.syncState ?? {}) as { lastSyncAt?: string };
  const days = opts.days ?? 90;
  const since = state.lastSyncAt
    ? Math.max(1, Math.ceil((Date.now() - new Date(state.lastSyncAt).getTime()) / 86_400_000) + 1)
    : days;
  const progress = (phase: string, done: number, total: number) => opts.onProgress?.({ phase, done, total });
  let total = 0;
  for (const [phase, q] of [
    ['Sent mail', `in:sent newer_than:${since}d`],
    ['Inbox', `in:inbox newer_than:${since}d -category:promotions -category:social -category:forums`],
  ] as const) {
    progress(phase, 0, 1);
    const ids = await gmailListIds(q, 1500);
    const raws: RawEmail[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = await Promise.all(
        ids.slice(i, i + 20).map((id) => gmailGet(id, 'full').catch(() => undefined)),
      );
      for (const m of chunk) {
        if (!m) continue;
        const h = gmailHeaders(m);
        const { text } = gmailExtractText(m);
        raws.push({
          externalMessageId: m.id,
          externalThreadId: m.threadId,
          from: h.from ?? '',
          // quoted display names may contain commas ("Doe, Jane" <jane@x.com>)
          to: parseAddressList(h.to),
          cc: parseAddressList(h.cc),
          subject: h.subject,
          sentAt: sentAtOf(m.internalDate, h.date),
          bodyText: text || m.snippet || '',
          headers: h,
          labels: m.labelIds,
        });
      }
      progress(phase, Math.min(i + 20, ids.length), ids.length);
    }
    const stats = await ingestEmails(user, raws, {
      useLlm: opts.useLlm,
      onProgress: (d, t) => progress(`${phase}: understanding threads`, d, t),
    });
    total += stats.messages;
  }
  progress('Calendar', 0, 1);
  const evs = await gcalList(new Date(Date.now() - 180 * 86_400_000), new Date(Date.now() + 90 * 86_400_000));
  const rawEvents: RawEvent[] = evs
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({
      externalEventId: e.id,
      iCalUID: e.iCalUID,
      title: e.summary,
      description: e.description,
      startAt: e.start!.dateTime!,
      endAt: e.end!.dateTime!,
      status: (e.status as RawEvent['status']) ?? 'confirmed',
      attendees: (e.attendees ?? []).map((a) => ({
        email: a.email,
        displayName: a.displayName,
        responseStatus: a.responseStatus,
        self: a.self,
      })),
      conferenceUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.[0]?.uri,
    }));
  const ev = await ingestEvents(user, rawEvents);
  progress('Calendar', 1, 1);
  // style card from sent mail
  const sent = await db.messages
    .where('userId')
    .equals(user.id)
    .filter((m) => m.direction === 'outbound' && !m.isAutomated)
    .toArray();
  if (sent.length >= 5)
    await db.styles.put({
      userId: user.id,
      card: buildStyleCard(
        sent.map((m) => m.bodyText),
        user.firstName,
      ),
      updatedAt: new Date().toISOString(),
    });
  await recomputeAllStrengths(user.id);
  await recomputeEdges(user.id);
  await recommendationsRefresh(user);
  await db.integrations.update(account?.id ?? '', {
    lastSyncedAt: new Date().toISOString(),
    syncState: { ...state, lastSyncAt: new Date().toISOString() },
    status: 'active',
  });
  await notify(
    user.id,
    'system',
    'Google sync finished',
    `${total} messages and ${ev.events} events processed.`,
  );
  return { messages: total, events: ev.events };
}

export async function dailyMaintenance(user: User): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await db.briefs
    .where('userId')
    .equals(user.id)
    .filter((b) => b.kind === 'daily' && b.briefDate === today)
    .first();
  if (existing) return;
  await recomputeAllStrengths(user.id);
  await generateBrief(user, 'daily');
}
