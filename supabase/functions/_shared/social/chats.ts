/**
 * The personal lane (plan 43 §3.9): Instagram and X chats, written apart from the LinkedIn chat writer, which drops
 * any message without text, makes a person of everyone in a chat, marks every chat as networking and never updates a
 * stored message.
 *
 * - Every message carries the account it came from (`social_account_id`) and whether words were written
 *   (`has_words`). The words (`body_text`, `snippet`) are kept only for people in the student's pipeline (an open
 *   chat in Orbit, not closed or archived, or someone the student wrote to from Orbit); for everyone else only the
 *   time, the direction and whether words were written.
 * - Only the other person of a one-to-one chat is offered to matching. Chats of 3 to 8 people are stored with their
 *   size (closeness weighs them down) and no one in them becomes a person here; larger chats are skipped.
 * - A chat is marked networking only while its person is in the pipeline. The "owes a reply" query reads networking
 *   threads only, so a friend's DM never makes the student owe anyone.
 * - Messages are keyed by the platform's own ids, so a reconnect does not store them twice, and a later read upserts:
 *   the words of messages stored without them are filled in once the person is in the pipeline (`fillChatWords`).
 * - Nothing here calls a model or drafts a reply. `afterInbound` moves a chat the student is waiting on to "replied",
 *   and only then queues the reply classifier, under a daily cap.
 */
import { accountKind, type SocialPlatform } from '@orbit/core/entity/social';
import type { Db } from '../db.ts';
import { type Queue, sqlQueue } from '../queue.ts';
import { moveChat } from '../slots/slots.ts';
import type { SocialChat, SocialMessage } from './adapter.ts';
import { loadAccounts } from './graph.ts';
import { ensureAccountPerson, listAfterExchange, personForAccount } from './people.ts';

/** Chats with more people than this, the student included, are not read (plan 43 §3.8). */
export const GROUP_MAX = 8;
/** Inbound personal-lane messages sent to the reply classifier a day, at most. */
export const SOCIAL_CLASSIFY_PER_DAY = 20;
/** The stages in which the student is waiting on the person. */
export const WAITING_STAGES = ['outreach_sent', 'no_response'] as const;

/** In the pipeline: an open chat in Orbit (not closed or archived), or the student wrote to them from Orbit. */
export async function inPipeline(db: Db, userId: string, personId: string): Promise<boolean> {
  const [r] = await db.sql<{ yes: boolean }>`
    select exists (select 1 from orbit.chats c where c.user_id = ${userId}::uuid and c.person_id = ${personId}::uuid
                     and c.archived_at is null and c.stage not in ('archived', 'declined'))
        or exists (select 1 from orbit.drafts d where d.user_id = ${userId}::uuid and d.person_id = ${personId}::uuid
                     and d.status = 'sent') as yes`;
  return !!r?.yes;
}

export interface StoredSocialChat {
  skipped?: 'large_group';
  threadId?: string;
  oneToOne: boolean;
  /** the other person of a one-to-one chat: offered to matching */
  partner?: { accountId: string; name?: string; username?: string; personId?: string };
  personIds: string[];
  pipeline: boolean;
  /** messages stored for the first time, inbound ones with their row ids */
  inserted: number;
  inbound: { id: string; externalId: string; sentAt: string; personId: string | null }[];
}

/** One chat's messages into the personal lane. */
export async function storeSocialChat(
  db: Db,
  userId: string,
  platform: SocialPlatform,
  chat: SocialChat,
  messages: SocialMessage[],
  o: { now: Date },
): Promise<StoredSocialChat> {
  const participants = Math.max(chat.participants, chat.others.length + 1, 2);
  const oneToOne = participants === 2 && chat.others.length === 1;
  if (participants > GROUP_MAX)
    return {
      skipped: 'large_group',
      oneToOne: false,
      personIds: [],
      pipeline: false,
      inserted: 0,
      inbound: [],
    };

  const personOf = new Map<string, string>();
  for (const other of chat.others) {
    const p = await personForAccount(db, userId, platform, other.accountId);
    if (p) personOf.set(other.accountId, p.personId);
  }
  const partner = oneToOne ? chat.others[0]! : undefined;
  const [existing] = await db.sql<{ id: string; ins: number; outs: number }>`
    select t.id,
           count(m.id) filter (where m.direction = 'in')::int as ins,
           count(m.id) filter (where m.direction = 'out')::int as outs
      from orbit.threads t left join orbit.messages m on m.thread_id = t.id
     where t.user_id = ${userId}::uuid and t.provider = ${platform} and t.external_id = ${chat.chatId}
     group by t.id`;
  if (partner && !personOf.has(partner.accountId)) {
    // an account sorted as a person becomes one once the two have written to each other both ways (plan 43 §3.3)
    const both =
      ((existing?.ins ?? 0) > 0 || messages.some((m) => !m.fromStudent)) &&
      ((existing?.outs ?? 0) > 0 || messages.some((m) => m.fromStudent));
    if (both) {
      const stored = (await loadAccounts(db, platform, [partner.accountId])).get(partner.accountId);
      const kind =
        stored?.kind ??
        accountKind({
          platform,
          id: partner.accountId,
          username: partner.username ?? '',
          name: partner.name,
        });
      if (kind === 'person') {
        const made = await ensureAccountPerson(
          db,
          userId,
          {
            platform,
            id: partner.accountId,
            username: stored?.username ?? partner.username ?? partner.accountId,
            name: stored?.name ?? partner.name,
          },
          o.now,
        );
        personOf.set(partner.accountId, made.personId);
      }
    }
  }
  const partnerPerson = partner ? personOf.get(partner.accountId) : undefined;
  const pipeline = !!partnerPerson && (await inPipeline(db, userId, partnerPerson));
  const others = [...new Set(personOf.values())];

  const [thread] = await db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, social_account_id, participant_count, category,
                               is_networking, participant_person_ids)
    values (${userId}::uuid, ${platform}, ${chat.chatId}, ${partner?.accountId ?? null}, ${participants - 1}::int,
            ${pipeline ? 'networking' : 'personal'}, ${pipeline}, ${others}::uuid[])
    on conflict (user_id, provider, external_id) do update set
      social_account_id = coalesce(orbit.threads.social_account_id, excluded.social_account_id),
      participant_count = greatest(orbit.threads.participant_count, excluded.participant_count),
      is_networking = excluded.is_networking or (orbit.threads.is_networking and ${pipeline}),
      category = excluded.category
    returning id`;
  const threadId = thread!.id;
  const out: StoredSocialChat = {
    threadId,
    oneToOne,
    ...(partner ? { partner: { ...partner, personId: partnerPerson } } : {}),
    personIds: others,
    pipeline,
    inserted: 0,
    inbound: [],
  };
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    const from = m.fromStudent
      ? null
      : (personOf.get(m.senderAccountId) ?? (oneToOne ? partnerPerson : null));
    const to = m.fromStudent ? others : [];
    const stamp = m.fromStudent
      ? (partner?.accountId ?? null)
      : m.senderAccountId || partner?.accountId || null;
    const words = pipeline && text ? text : null;
    const [row] = await db.sql<{ id: string; fresh: boolean }>`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, to_person_ids,
                                  sent_at, snippet, body_text, social_account_id, has_words)
      values (${userId}::uuid, ${threadId}::uuid, ${platform}, ${m.messageId}, ${m.fromStudent ? 'out' : 'in'},
              ${from ?? null}::uuid, ${to}::uuid[], ${m.at}::timestamptz, ${words ? words.slice(0, 200) : null},
              ${words}, ${stamp}, ${m.hasWords && !!text})
      on conflict (user_id, provider, external_id) do update set
        thread_id = excluded.thread_id,
        body_text = coalesce(orbit.messages.body_text, excluded.body_text),
        snippet = coalesce(orbit.messages.snippet, excluded.snippet),
        from_person_id = coalesce(orbit.messages.from_person_id, excluded.from_person_id),
        to_person_ids = case when cardinality(orbit.messages.to_person_ids) = 0 then excluded.to_person_ids
                             else orbit.messages.to_person_ids end,
        social_account_id = coalesce(orbit.messages.social_account_id, excluded.social_account_id),
        has_words = coalesce(orbit.messages.has_words, excluded.has_words)
      returning id, (xmax = 0) as fresh`;
    if (!row?.fresh) continue;
    out.inserted++;
    if (!m.fromStudent)
      out.inbound.push({ id: row.id, externalId: m.messageId, sentAt: m.at, personId: from ?? null });
  }
  await db.sql`
    update orbit.threads t set
      message_count = s.n, first_at = s.first_at, last_at = s.last_at, last_direction = s.dir,
      participant_person_ids = array(select distinct x from unnest(t.participant_person_ids || ${others}::uuid[]) x
                                      where x is not null)
    from (select count(*)::int as n, min(sent_at) as first_at, max(sent_at) as last_at,
                 (array_agg(direction order by sent_at desc))[1] as dir
            from orbit.messages where thread_id = ${threadId}::uuid) s
    where t.id = ${threadId}::uuid`;
  if (others.length) await listAfterExchange(db, userId, others);
  return out;
}

/**
 * After new inbound messages: a chat the student is waiting on moves to "replied" (the reason names the message, so
 * a detach can propose moving it back), and that one message goes to the reply classifier under the daily cap; the
 * people are rescored. Nothing happens for anyone outside the pipeline beyond the rescore.
 */
export async function afterInbound(
  db: Db,
  queue: Queue,
  userId: string,
  platform: SocialPlatform,
  stored: StoredSocialChat,
  now: Date,
): Promise<{ replied: string[]; classified: string[] }> {
  const out = { replied: [] as string[], classified: [] as string[] };
  if (stored.pipeline)
    for (const m of stored.inbound) {
      if (!m.personId) continue;
      const [chat] = await db.sql<{ id: string }>`
        select id from orbit.chats
         where user_id = ${userId}::uuid and person_id = ${m.personId}::uuid and archived_at is null
           and stage = any(${[...WAITING_STAGES]}::text[])
         order by updated_at desc limit 1`;
      if (!chat) continue;
      await moveChat(db, userId, chat.id, 'replied', `${platform}_reply:${m.id}`, now);
      out.replied.push(chat.id);
      const [n] = await db.sql<{ n: number }>`
        select count(*)::int as n from orbit.audit_log
         where user_id = ${userId}::uuid and action = 'social.classify'
           and created_at > ${new Date(now.getTime() - 86_400_000)}::timestamptz`;
      if ((n?.n ?? 0) >= SOCIAL_CLASSIFY_PER_DAY) continue;
      await db.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'system', 'social.classify', 'messages', ${m.id}, ${{ platform }}::jsonb)`;
      await queue.enqueue({
        kind: 'classify.message',
        userId,
        payload: { provider: platform, messageRowId: m.id },
        dedupeKey: `classify:${platform}:${userId}:${m.externalId}`,
      });
      out.classified.push(m.id);
    }
  const people = [...new Set(stored.inbound.map((m) => m.personId).filter((x): x is string => !!x))];
  if (people.length)
    await queue.enqueue({
      kind: 'score.person',
      userId,
      payload: { personIds: people },
      dedupeKey: `score.person:${userId}:${platform}:${stored.inbound[0]!.externalId}`,
    });
  return out;
}

/**
 * A person entered the pipeline (the pipeline code calls this when a chat is opened for them or the student writes to
 * them from Orbit): their one-to-one Instagram and X chats become networking, they are listed, and a job reads those
 * chats' recent history to fill in the words of messages stored without them.
 */
export async function fillChatWords(
  db: Db,
  userId: string,
  personId: string,
  queue: Queue = sqlQueue(db),
): Promise<number> {
  const threads = await db.sql<{ id: string; provider: string }>`
    update orbit.threads set is_networking = true, category = 'networking'
     where user_id = ${userId}::uuid and provider in ('instagram', 'x') and participant_count <= 1
       and ${personId}::uuid = any(participant_person_ids)
    returning id, provider`;
  await listAfterExchange(db, userId, [personId]);
  for (const platform of new Set(threads.map((t) => t.provider)))
    await queue.enqueue({
      kind: 'social.words',
      userId,
      payload: { platform, personId },
      dedupeKey: `social.words:${userId}:${platform}:${personId}:${new Date().toISOString().slice(0, 15)}`,
    });
  return threads.length;
}
