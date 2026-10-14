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
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  draftId: string;
  /** Date header; defaults to now */
  date?: Date;
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

export function buildMime(m: MimeInput): string {
  const lines = [
    `From: ${address(m.from, m.fromName)}`,
    `To: ${address(m.to, m.toName)}`,
    `Subject: ${headerValue(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `X-Orbit-Draft-Id: ${m.draftId}`,
  ];
  const irt = msgIds(m.inReplyTo);
  if (irt) lines.push(`In-Reply-To: ${irt}`);
  const refs = msgIds(m.references ?? m.inReplyTo);
  if (refs) lines.push(`References: ${refs}`);
  const body = m.body.replace(/\r?\n/g, '\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${b64Lines(new TextEncoder().encode(body))}\r\n`;
}

/** The `raw` field: the whole message, base64url. */
export function rawMessage(m: MimeInput): string {
  return base64url(new TextEncoder().encode(buildMime(m)));
}
