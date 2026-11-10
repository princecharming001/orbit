/**
 * Send to many (plan 38 §B): many people, one review, one press. A batch keeps the people and the drafts written for
 * them; each draft is an ordinary draft, approved as written at its planned time, so every check a single message
 * gets (the words bound by hash, the day's limit, the wait after an unanswered message, a reply since) still holds.
 *
 * Who can go: someone with an email address, who did not ask not to be contacted, and to whom a message fits now.
 * LinkedIn is never scheduled, so someone with no address is listed for a tap instead.
 * An account's drafts are written on the server (`/drafts/compose`, which also looks for a missing address) and held
 * there until their time, so they go with the tab closed; elsewhere they wait in this browser's outbox.
 */
import type { OutboundMessage, Person, User } from '@orbit/core';
import { newId, SEND_CAPS } from '@orbit/core';
import { type BatchRow, db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { fillTemplate } from './batchText';
import { type BatchItem, type BatchPace, companyKey, planBatch, type TakenSend } from './batchTime';
import { composeDraft, nextMessageKind, setDraftText } from './drafts';
import { approveAndSend, googleSendActive } from './send';
import { personZone } from './trust';

export type { BatchRow };

/** Where one person stands for a batch. */
export type RecipientState =
  | { state: 'ready' }
  /** no address yet: an account can look one up; otherwise LinkedIn by hand */
  | { state: 'no_email' }
  | { state: 'do_not_contact' }
  | { state: 'hidden' }
  /** a message does not fit yet (they were written to and have not answered) */
  | { state: 'wait'; until?: string };

export async function recipientState(
  user: Pick<User, 'timezone'>,
  person: Person,
  now = new Date(),
): Promise<RecipientState> {
  if (person.hiddenAt) return { state: 'hidden' };
  if (person.doNotContact) return { state: 'do_not_contact' };
  const next = await nextMessageKind(user, person.id, now);
  if ('wait' in next) return { state: 'wait', until: next.wait.until };
  if (!person.primaryEmail) return { state: 'no_email' };
  return { state: 'ready' };
}

/** Why someone steps aside, in a few words. */
export function stateWords(s: RecipientState, firstName: string): string | undefined {
  switch (s.state) {
    case 'no_email':
      return 'No email address';
    case 'do_not_contact':
      return `${firstName} asked not to be contacted`;
    case 'hidden':
      return 'Hidden';
    case 'wait':
      return s.until
        ? `A message fits from ${new Date(s.until).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
        : 'You wrote recently';
    default:
      return undefined;
  }
}

/** A name for a new batch: what the people have in common, and the day. */
export function batchName(
  people: Pick<Person, 'currentTitle' | 'relationshipType'>[],
  now = new Date(),
): string {
  const day = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const recruiters = people.filter(
    (p) =>
      p.relationshipType === 'recruiter' ||
      /recruit|talent|sourcer|university|campus|early career/i.test(p.currentTitle ?? ''),
  ).length;
  if (people.length && recruiters / people.length >= 0.6) return `Recruiters, ${day}`;
  return `${people.length} ${people.length === 1 ? 'person' : 'people'}, ${day}`;
}

export async function createBatch(
  user: Pick<User, 'id'>,
  personIds: string[],
  opts: { name?: string; draftIds?: string[] } = {},
): Promise<BatchRow> {
  const people = (await db.people.bulkGet(personIds)).filter((p): p is Person => !!p);
  const row: BatchRow = {
    id: newId('batch'),
    userId: user.id,
    name: opts.name ?? batchName(people),
    createdAt: new Date().toISOString(),
    personIds: [...new Set(personIds)],
    draftIds: opts.draftIds ?? [],
    pace: 'steady',
  };
  await db.batches.add(row);
  return row;
}

/** Whether this account's drafts are written and held on the server (it may send email there). */
async function serverWrites(user: Pick<User, 'id'>): Promise<boolean> {
  if (!isServerUser(user.id)) return false;
  const sync = await import('./serverSync');
  const status = sync.syncStatusNow() ?? (await sync.refreshSyncStatus().catch(() => undefined));
  const g = sync.googleStatus(status);
  return !!g && g.status === 'active' && g.scopes.some((s) => s.includes('gmail.send'));
}

/** Whether a batch can be sent from Orbit here at all (Gmail's send permission, the server's, or the demo's). */
export async function batchCanSend(user: Pick<User, 'id'>): Promise<boolean> {
  const { usesMockConnectors } = await import('../integrations/connectorsMock');
  if (usesMockConnectors(user.id)) return true;
  return (await googleSendActive(user.id)) || (await serverWrites(user));
}

/**
 * The draft for one person in a batch: the one already started, else a new one of the kind that fits (a first
 * message, a follow-up), written on the server for an account. Undefined when nothing fits or nothing could be written.
 */
export async function draftForBatch(
  user: User,
  personId: string,
  now = new Date(),
): Promise<{ draft?: OutboundMessage; why?: string }> {
  const person = await db.people.get(personId);
  if (!person) return { why: 'Not found' };
  const next = await nextMessageKind(user, personId, now);
  if ('wait' in next) return { why: 'A message does not fit yet' };
  if (await serverWrites(user)) {
    const { serverIdOf, keepServerDraft } = await import('./serverSync');
    const sid = serverIdOf(personId);
    if (sid) {
      // a draft already started here is the one to send
      const started = await db.outbound
        .where('personId')
        .equals(personId)
        .filter((o) => o.status === 'draft' && o.channel === 'gmail' && !!serverIdOf(o.id))
        .first();
      if (started) return { draft: started };
      const r = await callApi('/drafts/compose', {
        personId: sid,
        kind: next.kind,
        channel: 'gmail',
        ...(next.chat?.goalId ? { goalId: serverIdOf(next.chat.goalId) } : {}),
      });
      if (!r.ok) return { why: r.message };
      await keepServerDraft(r.value.draft, user.id);
      const d = await db.outbound.get(r.value.draft.id);
      if (d) return { draft: d };
    }
  }
  const r = await composeDraft(user, personId, next.kind, { confirmed: true, skipWarmUp: true });
  if (r.kind !== 'draft') return { why: 'Orbit could not write this one' };
  if (r.draft.channel !== 'gmail') return { why: 'No email address' };
  return { draft: r.draft };
}

/** The student's own words for one person, written into their draft. */
export async function applyTemplate(
  user: Pick<User, 'school'>,
  draft: OutboundMessage,
  person: Person,
  template: { subject: string; body: string },
): Promise<{ missing: string[] }> {
  const fill = { ...person, school: user.school };
  const body = fillTemplate(template.body, fill);
  const subject = fillTemplate(template.subject, fill);
  await setDraftText(draft.id, { body: body.text, subject: subject.text });
  return { missing: [...new Set([...body.missing, ...subject.missing])] };
}

/** The student's daily email limit. */
export async function dailyEmailCap(userId: string): Promise<number> {
  const settings = await db.settings.get(userId);
  return Math.min(settings?.dailySendCapGmail ?? SEND_CAPS.gmailPerDay, SEND_CAPS.gmailPerDay);
}

/** Every email that is going out or went today, so a plan counts them: queued, held on the server, sent today. */
export async function takenSends(
  userId: string,
  except: Set<string>,
  now = new Date(),
): Promise<TakenSend[]> {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const rows = await db.outbound
    .where('userId')
    .equals(userId)
    .filter(
      (o) =>
        !except.has(o.id) &&
        o.channel === 'gmail' &&
        ((['queued', 'approved', 'sending'].includes(o.status) && !!o.sendAt) ||
          (o.status === 'sent' && !!o.sentAt && new Date(o.sentAt) >= dayStart)),
    )
    .toArray();
  const people = new Map(
    (await db.people.bulkGet([...new Set(rows.map((r) => r.personId))]))
      .filter((p): p is Person => !!p)
      .map((p) => [p.id, p]),
  );
  return rows.map((o) => ({
    at: new Date(o.status === 'sent' ? o.sentAt! : o.sendAt!),
    company: companyKey(people.get(o.personId)?.currentOrganizationRaw),
  }));
}

export interface PlannedSend {
  draftId: string;
  personId: string;
  at: Date;
}

/** The times for these drafts at this pace, around what is already going out. */
export async function planForBatch(
  user: Pick<User, 'id' | 'timezone'>,
  drafts: OutboundMessage[],
  pace: BatchPace,
  opts: { start?: Date; now?: Date; oneCompanyADay?: boolean } = {},
): Promise<PlannedSend[]> {
  const now = opts.now ?? new Date();
  const people = new Map(
    (await db.people.bulkGet(drafts.map((d) => d.personId)))
      .filter((p): p is Person => !!p)
      .map((p) => [p.id, p]),
  );
  const items: BatchItem[] = drafts.map((d) => {
    const p = people.get(d.personId);
    return {
      id: d.id,
      zone: (p && personZone(p)) || user.timezone || 'America/New_York',
      company: companyKey(p?.currentOrganizationRaw),
    };
  });
  const taken = await takenSends(user.id, new Set(drafts.map((d) => d.id)), now);
  const times = planBatch({
    items,
    pace,
    cap: await dailyEmailCap(user.id),
    start: opts.start && opts.start > now ? opts.start : now,
    taken,
    seed: drafts.length * 131 + Math.floor(now.getTime() / 3_600_000),
    oneCompanyADay: opts.oneCompanyADay,
  });
  const byId = new Map(drafts.map((d) => [d.id, d]));
  return times.map((t) => ({ draftId: t.id, personId: byId.get(t.id)!.personId, at: t.at }));
}

export type BatchOutcome =
  | { draftId: string; ok: true; at: string }
  | { draftId: string; ok: false; error: string };

/**
 * Approve each draft at its planned time, as written. One that cannot go is left as a draft with the reason; the rest
 * still go. The batch remembers when it was scheduled.
 */
export async function scheduleBatch(
  user: User,
  batchId: string,
  plan: PlannedSend[],
  now = new Date(),
): Promise<BatchOutcome[]> {
  const out: BatchOutcome[] = [];
  for (const p of plan) {
    const msg = await db.outbound.get(p.draftId);
    if (!msg) {
      out.push({ draftId: p.draftId, ok: false, error: 'That draft is gone.' });
      continue;
    }
    const r = await approveAndSend(user, msg.id, msg.bodyFinal ?? msg.bodyDraft, msg.subject, now, {
      scheduleAt: p.at,
    });
    if (r.ok && (r.status === 'queued' || r.status === 'scheduled'))
      out.push({
        draftId: p.draftId,
        ok: true,
        at: r.status === 'scheduled' ? r.sendAt : p.at.toISOString(),
      });
    else if (r.ok) out.push({ draftId: p.draftId, ok: false, error: 'It went another way. Check Drafts.' });
    else out.push({ draftId: p.draftId, ok: false, error: r.error });
  }
  await db.batches.update(batchId, {
    scheduledAt: now.toISOString(),
    draftIds: [
      ...new Set([...((await db.batches.get(batchId))?.draftIds ?? []), ...plan.map((p) => p.draftId)]),
    ],
  });
  return out;
}

export interface BatchProgress {
  total: number;
  sent: number;
  scheduled: number;
  replied: number;
  /** put back as a draft, failed, or cancelled */
  stopped: number;
  nextAt?: string;
}

/** Where a batch stands now. */
export async function batchProgress(batch: BatchRow): Promise<BatchProgress> {
  const rows = (await db.outbound.bulkGet(batch.draftIds)).filter((o): o is OutboundMessage => !!o);
  const out: BatchProgress = { total: rows.length, sent: 0, scheduled: 0, replied: 0, stopped: 0 };
  for (const o of rows) {
    if (o.status === 'sent') {
      out.sent++;
      const chats = await db.chats.where('personId').equals(o.personId).toArray();
      if (chats.some((c) => !!c.lastInboundAt && !!o.sentAt && c.lastInboundAt > o.sentAt)) out.replied++;
    } else if (['queued', 'approved', 'sending'].includes(o.status) && o.sendAt) {
      out.scheduled++;
      if (!out.nextAt || o.sendAt < out.nextAt) out.nextAt = o.sendAt;
    } else out.stopped++;
  }
  return out;
}

/** The batch a draft belongs to, if any. */
export async function batchOf(userId: string, draftId: string): Promise<BatchRow | undefined> {
  return db.batches
    .where('userId')
    .equals(userId)
    .filter((b) => b.draftIds.includes(draftId))
    .first();
}
