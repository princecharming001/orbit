import { emailDomain, emailLocalPart, normalizeEmail } from './normalize';

const BULK_LOCAL =
  /^(no[-_.]?reply|donotreply|invitations?|notify|do-not-reply|notifications?|newsletter|mailer-daemon|postmaster|bounce|alerts?|updates?|info|news|digest|support|team|hello|marketing|billing|invoices?|receipts?|careers|jobs|recruiting|talent|hr|noreply-.*|.*-noreply|.*-notifications?)$/i;

/**
 * Domains used only to send machine mail: a sender on one of these (or a subdomain) is automated whatever the
 * local part says. No real employer's people send mail from these.
 */
export const NOTIFICATION_DOMAINS = new Set([
  'facebookmail.com',
  'mail.instagram.com',
  'mcsv.net',
  'mcdlv.net',
  'list-manage.com',
  'sendgrid.net',
  'hubspotemail.net',
  'amazonses.com',
  'mandrillapp.com',
  'mailgun.org',
  'calendar-notification.google.com',
  'accounts.google.com',
  'docs.google.com',
  'mail.coursera.org',
  'canvas.instructure.com',
  'notifications.instructure.com',
  'greenhouse-mail.io',
  'hire.lever.co',
  'myworkday.com',
  'talent.icims.com',
  'reddithelp.com',
]);
/** Former name of NOTIFICATION_DOMAINS. */
export const BULK_DOMAINS = NOTIFICATION_DOMAINS;

/**
 * Companies that send a lot of machine mail but also employ people students network with (and recruit at). Their
 * apex domain is human unless the local part, the headers or the Gmail labels say otherwise; their mail-sending
 * subdomains (e.linkedin.com, email.chase.com, notify.robinhood.com) are automated.
 */
export const EMPLOYER_MAIL_DOMAINS = new Set([
  'linkedin.com',
  'google.com',
  'capitalone.com',
  'chase.com',
  'jpmorgan.com',
  'jpmchase.com',
  'paypal.com',
  'venmo.com',
  'coinbase.com',
  'robinhood.com',
  'doordash.com',
  'uber.com',
  'ubereats.com',
  'indeed.com',
  'glassdoor.com',
  'pinterest.com',
  'tiktok.com',
  'bytedance.com',
  'medium.com',
  'substack.com',
  'quora.com',
  'lever.co',
  'greenhouse.io',
  'joinhandshake.com',
  'handshake.com',
  'ziprecruiter.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'instructure.com',
  'piazza.com',
  'gradescope.com',
  'icims.com',
  'smartrecruiters.com',
  'ashbyhq.com',
  'eventbrite.com',
  'meetup.com',
  'ticketmaster.com',
  'morningbrew.com',
  'theskimm.com',
  'mailchimp.com',
  'coursera.org',
]);

export interface HeaderLike {
  'list-unsubscribe'?: string;
  'list-id'?: string;
  precedence?: string;
  'auto-submitted'?: string;
  'x-autoreply'?: string;
  'x-autorespond'?: string;
  sender?: string;
  'x-mailer'?: string;
  [k: string]: string | undefined;
}

function isNotificationDomain(domain: string): boolean {
  if (NOTIFICATION_DOMAINS.has(domain)) return true;
  for (const d of NOTIFICATION_DOMAINS) if (domain.endsWith(`.${d}`)) return true;
  // a mail-sending subdomain of a big sender (e.linkedin.com, email.chase.com); the apex domain stays human
  for (const d of EMPLOYER_MAIL_DOMAINS) if (domain.endsWith(`.${d}`)) return true;
  return false;
}

/** True when the message is a vacation/out-of-office auto-reply, judged from headers and subject only. */
export function isAutoReply(headers: HeaderLike = {}, subject = ''): boolean {
  const auto = (headers['auto-submitted'] ?? '').toLowerCase();
  if (auto.startsWith('auto-replied')) return true;
  const xa = (headers['x-autoreply'] ?? headers['x-autorespond'] ?? '').toLowerCase();
  if (xa && xa !== 'no') return true;
  return /^\s*(automatic reply|auto(matic)?[- ]?reply|autoreply|out of (the )?office|ooo\b|abwesenheitsnotiz|r[ée]ponse automatique|respuesta autom[áa]tica)/i.test(
    subject,
  );
}

/** Calendar invitations and responses (Google Calendar, Outlook). The calendar sync handles these, not the inbox. */
export function isCalendarNotice(subject = '', body = '', headers: HeaderLike = {}): boolean {
  if (/calendarmessage/i.test(headers['content-class'] ?? '')) return true;
  if (/calendar-notification@google\.com/i.test(headers.sender ?? '')) return true;
  return (
    /^\s*(updated invitation|invitation|accepted|declined|tentatively accepted|canceled event|cancelled event|event canceled|new event)( with note)?\s*:/i.test(
      subject,
    ) &&
    /(google calendar|invitation from|join (with )?(google meet|zoom|microsoft teams)|view all guest info|reply for |more options|\.ics\b|outlook)/i.test(
      body,
    )
  );
}

/**
 * Machine mail. Decided by headers (List-Unsubscribe, List-Id, Precedence, Auto-Submitted, X-Autoreply, a Sender
 * that is a notification address), Gmail category labels, a bulk local part (noreply@, notifications@) and
 * notification-only domains. A person's address at a company that also sends bulk mail (Capital One, LinkedIn)
 * is human.
 */
export function isAutomatedSender(
  fromEmail: string,
  headers: HeaderLike = {},
  labels: string[] = [],
): boolean {
  if (headers['list-unsubscribe'] || headers['list-id']) return true;
  const prec = (headers.precedence ?? '').toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk' || prec === 'auto_reply') return true;
  const auto = (headers['auto-submitted'] ?? '').toLowerCase();
  if (auto && auto !== 'no') return true;
  const xa = (headers['x-autoreply'] ?? headers['x-autorespond'] ?? '').toLowerCase();
  if (xa && xa !== 'no') return true;
  if (headers.sender) {
    const sender = parseAddress(headers.sender).email;
    if (sender.includes('@') && sender !== normalizeEmail(fromEmail)) {
      if (sender === 'calendar-notification@google.com') return true;
      if (BULK_LOCAL.test(emailLocalPart(sender)) || isNotificationDomain(emailDomain(sender))) return true;
    }
  }
  if (labels.some((l) => /CATEGORY_(PROMOTIONS|SOCIAL|FORUMS|UPDATES)/i.test(l))) return true;
  const local = emailLocalPart(fromEmail);
  if (BULK_LOCAL.test(local)) return true;
  return isNotificationDomain(emailDomain(fromEmail));
}

// ---------------------------------------------------------------------------------------------------------------
// addresses

/** Parse one address: `"Doe, Jane" <jane@x.com>`, `Jane Doe <jane@x.com>` or `jane@x.com`. */
export function parseAddress(raw: string): { email: string; name?: string } {
  const s = raw.trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1]!
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/\\"/g, '"')
      .trim();
    return { email: normalizeEmail(m[2]!), name: name || undefined };
  }
  return { email: normalizeEmail(s.replace(/^mailto:/i, '')) };
}

/** Split an address-list header on commas and semicolons that are outside quotes, angle brackets and comments. */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\\' && quoted) {
      cur += c + (raw[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && c === '(') paren++;
    else if (!quoted && c === ')') paren = Math.max(0, paren - 1);
    if (!quoted && !angle && !paren && (c === ',' || c === ';')) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return (
    out
      // group syntax ("undisclosed-recipients:;" or "Team: a@x.com, b@x.com;")
      .map((s) => s.replace(/^[^"<@]*:\s*/, '').trim())
      .filter((s) => s.includes('@'))
  );
}

// ---------------------------------------------------------------------------------------------------------------
// HTML

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '-',
  mdash: ', ',
  hellip: '...',
  bull: '•',
  middot: '·',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/**
 * HTML mail to plain text. Drops head/style/script and the quoted-history containers that Gmail, Outlook,
 * Apple Mail and Yahoo use, keeps line structure, and keeps link targets ("here (https://calendly.com/x)") so
 * scheduling links survive.
 */
export function htmlToText(html: string): string {
  let h = html.replace(/\r\n/g, '\n');
  h = h.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  const quoteStart = h.search(
    /<div[^>]*class="[^"]*\b(gmail_quote|yahoo_quoted)\b[^"]*"|<div[^>]*id="(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)"|<blockquote[^>]*type="cite"/i,
  );
  if (quoteStart >= 0) h = h.slice(0, quoteStart);
  h = h.replace(
    /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_all, href: string, inner: string) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
      const url = decodeEntities(href.trim());
      if (!/^https?:\/\//i.test(url)) return text || url.replace(/^mailto:/i, '');
      const bare = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
      if (!text || bare(text) === bare(url)) return url;
      return `${text} (${url})`;
    },
  );
  h = h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|ul|ol|section|article|header|footer)>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(h)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------
// quoted replies

/** Attribution lines. Gmail hard-wraps long ones, so "On ... <\nemail> wrote:" may span two or three lines. */
const QUOTE_MARKERS: { re: RegExp; needsDateOrAddress?: boolean }[] = [
  { re: /^On\s[^\n]{5,200}(?:\n[^\n]{0,200}){0,2}?\s*wrote:\s*$/m, needsDateOrAddress: true },
  { re: /^-{2,}\s*Original Message\s*-{2,}/im },
  { re: /^-{2,}\s*Forwarded message\s*-{2,}/im },
  { re: /^\*?From:\*?\s.+\n\*?(Sent|To|Date):\*?\s.+/im },
  { re: /^_{10,}\s*$/m },
  { re: /^Le\s[^\n]{5,200}(?:\n[^\n]{0,200})?\sa écrit\s*:/m },
  { re: /^Am\s[^\n]{5,200}(?:\n[^\n]{0,200})?\sschrieb[^\n]*:\s*$/m, needsDateOrAddress: true },
  { re: /^El\s[^\n]{5,200}(?:\n[^\n]{0,200})?\sescribió:\s*$/m, needsDateOrAddress: true },
  { re: /^Op\s[^\n]{5,200}(?:\n[^\n]{0,200})?\sschreef[^\n]*:\s*$/m, needsDateOrAddress: true },
  { re: /^Em\s[^\n]{5,200}(?:\n[^\n]{0,200})?\sescreveu:\s*$/m, needsDateOrAddress: true },
];

const MOBILE_FOOTER =
  /^(sent from my [\w ]{2,30}|sent from (outlook|mail|yahoo mail|gmail)( for [\w ]+)?|get outlook for (ios|android)|sent via [\w ]{2,30}|sent with [\w ]{2,30})\.?$/i;

export function stripQuotedReply(body: string): string {
  let text = body.replace(/\r\n/g, '\n');
  let cut = text.length;
  for (const { re, needsDateOrAddress } of QUOTE_MARKERS) {
    const m = re.exec(text);
    // attribution lines carry a date or an address; this keeps a body sentence that happens to start with "On"
    if (m && m.index < cut && (!needsDateOrAddress || /\d|@/.test(m[0]))) cut = m.index;
  }
  text = text.slice(0, cut);
  // drop trailing '>' quoted lines
  const lines = text.split('\n');
  while (lines.length && /^\s*>/.test(lines[lines.length - 1]!)) lines.pop();
  const kept = lines.filter((l) => !/^\s*>/.test(l));
  // drop mobile footers at the end ("Sent from my iPhone")
  while (kept.length && (!kept[kept.length - 1]!.trim() || MOBILE_FOOTER.test(kept[kept.length - 1]!.trim())))
    kept.pop();
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------
// signatures

const CLOSER =
  /^(?:(?:best|kind|warm|warmest|many|with)(?:\s+(?:regards|wishes|thanks|gratitude))?|regards|thanks?(?:\s+(?:so\s+much|again|a\s+lot|a\s+ton|in\s+advance|for\s+your\s+time))?|thank\s+you(?:\s+(?:so\s+much|again|for\s+your\s+time))?|cheers|sincerely(?:\s+yours)?|yours(?:\s+truly)?|warmly|talk\s+soon|speak\s+soon|take\s+care|all\s+the\s+best|looking\s+forward(?:\s+to\s+it)?|gratefully|respectfully|best\s+of\s+luck)\s*[,.!]*\s*(?:-\s*[A-Z][a-z]+)?$/i;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;
const CONTACT =
  /(\+?\d[\d\s().-]{7,}\d)|(linkedin\.com\/in\/)|(https?:\/\/)|(\bwww\.)|([\w.+-]+@[\w-]+\.[\w.]+)/i;
/** Scheduling and meeting links are content, never the start of a signature. */
const MEETING_URL =
  /(calendly\.com|\bcal\.com|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|savvycal\.com|meetings\.hubspot\.com|webex\.com|doodle\.com|whereby\.com|chilipiper\.com)/i;
const DISCLAIMER = /(confidential|intended recipient|privileged|disclaimer|pronouns?:)/i;
const GREETING = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b[^\n]{0,40}$/i;
const TITLE_WORDS =
  /(engineer|manager|director|analyst|associate|partner|founder|ceo|cto|coo|cfo|vp|vice president|head of|lead|recruiter|consultant|scientist|designer|product|intern|student|professor|md\b|phd)/i;

function words(l: string): number {
  return l.trim() ? l.trim().split(/\s+/).length : 0;
}
/** A line that can sit in a signature block: short, not a sentence, not a question, not a meeting link. */
function sigLike(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (MOBILE_FOOTER.test(l) || DISCLAIMER.test(l)) return true;
  if (MEETING_URL.test(l) && words(l) > 1) return false;
  if (l.includes('?')) return false;
  if (l.length > 100 || words(l) > 10) return false;
  if (/[.!]$/.test(l) && words(l) >= 4 && !CONTACT.test(l)) return false;
  return true;
}
function contentBefore(lines: string[], idx: number): boolean {
  return lines.slice(0, idx).some((l) => l.trim() && !GREETING.test(l.trim()));
}

function findSignatureStart(lines: string[]): number {
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = tailStart; i < lines.length; i++) if (/^--\s*$/.test(lines[i]!)) return i;
  const restSigLike = (i: number) => lines.slice(i + 1).every(sigLike);
  // the last closer ("Best,", "Thanks so much,") whose following lines all look like a signature
  for (let i = lines.length - 1; i >= tailStart; i--) {
    const l = lines[i]!.trim();
    if (!l) continue;
    if (CLOSER.test(l)) {
      if (restSigLike(i) && contentBefore(lines, i)) return i;
      break;
    }
    if (!sigLike(l)) break;
  }
  // no closer: a name line followed by a title or contact line, or a short block of contact lines
  for (let i = tailStart; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l || !sigLike(l) || !restSigLike(i) || !contentBefore(lines, i)) continue;
    const next = lines.slice(i + 1).find((x) => x.trim()) ?? '';
    const isName = /^[A-Z][a-z'-]+(\s[A-Z][a-z'.-]*){0,3}$/.test(l);
    if (isName && (TITLE_WORDS.test(next) || (CONTACT.test(next) && !MEETING_URL.test(next)))) return i;
    if (CONTACT.test(l) && !MEETING_URL.test(l) && words(l) <= 5 && !/[.!?]$/.test(l)) return i;
    if (MOBILE_FOOTER.test(l)) return i;
  }
  return -1;
}

export interface SignatureInfo {
  body: string;
  signature?: string;
  title?: string;
  company?: string;
  phone?: string;
  linkedinUrl?: string;
}

/**
 * Split the signature off a (quote-stripped) body. A signature starts at "--", at the last closer line ("Best,")
 * when everything after it looks like a signature, or at a name-plus-title/contact block. A line with a Calendly,
 * Zoom, Meet or Teams link, or a sentence that mentions a phone number, stays in the body.
 */
export function splitSignature(body: string): SignatureInfo {
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const start = findSignatureStart(lines);
  if (start < 0) return { body: body.trim() };
  const sig = lines.slice(start).join('\n');
  const info: SignatureInfo = { body: lines.slice(0, start).join('\n').trim(), signature: sig.trim() };
  const sigLines = sig
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  const phone = sigLines
    .filter((l) => !/https?:\/\/|www\./i.test(l))
    .join('\n')
    .match(PHONE);
  if (phone) info.phone = phone[0].trim();
  const li = sig.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i);
  if (li) info.linkedinUrl = li[0];
  for (const l of sigLines) {
    if (CLOSER.test(l)) continue;
    const pipe = l.split(/\s*[|•·,]\s*/);
    if (pipe.length >= 2 && TITLE_WORDS.test(pipe[0]!)) {
      info.title = pipe[0];
      info.company = pipe[1];
      break;
    }
    const at = l.match(/^(.{3,60}?)\s+(?:at|@)\s+(.{2,60})$/i);
    if (at && TITLE_WORDS.test(at[1]!)) {
      info.title = at[1]!.trim();
      info.company = at[2]!.trim();
      break;
    }
    if (!info.title && TITLE_WORDS.test(l) && l.length < 60 && !/@|http/.test(l)) info.title = l;
  }
  return info;
}

export function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
