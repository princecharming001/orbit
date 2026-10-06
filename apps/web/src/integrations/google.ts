// Client-side Google: Google Identity Services token flow, Gmail and Calendar REST.
// Tokens live in memory + sessionStorage (1 hour). After the first full grant, reconnecting does not show the consent
// screen again; Google only asks when a permission is missing.
import { envGoogleClientId, readPrefs } from './prefs';

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Orbit only reads calendar events, so it asks for read-only access. */
export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

export const GOOGLE_SCOPES = [
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE,
  CALENDAR_READ_SCOPE,
  'openid',
  'email',
  'profile',
];

interface TokenState {
  accessToken: string;
  expiresAt: number;
  email?: string;
  /** the scopes Google actually granted (the student can untick some on the consent screen) */
  scopes?: string[];
}
const TOKEN_KEY = 'orbit.google.token';
const GRANTED_KEY = 'orbit.google.granted';

/** Parse the space-separated `scope` string of a GIS token response. */
export function parseGrantedScopes(scope: string | undefined): string[] | undefined {
  const list = (scope ?? '').split(/\s+/).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * What the student cannot do with the permissions they granted, in plain words, or undefined when everything Orbit
 * needs was granted. An unknown grant (older connections stored no scopes) is treated as complete.
 */
export function googleScopeWarning(scopes: string[] | undefined): string | undefined {
  if (!scopes?.length) return undefined;
  const has = (s: string) => scopes.includes(s);
  const missing: string[] = [];
  if (!has(GMAIL_READ_SCOPE)) missing.push('read your email, so Orbit cannot sync your conversations');
  if (!has(GMAIL_SEND_SCOPE))
    missing.push('send email, so approved emails will open in your mail app instead');
  if (!has(CALENDAR_READ_SCOPE) && !has('https://www.googleapis.com/auth/calendar.readonly'))
    missing.push('read your calendar, so Orbit cannot see your coffee chats');
  if (!missing.length) return undefined;
  return `Google did not give Orbit permission to ${missing.join(', or to ')}. Reconnect and allow every permission to fix this.`;
}

/** True when the grant allows sending; an unknown grant (no scopes stored) counts as allowed. */
export function canSendWith(scopes: string[] | undefined): boolean {
  return !scopes?.length || scopes.includes(GMAIL_SEND_SCOPE);
}

function grantedBefore(): boolean {
  try {
    return localStorage.getItem(GRANTED_KEY) === '1';
  } catch {
    return false;
  }
}
function setGrantedBefore(v: boolean) {
  try {
    if (v) localStorage.setItem(GRANTED_KEY, '1');
    else localStorage.removeItem(GRANTED_KEY);
  } catch {}
}

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
              scope?: string;
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

/**
 * Ask Google for a token. The first connection shows the consent screen; later reconnects (the token lasts an hour)
 * pass an empty prompt so Google skips it unless a permission is still missing.
 */
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
          scopes: parseGrantedScopes(r.scope),
        };
        // skip the consent screen next time only when everything was granted
        setGrantedBefore(!googleScopeWarning(state.scopes));
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
    tc.requestAccessToken({ prompt: opts.prompt ?? (grantedBefore() ? '' : 'consent') });
  });
}

export function disconnectGoogle(): void {
  const t = loadToken();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.accessToken);
  saveToken(undefined);
  // the grant was revoked, so the next connection must show the consent screen
  setGrantedBefore(false);
}

/** Retry policy for Google API calls; tests shorten the delays. */
export const gfetchRetry = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 32_000,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    const at = Number.isFinite(secs) ? secs * 1000 : new Date(ra).getTime() - Date.now();
    if (Number.isFinite(at) && at >= 0) return Math.min(at, gfetchRetry.maxDelayMs);
  }
  const exp = gfetchRetry.baseDelayMs * 2 ** attempt;
  return Math.min(exp + Math.random() * gfetchRetry.baseDelayMs, gfetchRetry.maxDelayMs);
}

async function isScope403(res: Response): Promise<boolean> {
  try {
    const j = (await res.clone().json()) as {
      error?: { errors?: { reason?: string }[]; message?: string; details?: { reason?: string }[] };
    };
    return (
      (j.error?.errors ?? []).some((e) => e.reason === 'insufficientPermissions') ||
      (j.error?.details ?? []).some((d) => d.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
      /insufficient authentication scopes/i.test(j.error?.message ?? '')
    );
  } catch {
    return false;
  }
}

async function isRateLimited403(res: Response): Promise<boolean> {
  try {
    const j = (await res.clone().json()) as { error?: { errors?: { reason?: string }[]; status?: string } };
    return (
      j.error?.status === 'RESOURCE_EXHAUSTED' ||
      (j.error?.errors ?? []).some((e) => !!e.reason && RATE_LIMIT_REASONS.has(e.reason))
    );
  } catch {
    return false;
  }
}

/**
 * Authorised fetch with bounded retries: 429 and Gmail's 403 rate-limit responses back off exponentially (honouring
 * Retry-After); 5xx is retried only for idempotent GETs so a send is never duplicated.
 */
async function gfetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  for (let attempt = 0; ; attempt++) {
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
    const retryable =
      res.status === 429 ||
      (res.status === 403 && (await isRateLimited403(res))) ||
      (method === 'GET' && res.status >= 500);
    if (retryable && attempt < gfetchRetry.maxRetries) {
      await gfetchRetry.sleep(retryDelayMs(res, attempt));
      continue;
    }
    if (retryable && (res.status === 429 || res.status === 403))
      throw new Error('Google is rate limiting Orbit right now. Try again in a few minutes.');
    if (res.status === 403 && (await isScope403(res)))
      throw new Error(
        'Google did not give Orbit permission for this. Reconnect Google in Settings and allow every permission.',
      );
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
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
  if (!text && html)
    text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
  return { text: text.replace(/\r\n/g, '\n').trim(), html };
}

export function gmailHeaders(msg: GmailMessageRaw): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

// ---------- outgoing MIME ----------

/** Header values never carry CR/LF: a newline in a subject would otherwise start a new header. */
export function sanitizeHeaderValue(v: string): string {
  const noControls = Array.from(v.replace(/[\r\n]+/g, ' '))
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || (c >= 32 && c !== 127);
    })
    .join('');
  return noControls.replace(/\s{2,}/g, ' ').trim();
}

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded words (UTF-8, base64), each at most 64 characters, never splitting a character. */
export function encodeWords(text: string): string[] {
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const ch of text) {
    const n = new TextEncoder().encode(ch).length;
    // 39 source bytes -> 52 base64 chars + 12 for =?UTF-8?B??= = 64, so even "Subject: " + a word fits in 78
    if (chunkBytes + n > 39) {
      words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
  return words;
}

/** Fold a header at whitespace so no line exceeds 78 characters (RFC 5322 2.2.3). */
export function foldHeader(name: string, tokens: string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const tok of tokens) {
    if (line.length + 1 + tok.length > 78 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${tok}`;
    } else line += ` ${tok}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

function unstructuredHeader(name: string, value: string): string {
  const v = sanitizeHeaderValue(value);
  return foldHeader(name, isPrintableAscii(v) ? v.split(' ').filter(Boolean) : encodeWords(v));
}

function addressHeader(name: string, email: string, displayName?: string): string {
  const addr = sanitizeHeaderValue(email);
  if (!/^[^\s<>(),;:"@]+@[^\s<>(),;:"@]+$/.test(addr)) throw new Error(`Invalid email address: ${addr}`);
  const dn = displayName ? sanitizeHeaderValue(displayName) : '';
  if (!dn) return `${name}: ${addr}`;
  const phrase = isPrintableAscii(dn)
    ? /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(dn)
      ? [dn]
      : [`"${dn.replace(/(["\\])/g, '\\$1')}"`]
    : encodeWords(dn);
  return foldHeader(name, [...phrase, `<${addr}>`]);
}

/** Message-ID tokens (`<...>`) from a header value, deduplicated, in order. */
export function messageIdTokens(...values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values)
    for (const m of sanitizeHeaderValue(v ?? '').match(/<[^<>\s]+>/g) ?? [])
      if (!out.includes(m)) out.push(m);
  return out;
}

export interface MimeOptions {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  fromEmail: string;
  inReplyTo?: string;
  /** full References chain of the message being answered (its References plus its Message-ID) */
  references?: string;
  orbitId: string;
}

/** Build an RFC 5322 message: encoded and folded headers, CR/LF neutralised, base64 UTF-8 body. */
export function buildMimeMessage(opts: MimeOptions): string {
  const subject = sanitizeHeaderValue(opts.subject);
  if (!subject) throw new Error('This email has no subject.');
  const lines = [
    addressHeader('From', opts.fromEmail, opts.fromName),
    addressHeader('To', opts.to),
    unstructuredHeader('Subject', subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `X-Orbit-Message-Id: ${sanitizeHeaderValue(opts.orbitId).replace(/[^\w.-]/g, '')}`,
  ];
  const inReplyTo = messageIdTokens(opts.inReplyTo)[0];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  const refs = messageIdTokens(opts.references, inReplyTo);
  if (refs.length) lines.push(foldHeader('References', refs));
  const body = opts.body.replace(/\r?\n/g, '\r\n');
  const b64 = utf8Base64(body).replace(/.{76}(?=.)/g, '$&\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${b64}\r\n`;
}

export async function gmailSend(
  opts: MimeOptions & { threadId?: string },
): Promise<{ id: string; threadId: string }> {
  const raw = buildMimeMessage(opts);
  const b64 = utf8Base64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
