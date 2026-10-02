import { emailDomain, emailLocalPart } from './normalize';

const BULK_LOCAL =
  /^(no-?reply|donotreply|do-not-reply|notifications?|newsletter|mailer-daemon|postmaster|bounce|alerts?|updates?|info|news|digest|support|team|hello|marketing|billing|invoices?|receipts?|careers|jobs|recruiting|talent|hr|noreply-.*|.*-noreply|.*-notifications?)$/i;
export const BULK_DOMAINS = new Set([
  'e.linkedin.com',
  'linkedin.com',
  'facebookmail.com',
  'mail.instagram.com',
  'mailchimp.com',
  'sendgrid.net',
  'hubspotemail.net',
  'calendar-notification.google.com',
  'accounts.google.com',
  'docs.google.com',
  'mail.coursera.org',
  'canvas.instructure.com',
  'instructure.com',
  'piazza.com',
  'gradescope.com',
  'joinhandshake.com',
  'handshake.com',
  'glassdoor.com',
  'indeed.com',
  'greenhouse.io',
  'lever.co',
  'myworkday.com',
  'icims.com',
  'smartrecruiters.com',
  'ashbyhq.com',
  'ziprecruiter.com',
  'eventbrite.com',
  'meetup.com',
  'ticketmaster.com',
  'reddithelp.com',
  'morningbrew.com',
  'theskimm.com',
  'substack.com',
  'medium.com',
  'quora.com',
  'pinterest.com',
  'tiktok.com',
  'doordash.com',
  'ubereats.com',
  'venmo.com',
  'paypal.com',
  'robinhood.com',
  'coinbase.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'capitalone.com',
]);

export interface HeaderLike {
  'list-unsubscribe'?: string;
  precedence?: string;
  'auto-submitted'?: string;
  'x-mailer'?: string;
  [k: string]: string | undefined;
}

export function isAutomatedSender(
  fromEmail: string,
  headers: HeaderLike = {},
  labels: string[] = [],
): boolean {
  if (headers['list-unsubscribe']) return true;
  const prec = (headers.precedence ?? '').toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true;
  const auto = (headers['auto-submitted'] ?? '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (labels.some((l) => /CATEGORY_(PROMOTIONS|SOCIAL|FORUMS|UPDATES)/i.test(l))) return true;
  const local = emailLocalPart(fromEmail);
  if (BULK_LOCAL.test(local)) return true;
  const domain = emailDomain(fromEmail);
  if (BULK_DOMAINS.has(domain)) return true;
  // subdomain of a bulk domain
  for (const d of BULK_DOMAINS) if (domain.endsWith(`.${d}`)) return true;
  return false;
}

const QUOTE_MARKERS = [
  /^On .{5,200} wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:\s.+\nSent:\s.+/im,
  /^From:\s.+\n(To|Date):\s.+/im,
  /^_{10,}\s*$/m,
  /^Le .{5,200} a écrit\s*:/m,
];

export function stripQuotedReply(body: string): string {
  let text = body.replace(/\r\n/g, '\n');
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);
  // drop trailing '>' quoted lines
  const lines = text.split('\n');
  while (lines.length && /^\s*>/.test(lines[lines.length - 1]!)) lines.pop();
  text = lines.filter((l) => !/^\s*>/.test(l)).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const SIG_LINE =
  /(\+?\d[\d\s().-]{7,}\d)|(linkedin\.com\/in\/)|(https?:\/\/)|(^--\s*$)|(^(best|thanks|cheers|regards|sincerely|warmly|talk soon|all the best)[,!.]?\s*$)/i;
const TITLE_WORDS =
  /(engineer|manager|director|analyst|associate|partner|founder|ceo|cto|coo|cfo|vp|vice president|head of|lead|recruiter|consultant|scientist|designer|product|intern|student|professor|md\b|phd)/i;

export interface SignatureInfo {
  body: string;
  signature?: string;
  title?: string;
  company?: string;
  phone?: string;
  linkedinUrl?: string;
}

export function splitSignature(body: string): SignatureInfo {
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const tail = lines.slice(-8);
  let start = -1;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i]!.trim();
    if (!l) continue;
    if (
      SIG_LINE.test(l) ||
      (/^[A-Z][a-z]+(\s[A-Z][a-z]+){0,3}$/.test(l) &&
        i < tail.length - 1 &&
        TITLE_WORDS.test(tail[i + 1] ?? ''))
    ) {
      start = lines.length - tail.length + i;
      break;
    }
  }
  if (start < 0) return { body: body.trim() };
  const sig = lines.slice(start).join('\n');
  const info: SignatureInfo = { body: lines.slice(0, start).join('\n').trim(), signature: sig.trim() };
  const phone = sig.match(/\+?\d[\d\s().-]{7,}\d/);
  if (phone) info.phone = phone[0].trim();
  const li = sig.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i);
  if (li) info.linkedinUrl = li[0];
  for (const l of sig
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)) {
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
