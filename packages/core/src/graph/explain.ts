import { isReciprocal } from '../scoring/strength';
import type { Edge, Person } from '../types';

/**
 * Plain-English reasons for each hop of a Reach route, phrased the way a well-connected friend would say it:
 * "Priya and Mei both work at Figma now", "You've had 3 emails and a meeting with Priya; the last one was
 * 2 weeks ago". Hop texts always name both people so the reader knows who overlapped with whom.
 */

type Named = Pick<Person, 'id' | 'firstName' | 'displayName'>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYear(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function relativeAgo(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return undefined;
  const days = Math.floor(Math.max(0, now.getTime() - t) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return days < 730 ? 'over a year ago' : `${Math.floor(days / 365)} years ago`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${one === 'meeting' ? 'a' : 'one'} ${one}` : `${n} ${many}`;
}

function names(a: Named, b: Named): [string, string] {
  if (a.firstName && b.firstName && a.firstName !== b.firstName) return [a.firstName, b.firstName];
  return [a.displayName || a.firstName, b.displayName || b.firstName];
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Why the student can reach this person directly. */
export function describeUserTie(p: Person, now: Date = new Date()): string {
  const c = p.strengthBreakdown?.counts ?? {};
  const emailsIn = c.email_in ?? 0;
  const emailsOut = c.email_out ?? 0;
  const meetings = (c.meeting ?? 0) + (c.manual_log ?? 0);
  const linkedin = (c.linkedin_in ?? 0) + (c.linkedin_out ?? 0);
  const name = p.firstName || p.displayName;
  // only a real conversation can be "the last one": a CC or a LinkedIn connection is not
  const when = relativeAgo(p.strengthBreakdown?.lastConversationAt, now);
  if (!isReciprocal(c)) {
    if (emailsOut) {
      const times = emailsOut === 1 ? 'once' : emailsOut === 2 ? 'twice' : `${emailsOut} times`;
      return `You've emailed ${name} ${times} and haven't heard back yet`;
    }
    if (c.linkedin_out) return `You've messaged ${name} on LinkedIn and haven't heard back yet`;
    if (p.linkedinConnectedOn) {
      const since = monthYear(p.linkedinConnectedOn);
      return `You're connected with ${name} on LinkedIn${since ? ` (since ${since})` : ''}`;
    }
    if (c.email_cc) return `You and ${name} have been on the same email threads`;
    return `You know ${name}`;
  }
  const parts: string[] = [];
  const emails = emailsIn + emailsOut;
  if (emails) parts.push(plural(emails, 'email', 'emails'));
  if (meetings) parts.push(plural(meetings, 'meeting', 'meetings'));
  if (linkedin) parts.push(plural(linkedin, 'LinkedIn message', 'LinkedIn messages'));
  if (!parts.length) return c.intro_observed ? `You were introduced to ${name}` : `You know ${name}`;
  return `You've had ${list(parts)} with ${name}${when ? `; the last one was ${when}` : ''}`;
}

type Ev = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function yearsPhrase(ev: Ev): string {
  const from = num(ev.fromYear);
  const to = num(ev.toYear);
  if (from === undefined) return '';
  if (ev.ongoing) return ` since ${from}`;
  if (to === undefined || to === from) return ` in ${from}`;
  return ` from ${from} to ${to}`;
}

/** Full sentence for one edge between two people, naming them in hop order. */
function sentence(e: Edge, a: Named, b: Named): string | undefined {
  const [A, B] = names(a, b);
  const ev = e.evidence as Ev;
  const org = str(ev.orgName);
  const school = str(ev.school);
  switch (e.type) {
    case 'same_current_company':
      return org ? `${A} and ${B} both work at ${org} now` : undefined;
    case 'co_tenure': {
      if (!org) return undefined;
      if (ev.datesUnknown) {
        const current = Array.isArray(ev.current) ? (ev.current as string[]) : [];
        if (current.includes(a.id) && !current.includes(b.id))
          return `${B} used to work at ${org}, where ${A} works now`;
        if (current.includes(b.id) && !current.includes(a.id))
          return `${A} used to work at ${org}, where ${B} works now`;
        return `${A} and ${B} both used to work at ${org}`;
      }
      if (ev.ongoing) return `${A} and ${B} have worked together at ${org}${yearsPhrase(ev)}`;
      return `${A} and ${B} both worked at ${org}${yearsPhrase(ev)}`;
    }
    case 'same_school_cohort': {
      if (!school) return undefined;
      const year = num(ev.year);
      if (year !== undefined) return `${A} and ${B} were both at ${school} around ${year}`;
      if (ev.withinTwoYears)
        return `${A} and ${B} both went to ${school}, graduating within two years of each other`;
      return `${A} and ${B} both went to ${school}`;
    }
    case 'email_cothread': {
      const n = num(ev.threads) ?? 1;
      const when = monthYear(str(ev.lastAt));
      return `${A} and ${B} were on ${n === 1 ? 'an email thread' : `${n} email threads`} with you${when ? ` (${n === 1 ? '' : 'last in '}${when})` : ''}`;
    }
    case 'meeting_coattendee': {
      const n = num(ev.events) ?? 1;
      const when = monthYear(str(ev.lastAt));
      return `${A} and ${B} were in ${n === 1 ? 'a meeting' : `${n} meetings`} with you${when ? ` (${n === 1 ? '' : 'last in '}${when})` : ''}`;
    }
    case 'introduced_by':
      return `${A} introduced ${B} to you`;
    default:
      return str(ev.text);
  }
}

/** Short trailing clause for secondary evidence: "and they both went to Cornell". */
function clause(e: Edge): string | undefined {
  const ev = e.evidence as Ev;
  const org = str(ev.orgName);
  const school = str(ev.school);
  switch (e.type) {
    case 'same_current_company':
      return org ? `both work at ${org}` : undefined;
    case 'co_tenure':
      return org ? `both worked at ${org}` : undefined;
    case 'same_school_cohort':
      return school ? `both went to ${school}` : undefined;
    case 'email_cothread':
      return 'were on an email thread with you';
    case 'meeting_coattendee':
      return 'were in a meeting with you';
    default:
      return undefined;
  }
}

/** Hop text from `from` to `to`, using the strongest edge and one supporting reason when there is one. */
export function describePairHop(from: Named, to: Named, edges: Edge[]): string {
  const sorted = [...edges].sort((x, y) => y.weight - x.weight);
  const primary = sorted.find((e) => sentence(e, from, to));
  if (!primary) {
    const [A, B] = names(from, to);
    return `${A} and ${B} know each other`;
  }
  const main = sentence(primary, from, to)!;
  const mainClause = clause(primary);
  const extra = sorted
    .filter((e) => e !== primary && e.type !== primary.type)
    .map(clause)
    .find((c) => c && c !== mainClause);
  return extra ? `${main}, and they ${extra}` : main;
}
