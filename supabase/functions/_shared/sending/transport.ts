/**
 * The two ways a message leaves Orbit (§8.3): Gmail users.messages.send (scope gmail.send) and Unipile's LinkedIn
 * chats (an existing chat, or a new chat with a 1st-degree connection). Both report a typed result; a 429 or 5xx is
 * `retry` so the caller can hand the draft back to the queue instead of failing it.
 */
import { NeedsReauth } from '../google.ts';
import type { Services } from '../services.ts';

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const GMAIL_THREAD_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/threads';

export type SendOutcome =
  | { ok: true; providerMessageId: string; threadId?: string }
  | { ok: false; retry: boolean; error: string };

export async function gmailSend(
  s: Services,
  userId: string,
  raw: string,
  threadId: string | null,
): Promise<SendOutcome> {
  if (!s.tokens) return { ok: false, retry: false, error: 'google_unconfigured' };
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await s.tokens.accessToken(userId);
    } catch (e) {
      if (e instanceof NeedsReauth) return { ok: false, retry: false, error: 'needs_reauth' };
      return { ok: false, retry: true, error: 'token_error' };
    }
    let res: Response;
    try {
      res = await s.fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
      });
    } catch {
      return { ok: false, retry: true, error: 'network' };
    }
    if (res.status === 401 && attempt === 0) {
      s.tokens.invalidate(userId);
      await res.body?.cancel();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      return { ok: false, retry: true, error: `gmail_${res.status}` };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, retry: false, error: `gmail_${res.status}` };
    }
    const j = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
    if (!j.id) return { ok: false, retry: false, error: 'gmail_no_id' };
    return { ok: true, providerMessageId: j.id, threadId: j.threadId };
  }
  return { ok: false, retry: false, error: 'gmail_401' };
}

/**
 * Whether the Gmail thread holds a message from someone else newer than `since` (the live half of the re-check
 * before sending). Undefined when Gmail could not be asked; the stored messages then decide.
 */
export async function gmailThreadHasNewerInbound(
  s: Services,
  userId: string,
  threadId: string,
  since: Date,
): Promise<boolean | undefined> {
  if (!s.tokens) return undefined;
  try {
    const token = await s.tokens.accessToken(userId);
    const res = await s.fetch(
      `${GMAIL_THREAD_URL}/${encodeURIComponent(threadId)}?format=minimal&fields=messages(id,labelIds,internalDate)`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const j = (await res.json()) as { messages?: { labelIds?: string[]; internalDate?: string }[] };
    return (j.messages ?? []).some(
      (m) => !(m.labelIds ?? []).includes('SENT') && Number(m.internalDate ?? 0) > since.getTime(),
    );
  } catch {
    return undefined;
  }
}

/** Unipile: POST /api/v1/chats/{chat_id}/messages, or POST /api/v1/chats to start one (multipart). */
export async function linkedinSend(
  s: Services,
  p: { accountId: string; chatId?: string | null; attendeeId?: string | null; text: string },
): Promise<SendOutcome & { chatId?: string }> {
  const base = (s.env.unipileBase ?? '').replace(/\/+$/, '');
  if (!s.env.unipileKey || !base) return { ok: false, retry: false, error: 'unipile_unconfigured' };
  const form = new FormData();
  form.set('account_id', p.accountId);
  form.set('text', p.text);
  let url: string;
  if (p.chatId) url = `${base}/api/v1/chats/${encodeURIComponent(p.chatId)}/messages`;
  else if (p.attendeeId) {
    url = `${base}/api/v1/chats`;
    form.append('attendees_ids', p.attendeeId);
  } else return { ok: false, retry: false, error: 'no_linkedin_chat' };
  let res: Response;
  try {
    res = await s.fetch(url, {
      method: 'POST',
      headers: { 'X-API-KEY': s.env.unipileKey, accept: 'application/json' },
      body: form,
    });
  } catch {
    return { ok: false, retry: true, error: 'network' };
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    return { ok: false, retry: true, error: `unipile_${res.status}` };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, retry: false, error: `unipile_${res.status}` };
  }
  const j = (await res.json().catch(() => ({}))) as { message_id?: string; chat_id?: string; id?: string };
  const id = j.message_id ?? j.id;
  if (!id) return { ok: false, retry: false, error: 'unipile_no_id' };
  return { ok: true, providerMessageId: id, chatId: j.chat_id ?? p.chatId ?? undefined };
}
