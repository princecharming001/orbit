import { emailDomain, emailLocalPart, normalizeEmail } from './normalize';

/** Local parts only machines send from. */
const BULK_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|invitations?|notify|notifications?|newsletters?|mailer|mailer[-_.]daemon|postmaster|bounces?|alerts?|updates?|news|digest|marketing|billing|invoices?|receipts?|dse(_\w+)?|automated|system|calendar|no[-_.]?reply[-_.+].*|.*[-_.+]no[-_.]?reply|.*[-_.]notifications?|.*[-_.]alerts?)$/i;
/**
 * Shared recruiting inboxes (campusrecruiting@, university-recruiting@, earlycareers@, careers@): a team, not a
 * person. Every token of the local part has to be a role word, so jane.recruiter@ stays a person.
 */
const ROLE_TOKEN =
  /^(recruit|recruits|recruiting|recruitment|recruiter|campus|campusrecruiting|universityrecruiting|collegerecruiting|earlycareers?|careers?|jobs?|talent|talentacquisition|ta|hr|people|hiring|staffing|university|college|early|students?|programs?|internships?|interns|graduates?|grad|admissions|events|relations|ur|acquisition)$/i;
/** Generic inboxes a founder or small team may answer personally (hello@, team@): human only with a person's name on it. */
const GENERIC_LOCAL =
  /^(team|hello|hi|hey|info|support|contact|help|office|admin|founders|general|inquiries|enquiries)$/i;
/** Display names of teams and systems: "Goldman Sachs University Recruiting", "Stripe Careers", "Figma Team". */
const ROLE_NAME =
  /\b(recruiting|recruitment|careers?|talent( acquisition)?|admissions|human resources|university relations|campus|early careers|team|notifications?|no-?reply|support|newsletter|digest|alerts?|calendar|via linkedin|hiring)\b/i;

/** True when a display name names a team or a system rather than a person. */
export function isRoleName(displayName: string | undefined): boolean {
  return Boolean(displayName) && ROLE_NAME.test(displayName!);
}

/** A shared inbox local part: all role words (campus.recruiting, university-recruiting, earlycareers). */
export function isRoleLocalPart(local: string): boolean {
  const tokens = local
    .toLowerCase()
    .split(/[._+-]+/)
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => ROLE_TOKEN.test(t));
}

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
  'docusign.net',
  'beehiiv.com',
  'convertkit-mail.com',
  'convertkit-mail2.com',
  'klaviyomail.com',
  'ccsend.com',
  'rsgsv.net',
  'mailchimpapp.net',
  'sparkpostmail.com',
  'mktomail.com',
  'marketo.org',
  'salesforce-mail.com',
  'exacttarget.com',
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
 * Machine or team mail. Decided by headers (List-Unsubscribe, List-Id, Precedence, Auto-Submitted, X-Autoreply, a
 * Sender that is a notification address), Gmail category labels, a bulk local part (noreply@, no_reply@,
 * notifications@), a shared recruiting inbox (campusrecruiting@, university-recruiting@), and notification-only
 * domains. A generic inbox (hello@, team@, info@) is automated only without a person's display name, so a founder
 * writing from hello@ is human. A person's address at a company that also sends bulk mail (Capital One, LinkedIn)
 * is human.
 */
export function isAutomatedSender(
  fromEmail: string,
  headers: HeaderLike = {},
  labels: string[] = [],
  displayName?: string,
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
      const sl = emailLocalPart(sender);
      if (BULK_LOCAL.test(sl) || isRoleLocalPart(sl) || isNotificationDomain(emailDomain(sender)))
        return true;
    }
  }
  if (labels.some((l) => /CATEGORY_(PROMOTIONS|SOCIAL|FORUMS|UPDATES)/i.test(l))) return true;
  const local = emailLocalPart(fromEmail);
  if (BULK_LOCAL.test(local) || isRoleLocalPart(local)) return true;
  if (GENERIC_LOCAL.test(local)) {
    const name = (displayName ?? '').trim();
    const personal =
      Boolean(name) && !isRoleName(name) && /^[A-Z][a-z'’-]+(\s+[A-Z][A-Za-z'’.-]+){0,3}$/.test(name);
    if (!personal) return true;
  }
  return isNotificationDomain(emailDomain(fromEmail));
}

// ---------------------------------------------------------------------------------------------------------------
// addresses

function decodeWordBytes(charset: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/\*.*$/, ''), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Decode RFC 2047 encoded words in a header ("=?UTF-8?Q?Jos=C3=A9?= <jose@x.com>", "=?utf-8?B?...?="). Whitespace
 * between two encoded words is dropped, as the RFC requires. Malformed words are left as they are.
 */
export function decodeMimeWords(header: string): string {
  if (!header.includes('=?')) return header;
  return header
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (all, charset: string, enc: string, data: string) => {
      try {
        let bytes: Uint8Array;
        if (enc.toUpperCase() === 'B') {
          const bin = atob(data);
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } else {
          const out: number[] = [];
          const q = data.replace(/_/g, ' ');
          for (let i = 0; i < q.length; i++) {
            if (q[i] === '=' && /^[0-9a-f]{2}$/i.test(q.slice(i + 1, i + 3))) {
              out.push(Number.parseInt(q.slice(i + 1, i + 3), 16));
              i += 2;
            } else out.push(q.charCodeAt(i) & 0xff);
          }
          bytes = Uint8Array.from(out);
        }
        return decodeWordBytes(charset, bytes);
      } catch {
        return all;
      }
    });
}

/** Parse one address: `"Doe, Jane" <jane@x.com>`, `Jane Doe <jane@x.com>`, `=?UTF-8?Q?Jos=C3=A9?= <a@b>` or `jane@x.com`. */
export function parseAddress(raw: string): { email: string; name?: string } {
  const s = decodeMimeWords(raw.trim());
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

const MORE_ENTITIES: Record<string, string> = {
  szlig: 'ß',
  aelig: 'æ',
  AElig: 'Æ',
  oelig: 'œ',
  OElig: 'Œ',
  oslash: 'ø',
  Oslash: 'Ø',
  eth: 'ð',
  ETH: 'Ð',
  thorn: 'þ',
  THORN: 'Þ',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  sbquo: '‚',
  bdquo: '„',
  iexcl: '¡',
  iquest: '¿',
  trade: '™',
  reg: '®',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  rarr: '→',
  larr: '←',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '',
  zwj: '',
  shy: '',
  lrm: '',
  rlm: '',
  ordf: 'ª',
  ordm: 'º',
  micro: 'µ',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
};
/** Accented letters: &eacute; &Agrave; &ntilde; &uuml; &ccedil; &aring; built from the base letter and a mark. */
const MARKS: Record<string, string> = {
  acute: '\u0301',
  grave: '\u0300',
  circ: '\u0302',
  uml: '\u0308',
  tilde: '\u0303',
  ring: '\u030A',
  cedil: '\u0327',
  caron: '\u030C',
};

function namedEntity(name: string): string | undefined {
  const hit = ENTITIES[name.toLowerCase()] ?? MORE_ENTITIES[name] ?? MORE_ENTITIES[name.toLowerCase()];
  if (hit !== undefined) return hit;
  const m = /^([A-Za-z])(acute|grave|circ|uml|tilde|ring|cedil|caron)$/.exec(name);
  if (m) return `${m[1]}${MARKS[m[2]!]}`.normalize('NFC');
  return undefined;
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (n === 0x2014) return ENTITIES.mdash!;
      if (n === 0x2013) return ENTITIES.ndash!;
      if (n === 0xa0) return ' ';
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return namedEntity(code) ?? all;
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
    .replace(/ ,/g, ',')
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
  /\b(engineer|engineering manager|manager|director|analyst|associate|partner|principal|founder|co-?founder|ceo|cto|coo|cfo|cmo|vp|svp|evp|avp|vice president|president|head of|lead|recruiter|sourcer|consultant|scientist|designer|product manager|pm|intern|student|candidate|professor|lecturer|researcher|fellow|md|managing director|officer|specialist|coordinator|advisor|adviser|counsel|attorney|architect|developer|strategist|controller|trader|banker|economist|editor|chair|dean|ta|teaching assistant|program manager|generalist)\b/i;
/** What follows a comma after a title when it is the team, not the employer ("Senior PM, Growth"). */
const TEAM_WORDS =
  /\b(team|group|growth|banking|engineering|marketing|sales|operations|ops|research|strategy|product|design|data|platform|infrastructure|infra|finance|technology|tech|division|coverage|m&a|capital markets|consulting|recruiting|talent|people|legal|security|ads|cloud|payments|analytics|investments?|equity|credit|trading|wealth|risk|ai|ml|machine learning|mobile|web|backend|frontend|core|search|commerce|partnerships|business development|bd|corporate development|communications|policy|healthcare|consumer|enterprise|americas|emea|apac|north america|east|west|university relations|campus)\b/i;
const NAME_LINE =
  /^(?:(?:dr|prof|mr|ms|mrs|mx)\.?\s+)?[A-Z][A-Za-z'’-]+(?:\s+(?:[A-Z][A-Za-z'’.-]*|de|del|da|van|von|der|la|le|bin|al))*(?:,?\s+(?:phd|ph\.d\.|mba|cfa|cpa|md|jd|pe|she\/her|he\/him|they\/them))*$/i;
const ORG_HINT =
  /\b(inc|llc|llp|ltd|corp|co|company|group|partners|capital|bank|university|college|school|institute|labs?|technologies|systems|ventures|holdings|foundation|associates)\b\.?/i;

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
  // "Goldman Sachs & Co. LLC | 200 West Street, New York": pipe-separated blocks run longer than a sentence-free line
  const piped = /\s[|•·]\s/.test(l);
  if (l.length > (piped ? 140 : 100) || words(l) > (piped ? 18 : 10)) return false;
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
 * Zoom, Meet or Teams link, or a sentence that mentions a phone number, stays in the body. `name` (the sender's
 * display name) is removed before the title and company are read.
 */
export function splitSignature(body: string, opts: { name?: string } = {}): SignatureInfo {
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
  Object.assign(info, parseTitleCompany(sigLines, opts.name));
  return info;
}

function sameAsName(seg: string, name: string): boolean {
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/^(dr|prof|mr|ms|mrs|mx)\.?\s+/, '')
      .replace(/,.*$/, '')
      .replace(/[^a-z ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const n = norm(name);
  const t = norm(seg);
  return Boolean(n) && (t === n || n.split(' ').every((w) => t.split(' ').includes(w)));
}

function looksLikeName(seg: string, name?: string): boolean {
  const t = seg.trim();
  if (!t || TITLE_WORDS.test(t) || ORG_HINT.test(t) || /\d|@|http|www\./i.test(t)) return false;
  if (name && sameAsName(t, name)) return true;
  return NAME_LINE.test(t) && t.split(/\s+/).length <= 5;
}

/** An employer or school segment: no title word, no digits (addresses, phones), not a link, not a pronoun line. */
function looksLikeOrg(seg: string): boolean {
  const t = seg.trim();
  if (!t || t.length > 60 || TITLE_WORDS.test(t)) return false;
  if (/\d|@|https?:|www\.|linkedin|\b(she|he|they)\/(her|him|them)\b|pronouns/i.test(t)) return false;
  if (CLOSER.test(t) || MOBILE_FOOTER.test(t) || DISCLAIMER.test(t)) return false;
  return /^[A-Z0-9&]/.test(t) || ORG_HINT.test(t);
}

/**
 * Title and employer from signature lines. The sender's name is dropped first (a name line, or a leading "Name |"
 * or "Name," segment). Lines split on | • ·. The first segment with a title word is the title; "Title at Company"
 * and "Title @ Company" split there. A comma after the title keeps a team ("Senior PM, Growth",
 * "Vice President, Investment Banking") and splits off an employer ("Analyst, Goldman Sachs"). The employer is the
 * next segment on the title line, else the next line that reads as an organisation ("Figma", "Cornell University",
 * "Goldman Sachs & Co. LLC | 200 West Street").
 */
export function parseTitleCompany(lines: string[], name?: string): { title?: string; company?: string } {
  const rows = lines
    .map((l) => l.trim())
    .filter((l) => l && !CLOSER.test(l) && !MOBILE_FOOTER.test(l) && !DISCLAIMER.test(l))
    .map((l) =>
      l
        .split(/\s*[|•·]\s*|\s+[-–]\s+/)
        .map((x) => x.trim())
        .filter(Boolean),
    );
  for (let i = 0; i < rows.length; i++) {
    const segs = rows[i]!;
    // drop the name: a "Name, Title" or "Name | Title" lead segment
    while (
      segs.length &&
      looksLikeName(segs[0]!.split(',')[0]!, name) &&
      !TITLE_WORDS.test(segs[0]!.split(',')[0]!)
    ) {
      const first = segs[0]!;
      const comma = first.indexOf(',');
      if (comma > 0 && TITLE_WORDS.test(first.slice(comma + 1))) segs[0] = first.slice(comma + 1).trim();
      else segs.shift();
    }
    const ti = segs.findIndex((x) => TITLE_WORDS.test(x) && !/@\S+\.|https?:/i.test(x) && x.length <= 80);
    if (ti < 0) continue;
    let title = segs[ti]!;
    let company: string | undefined;
    const at = /^(.{2,60}?)\s+(?:at|@)\s+(.{2,60})$/i.exec(title);
    if (at && TITLE_WORDS.test(at[1]!)) {
      title = at[1]!.trim();
      company = at[2]!.trim();
    } else if (title.includes(',')) {
      const parts = title.split(/\s*,\s*/);
      const head: string[] = [parts[0]!];
      for (const p of parts.slice(1)) {
        if (!company && !TITLE_WORDS.test(p) && !TEAM_WORDS.test(p) && looksLikeOrg(p)) company = p;
        else if (!company) head.push(p);
      }
      title = head.join(', ');
    }
    if (!company) company = segs.slice(ti + 1).find(looksLikeOrg);
    if (!company)
      for (const row of rows.slice(i + 1)) {
        // names come before titles, so below the title only the sender's own name is skipped
        const hit = row.find((x) => !(name && sameAsName(x, name)));
        if (hit && looksLikeOrg(hit)) {
          company = hit;
          break;
        }
        if (hit && TITLE_WORDS.test(hit)) break;
      }
    return { title: title.replace(/[,.]$/, '').trim(), company: company?.replace(/[,.]$/, '').trim() };
  }
  return {};
}

export function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
