/**
 * The two ways a message leaves Orbit (§8.3): Gmail users.messages.send (scope gmail.send) and Unipile's LinkedIn
 * chats (an existing chat, or a new chat with a 1st-degree connection). Both report a typed result; a 429 or 5xx is
 * `retry` so the caller can hand the draft back to the queue instead of failing it.
 */
import { NeedsReauth } from '../google.ts';
import type { Services } from '../services.ts';

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const GMAIL_UPLOAD_URL =
  'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart';
export const GMAIL_THREAD_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/threads';
export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/** How long a send call may take before Orbit stops waiting; past it the send may or may not have gone. */
export const SEND_TIMEOUT_MS = 25_000;

/**
 * `ambiguous`: the provider may have taken the message even though the call failed (the connection dropped or timed
 * out after the request went, or a 5xx), so a retry must first look for the copy that went out.
 */
export type SendOutcome =
  | { ok: true; providerMessageId: string; threadId?: string }
  | { ok: false; retry: boolean; error: string; ambiguous?: boolean };

export async function gmailSend(
  s: Services,
  userId: string,
  raw: string,
  threadId: string | null,
  /**
   * the whole message as text, for one with files: it goes to Gmail's upload endpoint (multipart/related, the thread
   * in the JSON part) instead of as `raw` in JSON, which keeps large messages within the request limit
   */
  mime?: string,
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
      const boundary = 'orbit-upload-boundary';
      res = mime
        ? await s.fetch(GMAIL_UPLOAD_URL, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': `multipart/related; boundary=${boundary}`,
            },
            body: [
              `--${boundary}`,
              'Content-Type: application/json; charset=UTF-8',
              '',
              JSON.stringify(threadId ? { threadId } : {}),
              `--${boundary}`,
              'Content-Type: message/rfc822',
              '',
              mime,
              `--${boundary}--`,
              '',
            ].join('\r\n'),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS * 2),
          })
        : await s.fetch(GMAIL_SEND_URL, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
    } catch {
      return { ok: false, retry: true, error: 'network', ambiguous: true };
    }
    if (res.status === 401 && attempt === 0) {
      s.tokens.invalidate(userId);
      await res.body?.cancel();
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      return { ok: false, retry: true, error: `gmail_${res.status}`, ambiguous: res.status >= 500 };
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

/**
 * The copy of a send that may have gone through (after a dropped connection, a timeout, a 5xx, or an isolate that
 * died mid-send): the student's Sent mail to `to` since `since` carrying this draft's X-Orbit-Draft-Id, or, on a copy
 * that came back without that header, the same subject and opening words. Null when there is none, undefined when
 * Gmail could not be asked (the caller then waits rather than risk a second copy).
 */
export async function gmailSentCopy(
  s: Services,
  userId: string,
  p: { to: string; draftId: string; since: Date; subject?: string | null; body?: string },
): Promise<{ id: string; threadId?: string } | null | undefined> {
  if (!s.tokens) return undefined;
  try {
    const token = await s.tokens.accessToken(userId);
    const headers = { authorization: `Bearer ${token}` };
    const q = `in:sent to:${p.to} after:${Math.floor(p.since.getTime() / 1000) - 60}`;
    const list = await s.fetch(`${GMAIL_MESSAGES_URL}?maxResults=20&q=${encodeURIComponent(q)}`, {
      headers,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!list.ok) {
      await list.body?.cancel();
      return undefined;
    }
    const j = (await list.json()) as { messages?: { id: string; threadId?: string }[] };
    for (const m of j.messages ?? []) {
      const res = await s.fetch(
        `${GMAIL_MESSAGES_URL}/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=X-Orbit-Draft-Id&metadataHeaders=Subject`,
        { headers, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return undefined;
      }
      const msg = (await res.json()) as {
        snippet?: string;
        payload?: { headers?: { name: string; value: string }[] };
      };
      const header = (n: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value;
      const tag = header('x-orbit-draft-id')?.trim();
      if (tag === p.draftId) return { id: m.id, threadId: m.threadId };
      if (!tag && p.body && sameMessage(header('subject'), msg.snippet, p.subject, p.body))
        return { id: m.id, threadId: m.threadId };
    }
    return null;
  } catch {
    return undefined;
  }
}

const plain = (t: string | null | undefined) =>
  (t ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** A Sent copy with no draft id is this draft when its subject (Re: aside) and its opening words are the draft's. */
function sameMessage(
  subject: string | undefined,
  snippet: string | undefined,
  draftSubject: string | null | undefined,
  body: string,
): boolean {
  const s = plain(subject).replace(/^re:\s*/, '');
  const ds = plain(draftSubject).replace(/^re:\s*/, '');
  if (ds && s !== ds) return false;
  const a = plain(snippet).slice(0, 80);
  const b = plain(body).slice(0, 80);
  return a.length >= 20 && b.startsWith(a.slice(0, Math.min(a.length, b.length)));
}

/** LinkedIn caps the note on a connection request at this many characters. */
export const LINKEDIN_NOTE_MAX = 300;

/**
 * Unipile, from the student's own LinkedIn: POST /api/v1/chats/{chat_id}/messages into the chat they already have, or
 * POST /api/v1/chats to start one with a connection, or, when LinkedIn will not open a chat (they are not connected),
 * POST /api/v1/users/invite: a connection request with the text as its note. The member is found from the profile
 * address when Orbit has no member id yet (GET /api/v1/users/{slug}).
 */
export async function linkedinSend(
  s: Services,
  p: {
    accountId: string;
    chatId?: string | null;
    attendeeId?: string | null;
    slug?: string | null;
    /** known to be a 1st-degree connection: a chat, never a request */
    connected?: boolean;
    text: string;
  },
): Promise<SendOutcome & { chatId?: string; invited?: boolean; memberId?: string }> {
  const base = (s.env.unipileBase ?? '').replace(/\/+$/, '');
  if (!s.env.unipileKey || !base) return { ok: false, retry: false, error: 'unipile_unconfigured' };
  const key = s.env.unipileKey;
  const call = async (url: string, init: RequestInit): Promise<Response | 'network'> => {
    try {
      return await s.fetch(url, {
        ...init,
        headers: { 'X-API-KEY': key, accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      return 'network';
    }
  };
  const failed = async (res: Response | 'network'): Promise<SendOutcome> => {
    if (res === 'network') return { ok: false, retry: true, error: 'network', ambiguous: true };
    await res.body?.cancel();
    if (res.status === 429 || res.status >= 500)
      return { ok: false, retry: true, error: `unipile_${res.status}`, ambiguous: res.status >= 500 };
    return { ok: false, retry: false, error: `unipile_${res.status}` };
  };
  const message = async (url: string, form: FormData) => {
    const res = await call(url, { method: 'POST', body: form });
    if (res === 'network' || !res.ok) return { res, out: await failed(res) };
    const j = (await res.json().catch(() => ({}))) as { message_id?: string; chat_id?: string; id?: string };
    const id = j.message_id ?? j.id;
    if (!id) return { res, out: { ok: false, retry: false, error: 'unipile_no_id' } as SendOutcome };
    return { res, out: { ok: true, providerMessageId: id } as SendOutcome, chatId: j.chat_id };
  };
  const form = () => {
    const f = new FormData();
    f.set('account_id', p.accountId);
    f.set('text', p.text);
    return f;
  };

  if (p.chatId) {
    const r = await message(`${base}/api/v1/chats/${encodeURIComponent(p.chatId)}/messages`, form());
    return r.out.ok ? { ...r.out, chatId: r.chatId ?? p.chatId } : r.out;
  }

  // who they are on LinkedIn: the member id Orbit keeps, else looked up from the profile address
  let member = p.attendeeId ?? undefined;
  if (!member && p.slug) {
    const res = await call(
      `${base}/api/v1/users/${encodeURIComponent(p.slug)}?account_id=${encodeURIComponent(p.accountId)}&notify=false`,
      { method: 'GET' },
    );
    if (res === 'network' || res.status === 429 || res.status >= 500) {
      const f = await failed(res);
      // nothing was sent yet: a plain retry, never an unconfirmed send
      return f.ok ? f : { ...f, ambiguous: false };
    }
    if (res.ok) member = ((await res.json().catch(() => ({}))) as { provider_id?: string }).provider_id;
    else await res.body?.cancel();
  }
  if (!member) return { ok: false, retry: false, error: 'no_linkedin_member' };

  // a new chat: LinkedIn opens one only with a connection; anyone else gets the request below
  const f = form();
  f.append('attendees_ids', member);
  const chat = await message(`${base}/api/v1/chats`, f);
  if (chat.out.ok) return { ...chat.out, chatId: chat.chatId, memberId: member };
  if (p.connected || chat.out.retry || chat.out.error === 'unipile_no_id') return chat.out;

  if (p.text.length > LINKEDIN_NOTE_MAX) return { ok: false, retry: false, error: 'linkedin_note_too_long' };
  const res = await call(`${base}/api/v1/users/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: p.accountId, provider_id: member, message: p.text }),
  });
  if (res === 'network' || !res.ok) return failed(res);
  const b = (await res.json().catch(() => ({}))) as { invitation_id?: string };
  return {
    ok: true,
    providerMessageId: b.invitation_id ?? `invite:${member}`,
    invited: true,
    memberId: member,
  };
}
