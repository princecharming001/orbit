/**
 * Fathom: the student's meeting notetaker. Fathom joins their Google Meet and Zoom calls from their calendar, records
 * them and writes a summary with action items; Orbit imports each recorded meeting as a note on the people who were
 * in it (matched by their email on the invite), so what they said, offered and asked lands on their page, the chat
 * moves on, and the next message can mention it.
 *
 * The student's Fathom API key is kept in this browser only, on the `fathom` integration row. The sample student uses
 * a few made-up meetings instead, like every other connector in the demo.
 */
import type { NoteSource, User } from '@orbit/core';
import { newId, normalizeEmail } from '@orbit/core';
import { db, type IntegrationAccount } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { type FathomMeeting, fathomMeetingsPage, notesAppsAvailable } from '../integrations/notesApps';
import { appAuth, signInToApp } from './appSignIn';
import { isMeetingAppOn, keepOnlyMeetingApp, MEETING_NOTE_SOURCES } from './meetingAppSwitch';
import { ingestNote } from './notes';

/** The first import reaches back this far; later ones pick up from the newest meeting already imported. */
export const FATHOM_BACKFILL_DAYS = 60;
/** At most this many pages (10 meetings each) per sync, so a long history never runs away. */
const MAX_PAGES = 15;
/** A sync older than this is redone when the app opens. */
export const FATHOM_AUTO_SYNC_MS = 12 * 60 * 60 * 1000;

export type FathomResult =
  /** `switchedOff`: the other meeting apps that were on and are off now */
  | { ok: true; imported: number; skipped: number; switchedOff?: string[] }
  | { ok: false; reason: 'bad_key' | 'unavailable' | 'not_connected' | 'error'; message: string };

export async function fathomAccount(userId: string): Promise<IntegrationAccount | undefined> {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'fathom')
    .first();
}

const connected = isMeetingAppOn;

/** Fathom can be connected here: the sample student, or a build that can reach Orbit's notes function. */
export function fathomAvailable(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || notesAppsAvailable();
}

/** A meeting as the note Orbit files: the title, the app's summary and the action items, with a link back. */
export function meetingNoteText(m: FathomMeeting): string {
  const parts = [m.title];
  if (m.summary) parts.push(m.summary);
  if (m.actionItems.length)
    parts.push(
      [
        'Action items:',
        ...m.actionItems.map(
          (a) => `- ${a.done ? '[done] ' : ''}${a.text}${a.assignee ? ` (${a.assignee})` : ''}`,
        ),
      ].join('\n'),
    );
  if (m.url) parts.push(`Recording: ${m.url}`);
  return parts.join('\n\n');
}

/** The other people on a meeting: everyone on the invite but the student (and whoever recorded it, if that is them). */
export function otherInvitees(
  m: FathomMeeting,
  user: Pick<User, 'email'>,
): { name?: string; email?: string }[] {
  const me = normalizeEmail(user.email);
  const recorder = m.recordedBy ? normalizeEmail(m.recordedBy) : undefined;
  return m.invitees
    .filter((i) => !i.email || (normalizeEmail(i.email) !== me && normalizeEmail(i.email) !== recorder))
    .map((i) => ({ name: i.name, email: i.email }));
}

/** How a meeting is known once filed: the demo's made-up meetings share one id whichever app brought them in. */
export const meetingExternalId = (source: NoteSource, m: Pick<FathomMeeting, 'id'>) =>
  m.id.startsWith('demo-') ? `demo:${m.id}` : `${source === 'granola_api' ? 'granola' : source}:${m.id}`;

/** This meeting is filed already (for the demo's, under any meeting app). */
export async function meetingSeen(source: NoteSource, m: Pick<FathomMeeting, 'id'>): Promise<boolean> {
  const externalId = meetingExternalId(source, m);
  const sources: readonly NoteSource[] = m.id.startsWith('demo-') ? MEETING_NOTE_SOURCES : [source];
  for (const s of sources)
    if (await db.notes.where('[source+externalId]').equals([s, externalId]).first()) return true;
  // the demo's Fathom meetings were filed under Fathom's own id before the other apps came along
  return (
    m.id.startsWith('demo-') &&
    !!(await db.notes
      .where('[source+externalId]')
      .equals(['fathom', `fathom:${m.id}`])
      .first())
  );
}

/**
 * More people than this besides the student and it is not a conversation (a class, a team meeting, a panel): the
 * recording is a light touch for the people the student already has a chat with, and makes nobody new.
 */
export const MAX_CHAT_ATTENDEES = 4;

/**
 * File the meetings not imported before, from Fathom or any other meeting app; meetings with nobody else on them (a
 * solo recording) are skipped.
 */
export async function importMeetings(
  user: User,
  meetings: FathomMeeting[],
  now: Date,
  source: NoteSource = 'fathom',
) {
  let imported = 0;
  let skipped = 0;
  for (const m of meetings) {
    const externalId = meetingExternalId(source, m);
    const seen = await meetingSeen(source, m);
    const attendees = otherInvitees(m, user);
    if (seen || !attendees.length) {
      skipped++;
      continue;
    }
    await ingestNote(
      user,
      {
        text: meetingNoteText(m),
        source,
        title: m.title,
        occurredAt: m.startAt,
        externalId,
        attendees,
        group: attendees.length > MAX_CHAT_ATTENDEES,
      },
      now,
    );
    imported++;
  }
  return { imported, skipped };
}

/** The sample student's recorded meetings: two finished chats with people who have an email, made up from the demo. */
export async function demoMeetings(user: User): Promise<FathomMeeting[]> {
  const chats = await db.chats
    .where('userId')
    .equals(user.id)
    .filter((c) => ['completed', 'followed_up', 'nurturing'].includes(c.stage))
    .toArray();
  const out: FathomMeeting[] = [];
  for (const c of chats) {
    const p = await db.people.get(c.personId);
    if (!p?.primaryEmail || out.length >= 2) continue;
    const at = c.completedAt ?? c.stageEnteredAt;
    out.push({
      id: `demo-${c.id}`,
      title: `Coffee chat: ${user.fullName} / ${p.displayName}`,
      startAt: at,
      invitees: [
        { name: user.fullName, email: user.email },
        { name: p.displayName, email: p.primaryEmail, external: true },
      ],
      recordedBy: user.email,
      summary: `## Notes\n- ${p.firstName} talked through their path to ${p.currentOrganizationRaw ?? 'their team'} and what the first year looked like.\n- Recommended going in with one concrete project story.\n- Offered to look at your resume before applications open.`,
      actionItems: [{ text: `Send ${p.firstName} your resume`, done: false, assignee: user.fullName }],
    });
  }
  return out;
}

async function saveRow(
  user: User,
  patch: Partial<IntegrationAccount>,
  now: Date,
): Promise<IntegrationAccount> {
  const existing = await fathomAccount(user.id);
  const row: IntegrationAccount = {
    scopes: [],
    syncState: {},
    ...existing,
    id: existing?.id ?? newId('int'),
    userId: user.id,
    provider: 'fathom',
    status: 'active',
    connectedAt: existing && existing.status !== 'revoked' ? existing.connectedAt : now.toISOString(),
    ...patch,
  };
  await db.integrations.put(row);
  return row;
}

/** Bring in recorded meetings since the last import (the first time, the last 60 days). */
export async function syncFathom(
  user: User,
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<FathomResult> {
  const now = opts.now ?? new Date();
  const row = await fathomAccount(user.id);
  if (!connected(row)) return { ok: false, reason: 'not_connected', message: 'Fathom is not connected.' };
  const state = row.syncState as { since?: string; meetings?: number };
  let meetings: FathomMeeting[] = [];
  if (row.externalAccountId === 'demo') meetings = await demoMeetings(user);
  else {
    const since = state.since ?? new Date(now.getTime() - FATHOM_BACKFILL_DAYS * 86_400_000).toISOString();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const auth = await appAuth('fathom', row);
      if (!auth) return { ok: false, reason: 'bad_key', message: 'Fathom needs you to connect again.' };
      const r = await fathomMeetingsPage(auth, { createdAfter: since, cursor }, { signal: opts.signal });
      if (!r.ok) {
        await db.integrations.update(row.id, {
          status: r.reason === 'bad_key' ? 'needs_reauth' : 'error',
          lastError: r.message,
        });
        return {
          ok: false,
          reason: r.reason === 'bad_key' ? 'bad_key' : r.reason === 'unconfigured' ? 'unavailable' : 'error',
          message: r.message,
        };
      }
      meetings.push(...r.value.meetings);
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
    }
  }
  const { imported, skipped } = await importMeetings(user, meetings, now);
  const newest = meetings
    .map((m) => m.startAt)
    .filter((s): s is string => !!s)
    .sort()
    .at(-1);
  await db.integrations.update(row.id, {
    status: 'active',
    lastError: undefined,
    lastSyncedAt: now.toISOString(),
    // the next import starts a little before the newest meeting, so one finished late is not missed
    syncState: {
      since: newest ? new Date(Date.parse(newest) - 86_400_000).toISOString() : (state.since ?? undefined),
      meetings: (state.meetings ?? 0) + imported,
    },
  });
  return { ok: true, imported, skipped };
}

/** Save the key (checked by fetching the first page) and import the meetings. */
export async function connectFathom(user: User, apiKey: string, now = new Date()): Promise<FathomResult> {
  if (usesMockConnectors(user.id)) {
    await saveRow(user, { externalAccountId: 'demo', accessToken: undefined, lastError: undefined }, now);
    return firstSync(user, now);
  }
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: 'bad_key', message: 'Paste your Fathom API key first.' };
  if (!notesAppsAvailable())
    return { ok: false, reason: 'unavailable', message: 'This copy of Orbit cannot reach Fathom yet.' };
  const probe = await fathomMeetingsPage(key, {
    createdAfter: new Date(now.getTime() - 86_400_000).toISOString(),
  });
  if (!probe.ok)
    return { ok: false, reason: probe.reason === 'bad_key' ? 'bad_key' : 'error', message: probe.message };
  await saveRow(
    user,
    { accessToken: key, oauth: undefined, externalAccountId: undefined, lastError: undefined, syncState: {} },
    now,
  );
  return firstSync(user, now);
}

/** Just connected: the other meeting apps go off, then the first import. */
async function firstSync(user: User, now: Date): Promise<FathomResult> {
  const switchedOff = await keepOnlyMeetingApp(user.id, 'fathom');
  const r = await syncFathom(user, { now });
  return r.ok ? { ...r, switchedOff } : r;
}

/** Connect by signing in to Fathom: its own window, then the meetings import as with a key. */
export async function connectFathomSignedIn(user: User, now = new Date()): Promise<FathomResult> {
  if (usesMockConnectors(user.id)) return connectFathom(user, '', now);
  const s = await signInToApp('fathom');
  if (!s.ok) return { ok: false, reason: 'error', message: s.message };
  await saveRow(
    user,
    {
      accessToken: s.accessToken,
      oauth: { refreshToken: s.refreshToken, expiresAt: s.expiresAt },
      externalAccountId: undefined,
      lastError: undefined,
      syncState: {},
    },
    now,
  );
  return firstSync(user, now);
}

/** Stop importing. The key is forgotten here; notes already imported stay on people's pages. */
export async function disconnectFathom(user: Pick<User, 'id'>): Promise<void> {
  const row = await fathomAccount(user.id);
  if (!row) return;
  await db.integrations.update(row.id, {
    status: 'revoked',
    accessToken: undefined,
    oauth: undefined,
    externalAccountId: undefined,
    lastError: undefined,
  });
}

export interface FathomStatus {
  available: boolean;
  connected: boolean;
  needsKey: boolean;
  meetings: number;
  lastSyncedAt?: string;
  error?: string;
  demo: boolean;
}

export async function fathomStatus(user: Pick<User, 'id'>): Promise<FathomStatus> {
  const row = await fathomAccount(user.id);
  const on = connected(row);
  return {
    available: fathomAvailable(user),
    connected: on,
    needsKey: !!row && row.status === 'needs_reauth',
    meetings: Number((row?.syncState as { meetings?: number } | undefined)?.meetings ?? 0),
    lastSyncedAt: on ? row.lastSyncedAt : undefined,
    error: on ? row.lastError : undefined,
    demo: row?.externalAccountId === 'demo',
  };
}

/** On app open: import again when the last import is more than half a day old. Does nothing otherwise. */
export async function autoSyncFathom(user: User, now = new Date()): Promise<FathomResult | undefined> {
  const row = await fathomAccount(user.id);
  if (!connected(row) || row.status === 'needs_reauth') return undefined;
  const last = row.lastSyncedAt ? Date.parse(row.lastSyncedAt) : 0;
  if (now.getTime() - last < FATHOM_AUTO_SYNC_MS) return undefined;
  return syncFathom(user, { now });
}
