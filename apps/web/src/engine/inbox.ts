/**
 * The student's whole inbox (account mode): every conversation in Gmail and on LinkedIn, newest first, not only the
 * replies to their outreach. Email is read live from Gmail by the server; LinkedIn from what the sync stored.
 */
import type { InboxListRequest, InboxListResponse, User } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';

export type InboxResult = ({ ok: true } & InboxListResponse) | { ok: false; message: string };

export async function listInbox(user: Pick<User, 'id'>, req: InboxListRequest = {}): Promise<InboxResult> {
  if (!isServerUser(user.id)) return { ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER };
  const r = await callApi('/inbox/list', req);
  return r.ok ? { ok: true, ...r.value } : { ok: false, message: r.message };
}
