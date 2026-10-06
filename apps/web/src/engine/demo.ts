import type { User } from '@orbit/core';
import { buildDemoDataset } from '@orbit/core';
import { recomputeAllStrengths, setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { generateBrief, recommendationsRefresh, refreshPersonSummary } from './brief';
import { recomputeEdges } from './graph';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from './ingest';
import { ingestNote } from './notes';

export const DEMO_USER_ID = 'demo-user';

/**
 * The confirmation to show before loading the demo would wipe this browser's data, or undefined when nothing would be
 * lost (no user yet, or the current user is already the demo). Every entry point that resets to the demo goes through it.
 */
export function demoResetPrompt(
  user: Pick<User, 'id' | 'fullName' | 'onboardingCompletedAt'> | undefined,
): string | undefined {
  if (!user || user.id === DEMO_USER_ID) return undefined;
  const name = user.fullName.trim();
  if (!user.onboardingCompletedAt)
    return `Loading the demo discards the setup you started${name ? ` for ${name}` : ''}. Continue?`;
  return `Loading the demo deletes ${name ? `${name}'s` : 'your'} people, chats, notes and drafts from this browser. This cannot be undone. Continue?`;
}

export async function loadDemo(
  opts: { reset?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<User> {
  const log = opts.onProgress ?? (() => {});
  if (opts.reset) await wipeDatabase();
  const now = new Date();
  const ds = buildDemoDataset({ now });
  ds.user.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ds.user.timezone; // seeded times are in the browser's clock
  log('Creating your demo profile');
  await db.users.put(ds.user);
  await db.settings.put(ds.settings);
  await db.goals.put(ds.goals);
  await db.targetCompanies.bulkPut(ds.targetCompanies);
  await db.resumes.put(ds.resume);
  await db.resumeFacets.bulkPut(ds.resumeFacets);
  await db.organizations.bulkPut(ds.organizations);
  await db.integrations.put({
    id: 'int_demo',
    userId: ds.user.id,
    provider: 'demo',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
  });
  await db.integrations.put({
    id: 'int_li',
    userId: ds.user.id,
    provider: 'linkedin_csv',
    status: 'active',
    scopes: [],
    syncState: { rows: ds.people.length },
    connectedAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
  });
  await setCurrentUserId(ds.user.id);
  log('Importing LinkedIn connections');
  await db.people.bulkPut(ds.people);
  await db.affiliations.bulkPut(ds.affiliations);
  for (const p of ds.people)
    if (p.linkedinConnectedOn)
      await db.touchpoints.put({
        id: `tp_li_${p.id}`,
        userId: ds.user.id,
        personId: p.id,
        kind: 'linkedin_connected',
        occurredAt: `${p.linkedinConnectedOn}T12:00:00.000Z`,
        refTable: 'linkedin_csv',
        refId: p.id,
        summary: 'Connected on LinkedIn',
        weight: 0.2,
      });
  // Replay emails/events through the real ingest pipeline so stages and signals come from the engine.
  log('Reading your mailbox (demo)');
  const raws: RawEmail[] = ds.messages.map((m) => ({
    externalMessageId: m.externalMessageId,
    externalThreadId: ds.threads.find((t) => t.id === m.threadId)!.externalThreadId,
    from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
    to: m.toEmails.filter(Boolean),
    cc: m.ccEmails.filter(Boolean),
    subject: m.subject,
    sentAt: m.sentAt,
    bodyText: m.bodyText,
    headers: { 'message-id': `<${m.externalMessageId}@demo>` },
  }));
  await ingestEmails(ds.user, raws, { useLlm: false, now });
  log('Reading your calendar (demo)');
  const events: RawEvent[] = ds.events.map((e) => ({
    externalEventId: e.externalEventId,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    status: e.status,
    attendees: e.attendees,
    conferenceUrl: e.conferenceUrl,
  }));
  await ingestEvents(ds.user, events, now);
  // The demo's warm-up chat is seeded directly (it has no email history).
  const warm = ds.chats.find((c) => c.stage === 'warming');
  if (warm) await db.chats.put(warm);
  // Mentor relationship type + nurturing chat: seed stage (completed long ago) is derived; mark relationship.
  const mentorChat = ds.chats.find((c) => c.stage === 'nurturing');
  if (mentorChat) await db.people.update(mentorChat.personId, { relationshipType: 'mentor' });
  log('Ingesting meeting notes');
  for (const n of ds.notes)
    await ingestNote(
      ds.user,
      {
        text: n.rawText,
        source: n.source,
        personIds: n.personIds,
        occurredAt: n.occurredAt,
        title: n.title,
        externalId: n.externalId,
      },
      now,
    );
  log('Building your map');
  await recomputeAllStrengths(ds.user.id, now);
  await recomputeEdges(ds.user.id);
  log('Finding people to meet');
  await recommendationsRefresh(ds.user, now);
  for (const c of ds.chats) await refreshPersonSummary(ds.user, c.personId);
  log('Writing your first brief');
  await generateBrief(ds.user, 'welcome', now);
  return ds.user;
}
