/**
 * A student switching an optional source on, off, or removing it (plan 43 §3.1, the table "What Off and Removed do to
 * each kind of thing"). Every change is one transaction and queues the switch job (`sources.switch`, orbit-worker
 * handlers/sources.ts), which rescores the student's people, rebuilds the friend projection and moves the graph mark
 * the browser drops its cached graph on.
 *
 *   Off       rows are kept and hidden (the read sites leave them out, states.ts), writers store nothing new
 *             (`sourceIsOn`), and drafts waiting to go out on that channel go back to drafts with a note
 *   On        everything kept comes back; drafts this source paused stay drafts for the student to send
 *   Removed   messages and chats, follow ties, identities and attached accounts, the student's own rows in the shared
 *             graph (social_follows and social_list_reads they own), lookups, match questions and text days are
 *             deleted; people only this source knows are deleted unless the student has a chat or a note with them
 *             (then they stay, without the handle); "not the same person" answers and chat stages stay; drafts on
 *             that channel become unsent drafts to copy
 */
import { type OptionalSource, SOURCES } from '@orbit/core/sources';
import type { Db } from '../db.ts';
import type { Queue } from '../queue.ts';

export type SwitchState = 'on' | 'off' | 'removed';

/** The note a paused or unsent draft carries, in `drafts.error`, read by the draft screens. */
export const draftNote = (source: OptionalSource, state: 'off' | 'removed') => `source_${state}:${source}`;

/** What the student is told about such a draft. */
export function draftNoteText(source: OptionalSource, state: 'off' | 'removed'): string {
  const name = SOURCES[source].name;
  return state === 'off'
    ? `${name} is off, so this was not sent. Pick another way to send it.`
    : `${name} was removed, so this was not sent. Copy it and send it another way.`;
}

export interface RemovalCounts {
  messages: number;
  threads: number;
  ties: number;
  identities: number;
  links: number;
  follows: number;
  listReads: number;
  lookups: number;
  asks: number;
  textDays: number;
  peopleDeleted: number;
  peopleKept: number;
  drafts: number;
}

/** Drafts waiting to go out on the source's channel: back to drafts, with the note. Returns their ids. */
async function holdDrafts(
  db: Db,
  userId: string,
  source: OptionalSource,
  state: 'off' | 'removed',
): Promise<string[]> {
  const rows = await db.sql<{ id: string }>`
    update orbit.drafts set status = 'draft', send_at = null, error = ${draftNote(source, state)},
           cancel_reason = null
     where user_id = ${userId}::uuid and channel = ${source} and status in ('approved', 'scheduled')
    returning id`;
  for (const r of rows)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'system', ${state === 'off' ? 'draft.paused' : 'draft.unsent'}, 'drafts', ${r.id},
              ${{ source, note: draftNoteText(source, state) }}::jsonb)`;
  return rows.map((r) => r.id);
}

/**
 * Deletes what one source brought in (plan 43 §3.1, Removed), in the caller's transaction. Returns how much went.
 */
export async function removeSourceRows(
  db: Db,
  userId: string,
  source: OptionalSource,
): Promise<RemovalCounts> {
  const info = SOURCES[source];
  const provider = info.messageProvider ?? null;
  const tieKinds = [...info.tieKinds] as string[];
  const identityKind = info.identityKind ?? null;
  const platform = provider;
  const count = async (q: Promise<unknown[]>) => (await q).length;

  // chat stages stay where they are (the pipeline is the student's); the evidence says the source was removed
  if (provider)
    await db.sql`
      update orbit.stage_events se set evidence = coalesce(se.evidence, '{}'::jsonb)
                                                  || jsonb_build_object('sourceRemoved', ${source}::text)
       where se.user_id = ${userId}::uuid
         and (se.evidence ->> 'provider' = ${provider} or se.evidence ->> 'channel' = ${provider}
              or exists (select 1 from orbit.messages m
                          where m.user_id = se.user_id and m.provider = ${provider}
                            and m.id::text = se.evidence ->> 'messageId'))`;

  const messages = provider
    ? await count(
        db.sql`delete from orbit.messages where user_id = ${userId}::uuid and provider = ${provider} returning id`,
      )
    : 0;
  const threads = provider
    ? await count(
        db.sql`delete from orbit.threads where user_id = ${userId}::uuid and provider = ${provider} returning id`,
      )
    : 0;
  const ties = tieKinds.length
    ? await count(
        db.sql`delete from orbit.ties where user_id = ${userId}::uuid and kind = any(${tieKinds}::text[]) returning id`,
      )
    : 0;
  // the handle (the platform's account id), anything an attached account added (its email or phone), and for texts
  // the numbers the browser sent
  const identities = await count(db.sql`
    delete from orbit.person_identities i
     where i.user_id = ${userId}::uuid
       and (i.kind = ${identityKind ?? ''}
            or (${source} = 'imessage' and i.source = 'imessage')
            or (i.social_account_id is not null and ${platform ?? ''} <> ''
                and exists (select 1 from orbit.social_links l
                             where l.user_id = i.user_id and l.platform = ${platform ?? ''}
                               and l.account_id = i.social_account_id)))
    returning i.id`);
  const links = platform
    ? await count(
        db.sql`delete from orbit.social_links where user_id = ${userId}::uuid and platform = ${platform} returning id`,
      )
    : 0;
  const asks = platform
    ? await count(
        db.sql`delete from orbit.social_match_asks where user_id = ${userId}::uuid and platform = ${platform} returning id`,
      )
    : 0;
  const lookups = platform
    ? await count(
        db.sql`delete from orbit.social_lookups where user_id = ${userId}::uuid and platform = ${platform} returning id`,
      )
    : 0;
  // the student's own rows in the shared graph; public lists other students read stay
  const follows = platform
    ? await count(db.sql`
        delete from orbit.social_follows where owner_user_id = ${userId}::uuid and platform = ${platform}
        returning id`)
    : 0;
  const listReads = platform
    ? await count(db.sql`
        delete from orbit.social_list_reads where owner_user_id = ${userId}::uuid and platform = ${platform}
        returning id`)
    : 0;
  const textDays =
    source === 'imessage'
      ? await count(db.sql`delete from orbit.text_days where user_id = ${userId}::uuid returning person_id`)
      : 0;

  // people only this source knows: deleted, unless the student has a chat or a note with them; then they stay as
  // the student's own, without the handle
  const only = await db.sql<{ id: string; kept: boolean }>`
    select p.id,
           (exists (select 1 from orbit.chats c where c.user_id = p.user_id and c.person_id = p.id)
            or exists (select 1 from orbit.notes n where n.user_id = p.user_id and p.id = any(n.person_ids))) as kept
      from orbit.people p
     where p.user_id = ${userId}::uuid and not p.is_self
       and ((cardinality(p.sources) > 0 and p.sources <@ array[${source}]::text[])
            or (${platform ?? ''} <> '' and p.source_account like ${`${platform ?? ''}:%`}))`;
  const keep = only.filter((p) => p.kept).map((p) => p.id);
  const drop = only.filter((p) => !p.kept).map((p) => p.id);
  if (keep.length)
    await db.sql`
      update orbit.people set source_account = null, listed = true,
             sources = case when cardinality(array_remove(sources, ${source}::text)) = 0 then array['manual']::text[]
                            else array_remove(sources, ${source}::text) end
       where id = any(${keep}::uuid[])`;
  if (drop.length) {
    await db.sql`delete from orbit.people where id = any(${drop}::uuid[])`;
    // a hard delete reaches the browser through the audit log, as /sync/push's do
    for (const id of drop)
      await db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'system', 'sync.delete', 'people', ${id}, ${{ reason: 'source_removed', source }}::jsonb)`;
  }
  // a person who also knew the student elsewhere keeps the rest of their sources
  await db.sql`
    update orbit.people set sources = array_remove(sources, ${source}::text)
     where user_id = ${userId}::uuid and ${source} = any(sources) and cardinality(sources) > 1`;
  if (platform)
    await db.sql`
      update orbit.people set source_account = null
       where user_id = ${userId}::uuid and source_account like ${`${platform}:%`}`;

  const drafts = (await holdDrafts(db, userId, source, 'removed')).length;
  // the account itself: no longer read; the student's own id leaves with what it brought
  if (platform)
    await db.sql`
      update orbit.integration_accounts set status = 'revoked', social_account_id = null
       where user_id = ${userId}::uuid and provider = ${platform}`;
  return {
    messages,
    threads,
    ties,
    identities,
    links,
    follows,
    listReads,
    lookups,
    asks,
    textDays,
    peopleDeleted: drop.length,
    peopleKept: keep.length,
    drafts,
  };
}

export interface SwitchResult {
  state: SwitchState;
  previous: string;
  paused: number;
  removed?: RemovalCounts;
}

/** The dedupe key of one switch's job: each switch runs its own, even two in the same millisecond. */
export const switchJobKey = (userId: string, source: OptionalSource, now: Date) =>
  `sources.switch:${userId}:${source}:${now.getTime()}:${crypto.randomUUID()}`;

/**
 * Sets one source's state for the student, in one transaction with everything the state does, and queues the switch
 * job. `shareFollows` is never true for X (the caller refuses it first; the table refuses it too).
 */
export async function switchSource(
  db: Db,
  queue: Queue,
  userId: string,
  source: OptionalSource,
  next: { state: SwitchState; shareFollows?: boolean },
  now: Date,
): Promise<SwitchResult> {
  const result = await db.begin(async (tx) => {
    const [cur] = await tx.sql<{ state: string; share_follows: boolean }>`
      select state, share_follows from orbit.source_states
       where user_id = ${userId}::uuid and source = ${source} for update`;
    const previous = cur?.state ?? 'not_connected';
    const share = next.state === 'removed' ? false : (next.shareFollows ?? cur?.share_follows ?? false);
    await tx.sql`
      insert into orbit.source_states (user_id, source, state, off_since, share_follows)
      values (${userId}::uuid, ${source}, ${next.state},
              ${next.state === 'off' ? now.toISOString() : null}::timestamptz, ${share})
      on conflict (user_id, source) do update set
        state = excluded.state,
        off_since = case when excluded.state = 'off'
                         then coalesce(orbit.source_states.off_since, excluded.off_since) else null end,
        share_follows = excluded.share_follows`;
    let paused = 0;
    let removed: RemovalCounts | undefined;
    if (next.state === 'off') paused = (await holdDrafts(tx, userId, source, 'off')).length;
    if (next.state === 'removed') removed = await removeSourceRows(tx, userId, source);
    await tx.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', ${`source.${next.state}`}, 'source_states', ${source},
              ${{ previous, state: next.state, shareFollows: share, ...(removed ? { removed } : {}) }}::jsonb)`;
    return { state: next.state, previous, paused, ...(removed ? { removed } : {}) } as SwitchResult;
  });
  // this switch's job is the one that runs to the end; an earlier switch's job still going stops at its next page
  const runKey = switchJobKey(userId, source, now);
  await db.sql`
    insert into orbit.user_marks (user_id, switch_run) values (${userId}::uuid, ${runKey})
    on conflict (user_id) do update set switch_run = excluded.switch_run`;
  await queue.enqueue({
    kind: 'sources.switch',
    userId,
    payload: { source, state: next.state, runKey },
    dedupeKey: runKey,
  });
  return result;
}
