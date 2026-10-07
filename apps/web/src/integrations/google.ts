// Client-side Google: Google Identity Services token flow, Gmail and Calendar REST.
// Tokens live in memory + sessionStorage (1 hour); the user re-consents when expired.
import { htmlToText } from '@orbit/core';
import { envGoogleClientId, readPrefs } from './prefs';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
  'profile',
];

interface TokenState {
  accessToken: string;
  expiresAt: number;
  email?: string;
}
const TOKEN_KEY = 'orbit.google.token';

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (r: {
              access_token?: string;
              expires_in?: number;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): { requestAccessToken(o?: { prompt?: string }): void };
          revoke(token: string, cb?: () => void): void;
        };
      };
    };
  }
}

export function googleClientId(): string | undefined {
  return readPrefs().googleClientId || envGoogleClientId();
}

function loadToken(): TokenState | undefined {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as TokenState | null;
    return t && t.expiresAt > Date.now() + 30_000 ? t : undefined;
  } catch {
    return undefined;
  }
}
function saveToken(t: TokenState | undefined) {
  if (!t) sessionStorage.removeItem(TOKEN_KEY);
  else sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

export function currentGoogleToken(): TokenState | undefined {
  return loadToken();
}

let gisPromise: Promise<void> | undefined;
export function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load Google Identity Services'));
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export async function connectGoogle(opts: { prompt?: 'consent' | '' } = {}): Promise<TokenState> {
  const clientId = googleClientId();
  if (!clientId) throw new Error('No Google OAuth client ID configured. Add it in Settings → Integrations.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const tc = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPES.join(' '),
      callback: async (r) => {
        if (r.error || !r.access_token)
          return reject(new Error(r.error_description ?? r.error ?? 'Google sign-in failed'));
        const state: TokenState = {
          accessToken: r.access_token,
          expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
        };
        try {
          const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${state.accessToken}` },
          }).then((x) => x.json());
          state.email = me.email;
        } catch {}
        saveToken(state);
        resolve(state);
      },
      error_callback: (e) => reject(new Error(e.message ?? e.type)),
    });
    tc.requestAccessToken({ prompt: opts.prompt ?? 'consent' });
  });
}

export function disconnectGoogle(): void {
  const t = loadToken();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.accessToken);
  saveToken(undefined);
}

async function gfetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const t = loadToken();
  if (!t) throw new Error('Google is not connected (token expired). Reconnect in Settings → Integrations.');
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t.accessToken}` },
  });
  if (res.status === 401) {
    saveToken(undefined);
    throw new Error('Google session expired. Reconnect in Settings → Integrations.');
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return gfetch(url, init);
  }
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
  headers?: GmailHeader[];
}
export interface GmailMessageRaw {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export async function gmailListIds(q: string, max = 500): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', q);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await gfetch<{ messages?: { id: string }[]; nextPageToken?: string }>(url.toString());
    for (const m of r.messages ?? []) ids.push(m.id);
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export async function gmailGet(id: string, format: 'metadata' | 'full' = 'full'): Promise<GmailMessageRaw> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
  url.searchParams.set('format', format);
  if (format === 'metadata')
    for (const h of [
      'From',
      'To',
      'Cc',
      'Subject',
      'Date',
      'List-Unsubscribe',
      'Precedence',
      'Auto-Submitted',
      'Message-ID',
      'In-Reply-To',
      'References',
    ])
      url.searchParams.append('metadataHeaders', h);
  return gfetch<GmailMessageRaw>(url.toString());
}

function b64urlDecode(data: string): string {
  const s = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '='));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function gmailExtractText(msg: GmailMessageRaw): { text: string; html?: string } {
  let text = '';
  let html: string | undefined;
  const walk = (p?: GmailMessagePart) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !text) text = b64urlDecode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64urlDecode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  if (!text && html) text = htmlToText(html);
  return { text: text.replace(/\r\n/g, '\n').trim(), html };
}

export function gmailHeaders(msg: GmailMessageRaw): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

export async function gmailSend(opts: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  fromEmail: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  orbitId: string;
}): Promise<{ id: string; threadId: string }> {
  const lines = [
    `From: ${opts.fromName ? `${opts.fromName} <${opts.fromEmail}>` : opts.fromEmail}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    `X-Orbit-Message-Id: ${opts.orbitId}`,
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  const raw = `${lines.join('\r\n')}\r\n\r\n${opts.body}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return gfetch<{ id: string; threadId: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64, threadId: opts.threadId }),
    },
  );
}

export interface GcalEventRaw {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: {
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { uri?: string }[] };
  /** When the invite was created (RFC 3339). */
  created?: string;
}

export async function gcalList(timeMin: Date, timeMax: Date): Promise<GcalEventRaw[]> {
  const out: GcalEventRaw[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('orderBy', 'startTime');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await gfetch<{ items?: GcalEventRaw[]; nextPageToken?: string }>(url.toString());
    out.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}
