/**
 * The RFC 5322 message Gmail's users.messages.send takes as `raw` (base64url): plain text in UTF-8 (base64 body),
 * RFC 2047 encoded headers when they are not ASCII, threading headers for replies, and X-Orbit-Draft-Id so a sent
 * message can be traced back to its draft (§16.3).
 */
import { base64url } from '../crypto.ts';

export interface MimeInput {
  from: string;
  fromName?: string;
  to: string;
  toName?: string;
  /** one address in copy (plan 29 §A4: the friend who asked for the intro rides along on the forward) */
  cc?: string;
  ccName?: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  draftId: string;
  /** Date header; defaults to now */
  date?: Date;
  /** files sent with it (a resume): the message becomes multipart/mixed, the text first */
  attachments?: MimeAttachment[];
}

export interface MimeAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** A header value, RFC 2047 B-encoded when it is not plain ASCII; CR and LF never pass through. */
export function headerValue(s: string): string {
  const one = s.replace(/[\r\n]+/g, ' ').trim();
  if (ascii(one)) return one;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(one)))}?=`;
}

function address(email: string, name?: string): string {
  const e = email.replace(/[\r\n<>]/g, '').trim();
  if (!name) return e;
  const n = name.replace(/[\r\n"]/g, '').trim();
  return ascii(n) ? `"${n}" <${e}>` : `${headerValue(n)} <${e}>`;
}

/** Message-ids as written in In-Reply-To and References: each wrapped in angle brackets. */
export function msgIds(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith('<') ? x : `<${x}>`));
  return ids.length ? ids.join(' ') : undefined;
}

function b64Lines(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join('\r\n');
}

/** A file name for Content-Disposition: plain ASCII as is (quotes escaped), otherwise RFC 2231 UTF-8. */
function fileParam(name: string): string {
  const n = name.replace(/[\r\n]+/g, ' ').trim() || 'file';
  if (ascii(n)) return `filename="${n.replace(/(["\\])/g, '\\$1')}"`;
  const enc = [...new TextEncoder().encode(n)]
    .map((b) =>
      /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
  return `filename*=UTF-8''${enc}`;
}

/** A MIME type safe for a header: type/subtype in token characters, or a generic binary type. */
function safeType(t: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t : 'application/octet-stream';
}

export function buildMime(m: MimeInput): string {
  const lines = [
    `From: ${address(m.from, m.fromName)}`,
    `To: ${address(m.to, m.toName)}`,
    ...(m.cc ? [`Cc: ${address(m.cc, m.ccName)}`] : []),
    `Subject: ${headerValue(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    `X-Orbit-Draft-Id: ${m.draftId}`,
  ];
  const irt = msgIds(m.inReplyTo);
  if (irt) lines.push(`In-Reply-To: ${irt}`);
  const refs = msgIds(m.references ?? m.inReplyTo);
  if (refs) lines.push(`References: ${refs}`);
  const body = b64Lines(new TextEncoder().encode(m.body.replace(/\r?\n/g, '\r\n')));
  const files = m.attachments ?? [];
  if (!files.length) {
    lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    return `${lines.join('\r\n')}\r\n\r\n${body}\r\n`;
  }
  const boundary = `orbit-${m.draftId.replace(/[^\w-]/g, '')}-${files.length}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body].join('\r\n'),
    ...files.map((f) =>
      [
        `Content-Type: ${safeType(f.mimeType)}`,
        `Content-Disposition: attachment; ${fileParam(f.name)}`,
        'Content-Transfer-Encoding: base64',
        '',
        b64Lines(f.bytes),
      ].join('\r\n'),
    ),
  ];
  return `${lines.join('\r\n')}\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
}

/** The `raw` field: the whole message, base64url. */
export function rawMessage(m: MimeInput): string {
  return base64url(new TextEncoder().encode(buildMime(m)));
}
