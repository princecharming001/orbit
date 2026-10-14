/**
 * The hourly cadence scan for one user (§9.3) on the server: the user's chats, drafts, messages, people and goals
 * read into core's `cadenceActions`, and then acted on. Bumps, thank-yous and nurture notes become drafts through
 * the compose service (the template engine when Claude is not configured); stage timers move chats; approved drafts
 * whose time has come are queued to send (dedupe `send:<draftId>`). Nothing happens while `quiet_until` is ahead,
 * nobody gets a fourth unanswered message, and nurture stays at three a week (all enforced in core).
 */
import type {
  CadenceAction,
  CadenceDraft,
  CadenceInput,
  CadenceMessage,
  CadencePerson,
} from '@orbit/core/pipeline/cadence';
import { cadenceActions } from '@orbit/core/pipeline/cadence';
import { messageHash } from '@orbit/core/safety/rules';
import type { DueItem } from '@orbit/core/server/api';
import { chatFromRow, goalFromRow, type Row } from '@orbit/core/server/mappers';
import type { CoffeeChat, Goal, MessageKind } from '@orbit/core/types';
import { composeDraft } from '../compose/compose.ts';
import { nextSendWindow } from '../compose/window.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { iso, isoRow, num } from '../rows.ts';
import type { Services } from '../services.ts';
import { moveChat } from '../slots/slots.ts';
import { validZone } from '../zones.ts';

const DAY = 86_400_000;

export function goalFrom(r: Record<string, unknown>): Goal {
  const due = r.due_at instanceof Date ? r.due_at.toISOString().slice(0, 10) : r.due_at;
  return goalFromRow({ ...isoRow(r), due_at: due } as unknown as Row.Goals);
}

export interface CadenceState {
  input: CadenceInput;
  timezone: string;
  chatsById: Map<string, CoffeeChat>;
  goalsById: Map<string, Goal>;
}

/** Everything `cadenceActions` reads, from the user's rows. */
export async function loadCadence(db: Db, userId: string, now: Date): Promise<CadenceState> {
  const [u] = await db.sql<{ timezone: string; settings: Record<string, unknown> }>`
    select timezone, settings from orbit.users where id = ${userId}::uuid`;
  const tz = validZone(u?.timezone) ?? 'America/New_York';
  const settings = u?.settings ?? {};
  const chatRows = await db.sql<Record<string, unknown>>`
    select * from orbit.chats where user_id = ${userId}::uuid and archived_at is null`;
  const chats = chatRows.map((r) => chatFromRow(isoRow(r) as unknown as Row.Chats));
  const goalRows = await db.sql<Record<string, unknown>>`
    select * from orbit.goals where user_id = ${userId}::uuid and deleted_at is null`;
  const goals = goalRows.map(goalFrom);
  const draftRows = await db.sql<{
    id: string;
    person_id: string;
    chat_id: string | null;
    kind: string;
    status: string;
    send_at: Date | null;
    created_at: Date;
  }>`
    select id, person_id, chat_id, kind, status, send_at, created_at from orbit.drafts
     where user_id = ${userId}::uuid
       and (status in ('draft', 'approved', 'scheduled', 'sending') or created_at > ${new Date(now.getTime() - 30 * DAY)}::timestamptz)`;
  const drafts: CadenceDraft[] = draftRows.map((d) => ({
    id: d.id,
    personId: d.person_id,
    chatId: d.chat_id ?? undefined,
    kind: d.kind as MessageKind,
    status: d.status,
    sendAt: iso(d.send_at) ?? undefined,
    createdAt: iso(d.created_at)!,
  }));
  const msgRows = await db.sql<{
    direction: 'in' | 'out';
    sent_at: Date;
    provider: string;
    from_person_id: string | null;
    to_person_ids: string[];
  }>`
    select direction, sent_at, provider, from_person_id, to_person_ids from orbit.messages
     where user_id = ${userId}::uuid and not is_automated
       and sent_at > ${new Date(now.getTime() - 365 * DAY)}::timestamptz`;
  const messages: CadenceMessage[] = [];
  for (const m of msgRows) {
    const channel = m.provider === 'linkedin' ? ('linkedin' as const) : ('email' as const);
    const at = iso(m.sent_at)!;
    if (m.direction === 'in') {
      if (m.from_person_id) messages.push({ personId: m.from_person_id, direction: 'in', at, channel });
    } else
      for (const p of m.to_person_ids ?? []) messages.push({ personId: p, direction: 'out', at, channel });
  }
  // sends sync has not seen yet still count toward the unanswered limit
  const unsynced = await db.sql<{ person_id: string; sent_at: Date; channel: string }>`
    select d.person_id, d.sent_at, d.channel from orbit.drafts d
     where d.user_id = ${userId}::uuid and d.status = 'sent' and d.sent_at is not null and d.kind <> 'forwardable_blurb'
       and not exists (select 1 from orbit.messages m where m.user_id = d.user_id and m.external_id = d.provider_message_id)`;
  for (const d of unsynced)
    messages.push({
      personId: d.person_id,
      direction: 'out',
      at: iso(d.sent_at)!,
      channel: d.channel === 'linkedin' ? 'linkedin' : 'email',
    });

  const goalPeople = goals.flatMap((g) => g.targets?.people ?? []);
  const wanted = [
    ...new Set([...chats.map((c) => c.personId), ...drafts.map((d) => d.personId), ...goalPeople]),
  ];
  const peopleRows = await db.sql<{
    id: string;
    first_name: string | null;
    display_name: string;
    title: string | null;
    org_raw: string | null;
    hidden_at: Date | null;
    do_not_contact: boolean;
    timezone: string | null;
    last_interaction_at: Date | null;
    score: number | null;
    recently: { text: string; date?: string | null }[] | null;
    dossier_at: Date | null;
    fact: string | null;
  }>`
    select p.id, p.first_name, p.display_name, p.title, p.org_raw, p.hidden_at, p.do_not_contact, p.timezone,
           p.last_interaction_at, ts.score::int as score,
           d.content->'recently' as recently, d.updated_at as dossier_at,
           (select f.text from orbit.facts f where f.person_id = p.id and f.deleted_at is null
               and f.created_at > ${new Date(now.getTime() - 30 * DAY)}::timestamptz
             order by f.created_at desc limit 1) as fact
      from orbit.people p
      left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
      left join orbit.dossiers d on d.user_id = p.user_id and d.person_id = p.id and d.status in ('ready', 'partial')
     where p.user_id = ${userId}::uuid and not p.is_self and p.deleted_at is null and p.merged_into is null
       and (ts.score >= 60 or p.id = any(${wanted}::uuid[]))`;
  const people = new Map<string, CadencePerson>();
  for (const p of peopleRows) {
    const fresh = p.dossier_at && now.getTime() - new Date(p.dossier_at).getTime() < 60 * DAY;
    const recent = fresh && Array.isArray(p.recently) ? p.recently[0]?.text : undefined;
    people.set(p.id, {
      person: {
        id: p.id,
        firstName: p.first_name ?? p.display_name.split(/\s+/)[0]!,
        currentTitle: p.title ?? undefined,
        currentOrganizationRaw: p.org_raw ?? undefined,
        hiddenAt: iso(p.hidden_at) ?? undefined,
        doNotContact: p.do_not_contact,
      },
      score: p.score ?? 0,
      lastContactAt: iso(p.last_interaction_at) ?? undefined,
      nurtureReason: recent ?? p.fact ?? undefined,
      timeZone: validZone(p.timezone),
    });
  }
  const nurtured = draftRows
    .filter((d) => d.kind === 'nurture' || d.kind === 'reengage')
    .map((d) => iso(d.created_at)!);
  const maxBumps = num(settings.max_bumps, 2);
  const quiet = typeof settings.quiet_until === 'string' ? settings.quiet_until : undefined;
  return {
    input: {
      chats,
      drafts,
      messages,
      people,
      goals,
      settings: { maxBumps, timezone: tz, quietUntil: quiet },
      now,
      recentNurtureAt: nurtured,
    },
    timezone: tz,
    chatsById: new Map(chats.map((c) => [c.id, c])),
    goalsById: new Map(goals.map((g) => [g.id, g])),
  };
}

const toDue = (a: CadenceAction): DueItem => ({
  kind: a.kind,
  personId: a.personId ?? null,
  chatId: a.chatId ?? null,
  draftId: a.draftId ?? null,
  reason: a.reason,
  dueAt: a.dueAt,
});

/** POST /cadence/due: what the scan would do now. */
export async function dueItems(db: Db, userId: string, now: Date): Promise<DueItem[]> {
  const st = await loadCadence(db, userId, now);
  return cadenceActions(st.input).map(toDue);
}

export interface CadenceSummary {
  quiet: boolean;
  actions: number;
  drafted: number;
  approved: number;
  moved: number;
  queued: number;
  skipped: number;
}

/** The cadence.user job (§9.3). */
export async function runCadence(s: Services, userId: string): Promise<CadenceSummary> {
  const db = s.db;
  const now = s.now();
  const st = await loadCadence(db, userId, now);
  const out: CadenceSummary = {
    quiet: false,
    actions: 0,
    drafted: 0,
    approved: 0,
    moved: 0,
    queued: 0,
    skipped: 0,
  };
  const q = st.input.settings.quietUntil;
  if (q && now.getTime() < new Date(q).getTime()) return { ...out, quiet: true };
  const actions = cadenceActions(st.input);
  out.actions = actions.length;
  const pending = (
    chatId: string | undefined,
    personId: string | undefined,
    kinds: string[],
    sinceMs: number,
  ) =>
    st.input.drafts.some(
      (d) =>
        kinds.includes(d.kind) &&
        (chatId ? d.chatId === chatId : d.personId === personId) &&
        (['draft', 'approved', 'scheduled', 'sending'].includes(d.status) ||
          now.getTime() - new Date(d.createdAt).getTime() < sinceMs),
    );

  for (const a of actions) {
    try {
      if (a.kind === 'send_due' && a.draftId) {
        const id = await s.queue.enqueue({
          kind: 'send.draft',
          userId,
          payload: { draftId: a.draftId },
          dedupeKey: `send:${a.draftId}`,
        });
        if (id !== null) out.queued++;
        continue;
      }
      if (a.kind === 'stage_timer' && a.chatId && a.toStage) {
        await moveChat(db, userId, a.chatId, a.toStage, a.reason, now);
        out.moved++;
        continue;
      }
      if (a.kind === 'went_quiet' || !a.personId || !a.draftKind) {
        out.skipped++;
        continue;
      }
      const chat = a.chatId ? st.chatsById.get(a.chatId) : undefined;
      if (a.kind === 'bump' && pending(a.chatId, a.personId, ['bump'], 2 * DAY)) {
        out.skipped++;
        continue;
      }
      if (a.kind === 'thank_you' && pending(a.chatId, a.personId, ['thank_you'], 7 * DAY)) {
        out.skipped++;
        continue;
      }
      if (a.kind === 'nurture' && pending(undefined, a.personId, ['nurture', 'reengage'], 7 * DAY)) {
        out.skipped++;
        continue;
      }
      const channel = chat?.outreachChannel === 'linkedin' ? 'linkedin' : 'gmail';
      const { draft } = await composeDraft(s, {
        userId,
        personId: a.personId,
        kind: a.draftKind,
        channel,
        goalId: a.goalId ?? null,
        chatId: a.chatId ?? null,
        reason: a.reason,
        actor: 'agent',
      });
      out.drafted++;
      st.input.drafts.push({
        id: draft.id,
        personId: draft.person_id,
        chatId: draft.chat_id ?? undefined,
        kind: draft.kind as MessageKind,
        status: 'draft',
        createdAt: now.toISOString(),
      });
      // §9.3: a bump is approved for the next window when the goal runs at level 1 and the user pre-approved bumps
      const goal = a.goalId ? st.goalsById.get(a.goalId) : undefined;
      const preapproved = (chat as (CoffeeChat & { preapprovedBumps?: boolean }) | undefined)
        ?.preapprovedBumps;
      if (
        a.kind === 'bump' &&
        channel === 'gmail' &&
        goal?.autonomyLevel === 1 &&
        preapproved &&
        draft.validator?.ok
      ) {
        const sendAt = nextSendWindow(
          now,
          st.input.people.get(a.personId)?.timeZone ?? st.timezone,
          'gmail',
          s.random,
        );
        await db.sql`
          update orbit.drafts set status = 'approved', send_at = ${sendAt.notBefore}::timestamptz, autonomy_level = 1
           where id = ${draft.id}::uuid and status = 'draft'`;
        await db.sql`
          insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
          values (${userId}::uuid, 'agent', 'draft.auto_approve', 'drafts', ${draft.id},
                  ${{ hash: messageHash({ channel: draft.channel, subject: draft.subject, body: draft.body }), standing: 'preapproved_bumps' }}::jsonb)`;
        out.approved++;
      }
    } catch (e) {
      if (e instanceof HttpError) {
        out.skipped++;
        continue;
      }
      throw e;
    }
  }
  return out;
}
