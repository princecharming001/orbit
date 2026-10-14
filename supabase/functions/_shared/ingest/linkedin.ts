/**
 * LinkedIn (through Unipile) into orbit rows (§12.3):
 *   relations → people with linkedin_member / linkedin_slug identities (source linkedin_relation, created at the
 *               connection date, which is how the tie score knows they are connected) and a current employment
 *               affiliation read from the headline ("Designer at Figma"); a new employer closes the old one (§1.7);
 *   chats     → threads (provider linkedin) and messages for chats with at most 3 attendees. A message is the
 *               user's own (outbound) when Unipile marks it is_sender or its sender is the user's member id; it is
 *               never stored as inbound.
 * Used by sync.linkedin and by the Unipile webhooks.
 */
import { normalizeLinkedInUrl } from '@orbit/core/text/normalize';
import type { Db } from '../db.ts';
import { parseHeadline, type UnipileRelation, unipileTime } from '../providers/unipileSync.ts';
import { recountThread } from './gmail.ts';
import { type Incoming, resolvePeople, upsertOrganization } from './people.ts';
import type { SelfInfo } from './util.ts';

export const CHAT_MAX_ATTENDEES = 3;

export interface RelationInput {
  memberId: string;
  publicIdentifier?: string | null;
  profileUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  headline?: string | null;
  photoUrl?: string | null;
  connectedAt?: string;
}

export function relationFromUnipile(r: UnipileRelation): RelationInput | undefined {
  if (!r.member_id) return undefined;
  return {
    memberId: r.member_id,
    publicIdentifier: r.public_identifier,
    profileUrl: r.public_profile_url,
    firstName: r.first_name,
    lastName: r.last_name,
    headline: r.headline,
    photoUrl: r.profile_picture_url,
    connectedAt: unipileTime(r.created_at),
  };
}

/** Relations into people, identities and affiliations; returns member id → person id. */
export async function ingestRelations(
  db: Db,
  userId: string,
  relations: RelationInput[],
  now: Date,
): Promise<{ byMember: Map<string, string>; created: number }> {
  const items: Incoming[] = relations.map((r) => {
    const { title, company } = parseHeadline(r.headline);
    return {
      key: `li:${r.memberId}`,
      linkedinMemberId: r.memberId,
      linkedinSlug: r.publicIdentifier ?? undefined,
      linkedinUrl: normalizeLinkedInUrl(r.profileUrl) ?? undefined,
      firstName: r.firstName ?? undefined,
      lastName: r.lastName ?? undefined,
      name: r.fullName ?? undefined,
      headline: r.headline ?? undefined,
      title,
      companyRaw: company,
      photoUrl: r.photoUrl ?? undefined,
      source: 'linkedin',
      seenAt: r.connectedAt ?? now.toISOString(),
      identitySource: 'linkedin_relation',
      identityAt: r.connectedAt,
    };
  });
  const res = await resolvePeople(db, userId, items, { now });
  const byMember = new Map<string, string>();
  const members = relations.map((r) => r.memberId);
  // a member first seen in a chat is now a connection
  await db.sql`
    update orbit.person_identities set source = 'linkedin_relation'
     where user_id = ${userId}::uuid and kind = 'linkedin_member' and value_norm = any(${members}::text[])
       and source <> 'linkedin_relation'`;
  for (const [i, r] of relations.entries()) {
    const pid = res.byKey.get(items[i]!.key);
    if (!pid) continue;
    byMember.set(r.memberId, pid);
    const { title, company } = parseHeadline(r.headline);
    if (company) await upsertCurrentEmployment(db, userId, pid, company, title, 'linkedin', now);
  }
  return { byMember, created: res.created.size };
}

/**
 * The person's current employer: kept when it is the same organization, otherwise the previous current LinkedIn
 * employment is closed and a new one opened, and people.org_id / org_raw / title follow it.
 */
export async function upsertCurrentEmployment(
  db: Db,
  userId: string,
  personId: string,
  company: string,
  title: string | undefined,
  source: string,
  now: Date,
): Promise<void> {
  const orgId = await upsertOrganization(db, userId, company);
  if (!orgId) return;
  const current = await db.sql<{ id: string; org_id: string | null; source: string }>`
    select id, org_id, source from orbit.affiliations
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and kind = 'employment' and is_current`;
  const same = current.find((a) => a.org_id === orgId);
  if (same) {
    if (title)
      await db.sql`update orbit.affiliations set title = coalesce(title, ${title}) where id = ${same.id}::uuid`;
    return;
  }
  const today = now.toISOString().slice(0, 10);
  await db.sql`
    update orbit.affiliations set is_current = false, end_date = coalesce(end_date, ${today}::date)
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and kind = 'employment' and is_current
       and source = ${source}`;
  await db.sql`
    insert into orbit.affiliations (user_id, person_id, org_id, org_raw, kind, title, is_current, source)
    values (${userId}::uuid, ${personId}::uuid, ${orgId}::uuid, ${company.trim()}, 'employment', ${title ?? null},
            true, ${source})`;
  await db.sql`
    update orbit.people set org_id = ${orgId}::uuid, org_raw = ${company.trim()}, title = coalesce(${title ?? null}, title)
     where id = ${personId}::uuid and user_id = ${userId}::uuid and not is_self`;
}

export interface ChatAttendeeInput {
  providerId?: string | null;
  attendeeId?: string | null;
  name?: string | null;
  profileUrl?: string | null;
  headline?: string | null;
  isSelf?: boolean;
}

export interface ChatMessageInput {
  id: string;
  text?: string | null;
  senderId?: string | null;
  timestamp?: string | number | null;
  isSender?: boolean | number | null;
  skip?: boolean;
}

/** True for the user's own message: Unipile's is_sender, or a sender that is one of the user's member ids. */
export function isOwnMessage(
  m: Pick<ChatMessageInput, 'isSender' | 'senderId'>,
  ownIds: Set<string>,
): boolean {
  return m.isSender === true || m.isSender === 1 || (!!m.senderId && ownIds.has(m.senderId));
}

export interface StoredChat {
  threadId: string;
  /** newly stored inbound messages (row id, external id, sent at) */
  inbound: { id: string; externalId: string; sentAt: string }[];
  inserted: number;
  personIds: string[];
}

/** One chat's messages into a linkedin thread; see the file comment. */
export async function storeChat(
  db: Db,
  userId: string,
  self: Pick<SelfInfo, 'selfId' | 'emails' | 'memberIds'>,
  chat: { id: string; attendees: ChatAttendeeInput[] },
  messages: ChatMessageInput[],
  now: Date,
  ownIds: Set<string>,
): Promise<StoredChat> {
  const others = chat.attendees.filter((a) => !a.isSelf && !(a.providerId && ownIds.has(a.providerId)));
  const items: Incoming[] = others
    .filter((a) => a.providerId)
    .map((a) => ({
      key: `li:${a.providerId}`,
      linkedinMemberId: a.providerId!,
      unipileAttendeeId: a.attendeeId ?? undefined,
      linkedinUrl: normalizeLinkedInUrl(a.profileUrl) ?? undefined,
      name: a.name ?? undefined,
      headline: a.headline ?? undefined,
      source: 'linkedin',
      identitySource: 'linkedin_chat',
    }));
  const res = await resolvePeople(db, userId, items, { now });
  const personOf = (providerId: string | null | undefined) =>
    providerId ? res.byKey.get(`li:${providerId}`) : undefined;
  const otherIds = [...new Set(others.map((a) => personOf(a.providerId)).filter((x): x is string => !!x))];

  const [thread] = await db.sql<{ id: string }>`
    insert into orbit.threads (user_id, provider, external_id, category, is_networking)
    values (${userId}::uuid, 'linkedin', ${chat.id}, 'networking', true)
    on conflict (user_id, provider, external_id) do update set is_networking = true
    returning id`;
  const threadId = thread!.id;
  const out: StoredChat = { threadId, inbound: [], inserted: 0, personIds: otherIds };
  for (const m of messages) {
    if (m.skip) continue;
    const text = (m.text ?? '').trim();
    const sentAt = unipileTime(m.timestamp ?? null);
    if (!text || !sentAt) continue;
    const own = isOwnMessage(m, ownIds);
    const from = own ? null : (personOf(m.senderId) ?? (otherIds.length === 1 ? otherIds[0]! : null));
    const to = own ? otherIds : [];
    const [row] = await db.sql<{ id: string }>`
      insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, to_person_ids,
                                  sent_at, snippet, body_text)
      values (${userId}::uuid, ${threadId}::uuid, 'linkedin', ${m.id}, ${own ? 'out' : 'in'}, ${from}::uuid,
              ${to}::uuid[], ${sentAt}::timestamptz, ${text.slice(0, 200)}, ${text})
      on conflict (user_id, provider, external_id) do nothing
      returning id`;
    if (!row) continue;
    out.inserted++;
    if (!own) out.inbound.push({ id: row.id, externalId: m.id, sentAt });
  }
  await recountThread(db, threadId, self);
  return out;
}
