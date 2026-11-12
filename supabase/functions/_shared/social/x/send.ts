/**
 * Sending one X DM (plan 43 §5 "Sending"). Never on its own: the student's tap is enforced where drafts are sent
 * (_shared/sending/send.ts), which calls this. First Orbit reads the person's profile to see whether they accept DMs
 * from the student (`receives_your_dm`, $0.01), then sends ($0.015). A refusal comes back as a plain reason the
 * student can read, and a send X refused is not charged.
 */
import type { Db } from '../../db.ts';
import { SocialBudgetSpent } from '../adapter.ts';
import { XApiError, XRateLimited } from './adapter.ts';
import { type XDeps, xAdapterFor } from './client.ts';
import { readXProfile } from './lists.ts';

export const X_DM_MAX_CHARS = 10_000;

export const X_SEND_REASONS = {
  not_connected: 'X is not connected. Sign in with X in Settings to send from Orbit.',
  not_accepting: 'They do not accept messages from you on X. Try another way to reach them.',
  limit: 'Orbit has reached its X spending limit for this month. Try another way to reach them.',
  gone: 'That X account is no longer there.',
  rate_limited: 'X asked Orbit to slow down. Try again in a few minutes.',
  empty: 'The message is empty.',
  too_long: 'The message is too long for X.',
  failed: 'X did not take the message. Try again, or send it another way.',
} as const;

export type XSendResult =
  | { ok: true; messageId: string; chatId: string; costUsd: number }
  | { ok: false; code: keyof typeof X_SEND_REASONS; reason: string };

const no = (code: keyof typeof X_SEND_REASONS): XSendResult => ({
  ok: false,
  code,
  reason: X_SEND_REASONS[code],
});

/**
 * Sends `text` to one X account (`personAccountId`, X's own id) from the student's X account, after checking they
 * accept DMs from the student. Call only after the student tapped send.
 */
export async function sendXMessage(
  db: Db,
  userId: string,
  personAccountId: string,
  text: string,
  deps: XDeps,
): Promise<XSendResult> {
  const body = text.trim();
  if (!body) return no('empty');
  if (body.length > X_DM_MAX_CHARS) return no('too_long');
  const client = await xAdapterFor(db, userId, deps, { caller: 'send' });
  if (!client) return no('not_connected');
  const read = await readXProfile(db, client.adapter, personAccountId, userId);
  if (!read.ok) return no(read.reason === 'protected' ? 'not_accepting' : read.reason);
  if (read.profile.receivesYourDm === false) return no('not_accepting');
  const before = client.spend.chargedUsd();
  try {
    const sent = await client.adapter.send({ accountId: read.profile.account.id }, body);
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'x.dm_sent', 'messages', ${sent.messageId},
              ${{ chatId: sent.chatId }}::jsonb)`;
    return { ok: true, ...sent, costUsd: Math.round((client.spend.chargedUsd() - before) * 1000) / 1000 };
  } catch (e) {
    if (e instanceof SocialBudgetSpent) return no('limit');
    if (e instanceof XRateLimited) return no('rate_limited');
    if (e instanceof XApiError)
      return no(
        /dm-recipient-not-accepting|dm-sender-not-permitted|forbidden/i.test(e.type)
          ? 'not_accepting'
          : 'failed',
      );
    throw e;
  }
}
