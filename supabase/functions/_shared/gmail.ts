/**
 * Gmail v1 for the sync jobs (§12.3, §12.5), read-only: messages.list (5 units), messages.get format=metadata (20),
 * threads.get format=full (40), history.list (2), users.getProfile (1), users.watch (100) and settings.sendAs.list (1).
 * Each call goes through googleApi.ts, so pacing, retries and re-authentication are handled there.
 */
import { type GoogleClient, qs } from './googleApi.ts';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_UNITS = {
  list: 5,
  get: 20,
  thread: 40,
  history: 2,
  profile: 1,
  watch: 100,
  sendAs: 1,
} as const;

/** The headers asked for on metadata reads (§12.3). */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Date',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References',
  'List-Unsubscribe',
  'Auto-Submitted',
  'Precedence',
];

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailListPage {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryPage {
  history?: {
    id: string;
    messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  }[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId: string;
}

export interface GmailSendAs {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  verificationStatus?: string;
}

export interface GmailApi {
  list(q: string, o?: { pageToken?: string; maxResults?: number }): Promise<GmailListPage>;
  metadata(id: string): Promise<GmailMessage>;
  thread(id: string): Promise<{ id: string; historyId?: string; messages?: GmailMessage[] }>;
  history(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;
  profile(): Promise<GmailProfile>;
  watch(topicName: string): Promise<{ historyId?: string; expiration?: string }>;
  sendAs(): Promise<GmailSendAs[]>;
}

export function gmailApi(client: GoogleClient, userId: string): GmailApi {
  const get = <T>(path: string, units: number) =>
    client.request<T>(userId, { url: `${GMAIL_BASE}${path}`, units });
  return {
    list: (q, o = {}) =>
      get(`/messages${qs({ q, maxResults: o.maxResults ?? 500, pageToken: o.pageToken })}`, GMAIL_UNITS.list),
    metadata: (id) =>
      get(
        `/messages/${encodeURIComponent(id)}${qs({ format: 'metadata', metadataHeaders: METADATA_HEADERS })}`,
        GMAIL_UNITS.get,
      ),
    thread: (id) => get(`/threads/${encodeURIComponent(id)}${qs({ format: 'full' })}`, GMAIL_UNITS.thread),
    history: (startHistoryId, pageToken) =>
      get(
        `/history${qs({ startHistoryId, historyTypes: 'messageAdded', maxResults: 500, pageToken })}`,
        GMAIL_UNITS.history,
      ),
    profile: () => get('/profile', GMAIL_UNITS.profile),
    watch: (topicName) =>
      client.request(userId, {
        url: `${GMAIL_BASE}/watch`,
        method: 'POST',
        body: { topicName, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' },
        units: GMAIL_UNITS.watch,
      }),
    sendAs: async () =>
      (await get<{ sendAs?: GmailSendAs[] }>('/settings/sendAs', GMAIL_UNITS.sendAs)).sendAs ?? [],
  };
}

// ---- reading a message ----------------------------------------------------------------------------------------------

/** Header lookup by lower-cased name. */
export function headerMap(part: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!(k in out)) out[k] = h.value;
  }
  return out;
}

/** Gmail's base64url body data as text. */
export function decodeBody(data: string | undefined): string {
  if (!data) return '';
  try {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

/** The first text/plain part, else the first text/html part (as HTML), skipping attachments. */
export function findBody(part: GmailPart | undefined): { text?: string; html?: string } {
  const out: { text?: string; html?: string } = {};
  const walk = (p: GmailPart | undefined) => {
    if (!p || (p.filename && p.body?.attachmentId)) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (mime === 'text/plain' && out.text === undefined && p.body?.data) out.text = decodeBody(p.body.data);
    else if (mime === 'text/html' && out.html === undefined && p.body?.data)
      out.html = decodeBody(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return out;
}
