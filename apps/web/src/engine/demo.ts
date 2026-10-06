import type { CoffeeChat, DemoDataset, User } from '@orbit/core';
import { buildDemoDataset } from '@orbit/core';
import { recomputeAllStrengths, setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { generateBrief, recommendationsRefresh, refreshPersonSummary } from './brief';
import { recomputeEdges } from './graph';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from './ingest';
import { ingestNote } from './notes';
import { applyStage, runTimedStageRules } from './stages';

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * One step of the demo's history. Mail, calendar and notes are replayed through the real pipeline in the order
 * they happened, each step on its own clock, so stages, their timestamps and the timers come from the engine
 * exactly as if the student had been using Orbit all season.
 */
interface Step {
  at: number;
  order: number;
  run: (clock: Date) => Promise<void>;
}

/** The seed as a timeline: emails, invites and moves, meetings ending, notes, daily timers, confirmed declines. */
function timeline(user: User, ds: DemoDataset, now: Date): Step[] {
  const steps: Step[] = [];
  const extThread = new Map(ds.threads.map((t) => [t.id, t.externalThreadId]));
  for (const m of ds.messages) {
    const raw: RawEmail = {
      externalMessageId: m.externalMessageId,
      externalThreadId: extThread.get(m.threadId)!,
      from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
      to: m.toEmails.filter(Boolean),
      cc: m.ccEmails.filter(Boolean),
      subject: m.subject,
      sentAt: m.sentAt,
      bodyText: m.bodyText,
      headers: { ...m.headers, 'message-id': `<${m.externalMessageId}@demo>` },
    };
    steps.push({
      at: Date.parse(m.sentAt),
      order: 0,
      run: async (clock) => {
        await ingestEmails(user, [raw], { useLlm: false, now: clock });
      },
    });
  }
  const finalEvent = new Map(ds.events.map((e) => [e.externalEventId, e]));
  const rawEvent = (externalEventId: string, startAt: string, endAt: string): RawEvent => {
    const e = finalEvent.get(externalEventId)!;
    return {
      externalEventId,
      title: e.title,
      startAt,
      endAt,
      status: e.status,
      attendees: e.attendees,
      conferenceUrl: e.conferenceUrl,
    };
  };
  for (const c of ds.calendarChanges)
    steps.push({
      at: Date.parse(c.at),
      order: 1,
      run: async (clock) => {
        await ingestEvents(user, [rawEvent(c.externalEventId, c.startAt, c.endAt)], clock);
      },
    });
  // the calendar sync that first sees each meeting as over (the pipeline waits 15 minutes past the end)
  for (const e of ds.events) {
    const seen = Date.parse(e.endAt) + 16 * MINUTE;
    if (seen > now.getTime()) continue;
    steps.push({
      at: seen,
      order: 1,
      run: async (clock) => {
        await ingestEvents(user, [rawEvent(e.externalEventId, e.startAt, e.endAt)], clock);
      },
    });
  }
  for (const n of ds.notes)
    steps.push({
      at: Date.parse(n.createdAt),
      order: 2,
      run: async (clock) => {
        await ingestNote(
          user,
          {
            text: n.rawText,
            source: n.source,
            personIds: n.personIds,
            occurredAt: n.occurredAt,
            title: n.title,
            externalId: n.externalId,
          },
          clock,
        );
      },
    });
  // The daily maintenance that ran while the student used Orbit: two weeks after a thank-you, the timer moves
  // the chat to nurturing.
  for (const c of ds.chats) {
    if (!c.followedUpAt) continue;
    const due = Date.parse(c.followedUpAt) + 14 * DAY + 60 * MINUTE;
    if (due > now.getTime()) continue;
    steps.push({
      at: due,
      order: 3,
      run: async (clock) => {
        await runTimedStageRules(user.id, ds.settings.maxBumps, clock);
      },
    });
  }
  // Declines the student confirmed at the time (the pipeline only ever proposes a decline).
  for (const c of ds.chats.filter((x) => x.stage === 'declined'))
    steps.push({
      at: Date.parse(c.stageEnteredAt),
      order: 4,
      run: async (clock) => {
        await confirmProposedStage(c, clock);
      },
    });
  return steps.sort((a, b) => a.at - b.at || a.order - b.order);
}

/** Accept the pipeline's proposal for this person's chat at `clock`, as the confirmation card would have. */
async function confirmProposedStage(seedChat: CoffeeChat, clock: Date): Promise<void> {
  const chat = await db.chats.where('personId').equals(seedChat.personId).first();
  if (!chat) return;
  const proposal = await db.stageEvents
    .where('chatId')
    .equals(chat.id)
    .filter((e) => e.status === 'proposed' && e.toStage === seedChat.stage)
    .first();
  if (!proposal) return;
  await db.stageEvents.update(proposal.id, { status: 'confirmed', decidedAt: clock.toISOString() });
  await applyStage(chat, seedChat.stage, 'user', `confirmed:${proposal.reason}`, { now: clock });
}

export async function loadDemo(
  opts: { reset?: boolean; onProgress?: (msg: string) => void; now?: Date } = {},
): Promise<User> {
  const log = opts.onProgress ?? (() => {});
  if (opts.reset) await wipeDatabase();
  const now = opts.now ?? new Date();
  const ds = buildDemoDataset({ now });
  const user = ds.user;
  user.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || user.timezone; // seeded times are in the browser's clock
  log('Creating your demo profile');
  await db.users.put(user);
  await db.settings.put(ds.settings);
  await db.goals.put(ds.goals);
  await db.targetCompanies.bulkPut(ds.targetCompanies);
  await db.resumes.put(ds.resume);
  await db.resumeFacets.bulkPut(ds.resumeFacets);
  await db.organizations.bulkPut(ds.organizations);
  const connected = ds.people.filter((p) => p.linkedinConnectedOn);
  await db.integrations.put({
    id: 'int_demo',
    userId: user.id,
    provider: 'demo',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: user.createdAt,
    lastSyncedAt: now.toISOString(),
  });
  await db.integrations.put({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_csv',
    status: 'active',
    scopes: [],
    syncState: { rows: connected.length },
    connectedAt: user.createdAt,
    lastSyncedAt: user.createdAt,
  });
  await setCurrentUserId(user.id);
  log('Importing LinkedIn connections');
  await db.people.bulkPut(ds.people);
  await db.affiliations.bulkPut(ds.affiliations);
  for (const p of connected)
    await db.touchpoints.put({
      id: `tp_li_${p.id}`,
      userId: user.id,
      personId: p.id,
      kind: 'linkedin_connected',
      occurredAt: `${p.linkedinConnectedOn}T12:00:00.000Z`,
      refTable: 'linkedin_csv',
      refId: p.id,
      summary: 'Connected on LinkedIn',
      weight: 0.2,
    });
  // The warm-up has no mail behind it yet, so it is the one chat seeded directly.
  for (const c of ds.chats.filter((x) => x.stage === 'warming')) await db.chats.put(c);

  log('Reading your mailbox and calendar (demo)');
  const seen = new Set(await db.notifications.toCollection().primaryKeys());
  for (const s of timeline(user, ds, now)) {
    await s.run(new Date(s.at));
    // what the engine notified about back then is not news today
    const fresh = (await db.notifications.toCollection().primaryKeys()).filter((id) => !seen.has(id));
    if (now.getTime() - s.at > 3 * DAY) await db.notifications.bulkDelete(fresh);
    else for (const id of fresh) seen.add(id);
  }
  // Suggestions the immediate rules raised along the way belonged to their moment. Today's come from the welcome
  // brief below, computed on the final state with every note's facts in place.
  const replayed = await db.suggestions.where('userId').equals(user.id).toArray();
  await db.outbound.bulkDelete(replayed.map((s) => s.outboundMessageId).filter((id): id is string => !!id));
  await db.suggestions.bulkDelete(replayed.map((s) => s.id));

  log('Building your map');
  await recomputeAllStrengths(user.id, now);
  await recomputeEdges(user.id);
  log('Finding people to meet');
  await recommendationsRefresh(user, now);
  for (const c of ds.chats) await refreshPersonSummary(user, c.personId);
  log('Writing your first brief');
  await generateBrief(user, 'welcome', now);
  return user;
}
