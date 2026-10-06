import type { User } from '@orbit/core';
import { buildStyleCard } from '@orbit/core';
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

export interface SyncProgress {
  phase: string;
  done: number;
  total: number;
}

/** A message whose download failed is retried on later syncs this many times in total, then skipped. */
export const MAX_FETCH_ATTEMPTS = 5;

interface GoogleSyncState {
  /** start time of the last completed sync; the next run lists mail newer than this (plus a day) */
  lastSyncAt?: string;
  /** Gmail message ids whose download failed, with the number of failed attempts so far */
  failedIds?: Record<string, number>;
}

/** Message time: Gmail's internalDate, else the Date header, else now (never throws on a bad header). */
export function messageSentAt(
  internalDate: string | undefined,
  dateHeader: string | undefined,
  now = new Date(),
): string {
  const ms = Number(internalDate);
  if (internalDate && Number.isFinite(ms)) return new Date(ms).toISOString();
  const d = new Date(dateHeader ?? '');
  return Number.isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
}

/**
 * Backfill: sent mail (90d) first, then inbox (90d), then calendar (−180d..+90d). Incremental runs use the stored checkpoint.
 * Messages that failed to download on an earlier run are retried first. The checkpoint moves only
 * when the run completes, and failed ids stay in `syncState.failedIds` until they are stored (or
 * fail `MAX_FETCH_ATTEMPTS` times), so a transient error never silently drops a message.
 */
export async function syncGoogle(
  user: User,
  opts: { onProgress?: (p: SyncProgress) => void; useLlm?: boolean; days?: number } = {},
): Promise<{ messages: number; events: number; failed: number; skipped: number }> {
  const token = currentGoogleToken();
  if (!token) throw new Error('Google is not connected.');
  const account = await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'google')
    .first();
  const startedAt = new Date().toISOString();
  const state = (account?.syncState ?? {}) as GoogleSyncState;
  const priorFailures = state.failedIds ?? {};
  const failed = new Map<string, number>();
  const gaveUp = new Set<string>();
  const markFailed = (id: string) => {
    const attempts = (priorFailures[id] ?? 0) + 1;
    if (attempts >= MAX_FETCH_ATTEMPTS) gaveUp.add(id);
    else failed.set(id, attempts);
  };
  const days = opts.days ?? 90;
  const since = state.lastSyncAt
    ? Math.max(1, Math.ceil((Date.now() - new Date(state.lastSyncAt).getTime()) / 86_400_000) + 1)
    : days;
  const progress = (phase: string, done: number, total: number) => opts.onProgress?.({ phase, done, total });
  let total = 0;
  const retryIds = Object.keys(priorFailures);
  const phases: [string, string | undefined][] = [
    ...(retryIds.length ? ([['Retrying earlier messages', undefined]] as [string, undefined][]) : []),
    ['Sent mail', `in:sent newer_than:${since}d`],
    ['Inbox', `in:inbox newer_than:${since}d -category:promotions -category:social -category:forums`],
  ];
  for (const [phase, q] of phases) {
    progress(phase, 0, 1);
    const ids = q ? await gmailListIds(q, 1500) : retryIds;
    const raws: RawEmail[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = await Promise.all(
        ids.slice(i, i + 20).map((id) =>
          gmailGet(id, 'full').then(
            (m) => ({ id, m }),
            () => ({ id, m: undefined }),
          ),
        ),
      );
      for (const { id, m } of chunk) {
        if (!m) {
          markFailed(id);
          continue;
        }
        failed.delete(id);
        gaveUp.delete(id);
        const h = gmailHeaders(m);
        const { text } = gmailExtractText(m);
        raws.push({
          externalMessageId: m.id,
          externalThreadId: m.threadId,
          from: h.from ?? '',
          to: (h.to ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          cc: (h.cc ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          subject: h.subject,
          sentAt: messageSentAt(m.internalDate, h.date),
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
  const nextState: GoogleSyncState = {
    ...state,
    lastSyncAt: startedAt,
    failedIds: failed.size ? Object.fromEntries(failed) : undefined,
  };
  if (!nextState.failedIds) delete nextState.failedIds;
  await db.integrations.update(account?.id ?? '', {
    lastSyncedAt: new Date().toISOString(),
    syncState: nextState as Record<string, unknown>,
    status: 'active',
  });
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  await notify(
    user.id,
    failed.size || gaveUp.size ? 'integration_problem' : 'system',
    'Google sync finished',
    [
      `${plural(total, 'message')} and ${plural(ev.events, 'event')} processed.`,
      failed.size
        ? `${plural(failed.size, 'message')} could not be downloaded from Gmail and will be retried on the next sync.`
        : '',
      gaveUp.size
        ? `${plural(gaveUp.size, 'message')} failed ${MAX_FETCH_ATTEMPTS} times and ${gaveUp.size === 1 ? 'was' : 'were'} skipped.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return { messages: total, events: ev.events, failed: failed.size, skipped: gaveUp.size };
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
