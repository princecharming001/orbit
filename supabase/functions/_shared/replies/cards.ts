/**
 * The cards and notices the funnel raises for the student (plan 29 §B2.3, §B2.6): a `needs_you` card with the
 * question a reply asked, a `breaker` card when the breaker fires. Each is one row in orbit.suggestions (the shape the
 * browser's own cards have, pulled into the same table), one in orbit.notifications, and, when the app has been
 * closed for four hours and a mailer is configured, one email to the student's own address that names nothing of
 * the reply ("Dan asked one thing. Reply in Orbit.").
 */
import type { SuggestionKind } from '@orbit/core/types';
import type { Db } from '../db.ts';
import type { Services } from '../services.ts';

/** A card lives this long unless answered. */
export const CARD_TTL_DAYS = 14;
/** The app is "closed" when no session has been used for this long (plan 29 §B2.6). */
export const CLOSED_AFTER_MS = 4 * 3_600_000;

export interface CardInput {
  kind: SuggestionKind;
  dedupeKey: string;
  reasonText: string;
  personId?: string | null;
  chatId?: string | null;
  draftId?: string | null;
  messageId?: string | null;
  signals?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  priority?: number;
  now: Date;
  /** a notification beside the card */
  notify?: { kind: string; title: string; body?: string; link?: string };
}

/** Upsert one card by its dedupe key; a card answered before stays answered. Returns the row id. */
export async function raiseCard(db: Db, userId: string, c: CardInput): Promise<string> {
  const expires = new Date(c.now.getTime() + CARD_TTL_DAYS * 86_400_000);
  const [row] = await db.sql<{ id: string; inserted: boolean }>`
    insert into orbit.suggestions (user_id, kind, person_id, chat_id, draft_id, message_id, priority_score, reason_text,
                                   signals, payload, status, dedupe_key, expires_at, created_at, updated_at)
    values (${userId}::uuid, ${c.kind}, ${c.personId ?? null}::uuid, ${c.chatId ?? null}::uuid, ${c.draftId ?? null}::uuid,
            ${c.messageId ?? null}::uuid, ${c.priority ?? 0.7}::real, ${c.reasonText}, ${c.signals ?? {}}::jsonb,
            ${c.payload ?? {}}::jsonb, 'pending', ${c.dedupeKey}, ${expires}::timestamptz, ${c.now}::timestamptz,
            ${c.now}::timestamptz)
    on conflict (user_id, dedupe_key) do update
      set reason_text = excluded.reason_text, signals = excluded.signals, payload = excluded.payload,
          expires_at = excluded.expires_at, updated_at = excluded.updated_at
    returning id, (xmax = 0) as inserted`;
  if (row?.inserted && c.notify)
    await db.sql`
      insert into orbit.notifications (user_id, kind, title, body, link, created_at, updated_at)
      values (${userId}::uuid, ${c.notify.kind}, ${c.notify.title}, ${c.notify.body ?? null}, ${c.notify.link ?? null},
              ${c.now}::timestamptz, ${c.now}::timestamptz)`;
  return row!.id;
}

/** Close a card (done, dismissed or expired) by its dedupe key, when it is still open. */
export async function settleCard(
  db: Db,
  userId: string,
  dedupeKey: string,
  status: 'done' | 'dismissed' | 'expired',
  now: Date,
): Promise<void> {
  await db.sql`
    update orbit.suggestions set status = ${status}, decided_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     where user_id = ${userId}::uuid and dedupe_key = ${dedupeKey} and status in ('pending', 'snoozed')`;
}

/** When the student last had the app open: the newest session use, else never. */
export async function lastSeenAt(db: Db, userId: string): Promise<Date | undefined> {
  const [r] = await db.sql<{ at: Date | null }>`
    select max(coalesce(last_used_at, created_at)) as at from orbit.sessions
     where user_id = ${userId}::uuid and revoked_at is null`;
  return r?.at ? new Date(r.at) : undefined;
}

/**
 * The email for a Needs you card (plan 29 §B2.6): only when the app has been closed for four hours, only to the
 * student's own address, and never with the reply's words. The subject and body name the person and nothing else.
 */
export async function mailIfAway(
  s: Services,
  userId: string,
  p: { personFirstName: string; now: Date },
): Promise<{ sent: boolean; reason?: string }> {
  if (!s.mailer.configured) return { sent: false, reason: 'unconfigured' };
  const seen = await lastSeenAt(s.db, userId);
  if (seen && p.now.getTime() - seen.getTime() < CLOSED_AFTER_MS) return { sent: false, reason: 'app_open' };
  const [u] = await s.db.sql<{ email: string }>`select email from orbit.users where id = ${userId}::uuid`;
  if (!u?.email) return { sent: false, reason: 'no_email' };
  const r = await s.mailer.send({
    to: u.email,
    subject: `${p.personFirstName} asked one thing`,
    text: `${p.personFirstName} asked one thing. Reply in Orbit.\n\nhttps://tryorbit.today/inbox`,
  });
  if (!r.ok) return { sent: false, reason: r.error };
  await s.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'system', 'needs_you.mailed', 'users', ${userId}, ${{ id: r.id }}::jsonb)`;
  return { sent: true };
}
