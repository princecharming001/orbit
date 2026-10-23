/**
 * Why someone is suggested: the short reasons a Discover card gives ("Why them"), each from a signal the account
 * holds, strongest first. Nothing here is guessed: a line is written only from a signal the caller found in the data
 * (a target company matched by name, people you both know by name, a date they replied), and when there is little,
 * the card says so instead of filling the space.
 */

export type WhyKind =
  /** their role or company is what the student is aiming for */
  | 'goal'
  | 'industry'
  | 'school'
  /** people you both know, by name, or a count when LinkedIn gives only that */
  | 'mutuals'
  /** someone the student knows works at their company */
  | 'colleague'
  | 'past_employer'
  | 'city'
  | 'role_change'
  /** someone who could introduce the student */
  | 'warm_path'
  /** what has already passed between them: a reply, a meeting, a message, a connection */
  | 'history'
  /** like people the student wrote to */
  | 'like'
  /** the search that found them, when nothing else is known */
  | 'search'
  /** the honest line when the account holds little about them */
  | 'thin';

export interface WhyReason {
  kind: WhyKind;
  text: string;
  /** 0..100, what the line is worth against the others on the card */
  strength: number;
}

/** The signals one person's reasons are built from. A field left out is a signal the account does not have. */
export interface WhySignals {
  title?: string;
  company?: string;
  headline?: string;
  goal?: {
    /** their company is on the target list */
    company?: { name: string; priority?: 1 | 2 | 3 };
    /** they hold a role the student targets, and the target function it meets when one does */
    role?: { title: string; function?: string };
    /** their company or work is in an industry on the student's list */
    industry?: string;
  };
  /** they went to the student's school, with what else is known about their time there */
  school?: { name: string; gradYear?: number; myGradYear?: number; program?: string };
  /** people you both know (first names), or how many when LinkedIn gives a count and no names */
  mutuals?: { names?: string[]; count?: number };
  colleague?: { name: string; company: string };
  /** an employer on both résumés: how the student was there, and whether they are still there */
  pastEmployers?: { name: string; mine: 'interned' | 'worked' | 'now'; theirs: 'now' | 'before' }[];
  city?: { name: string; why: 'target' | 'home' };
  /** they started their current role lately */
  roleChange?: { monthsAgo: number; company?: string; title?: string; moved?: boolean };
  warmPath?: { name: string };
  history?: {
    /** they answered a message of the student's */
    repliedAt?: string;
    /** they wrote first */
    theyWroteAt?: string;
    /** the student wrote to them */
    wroteAt?: string;
    metAt?: string;
    connectedOn?: string;
    /** a little closeness on record without a dated event */
    knownALittle?: boolean;
  };
  now: Date;
}

/** How many reasons a card holds at most, the honest line aside. */
export const WHY_MAX = 4;

/** Ties in strength go in this order. */
const KIND_ORDER: WhyKind[] = [
  'goal',
  'warm_path',
  'mutuals',
  'colleague',
  'history',
  'past_employer',
  'school',
  'like',
  'role_change',
  'city',
  'industry',
  'search',
  'thin',
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "March", or "March 2025" when it was more than eleven months ago. */
export function monthOf(iso: string, now: Date): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  const name = MONTHS[d.getMonth()]!;
  return months > 11 ? `${name} ${d.getFullYear()}` : name;
}

const listNames = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** "You both know Nitin and Ana", "You both know Nitin, Ana and 2 others". */
export function mutualsLine(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (!rest) return `You both know ${listNames(shown)}`;
  return `You both know ${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

const yearsApart = (mine: number, theirs: number): string => {
  const d = mine - theirs;
  if (d === 0) return 'your class year';
  const n = Math.abs(d);
  return `${n} year${n === 1 ? '' : 's'} ${d > 0 ? 'ahead of' : 'behind'} you`;
};

const monthsAgo = (n: number): string => (n <= 0 ? 'this month' : n === 1 ? '1 month' : `${n} months`);

function order(reasons: WhyReason[]): WhyReason[] {
  return [...reasons].sort(
    (a, b) => b.strength - a.strength || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/** The honest line for a card with little behind it: what is actually on record. */
function thinLine(
  real: number,
  c: Pick<WhySignals, 'title' | 'company' | 'headline'>,
): WhyReason | undefined {
  if (real >= 2) return undefined;
  let text: string;
  if (real === 1) text = "That's all Orbit knows about them so far";
  else if (c.headline) text = 'Only their LinkedIn headline so far';
  else if (c.title || c.company) text = 'Only their title and company so far';
  else text = 'Not much known about them yet';
  return { kind: 'thin', text, strength: 0 };
}

/**
 * The reasons for one person, strongest first, at most WHY_MAX; with fewer than two real ones, a last line says how
 * little is on record. Every line is written from a signal in `s`; a signal absent is a line absent.
 */
export function whyThem(s: WhySignals): WhyReason[] {
  const out: WhyReason[] = [];
  const say = (kind: WhyKind, text: string, strength: number) => out.push({ kind, text, strength });

  // ---- goals: the role and company the student is aiming for ----
  const g = s.goal;
  if (g?.company && g.role) {
    say('goal', `${g.role.title} at ${g.company.name}, on your target list`, 100);
  } else if (g?.company) {
    const top = g.company.priority === 1 ? 'at the top of' : 'on';
    say('goal', `Works at ${g.company.name}, ${top} your target list`, g.company.priority === 1 ? 90 : 85);
  } else if (g?.role) {
    const where = s.company ? ` at ${s.company}` : '';
    say('goal', `${g.role.title}${where}, a role you're targeting`, 80);
  }
  if (g?.industry && !g.company) say('industry', `Works in ${g.industry}, an industry on your list`, 40);

  // ---- a way in: someone who can introduce them, people you both know ----
  if (s.warmPath) say('warm_path', `${s.warmPath.name} could introduce you`, 88);
  const names = (s.mutuals?.names ?? []).filter(Boolean);
  if (names.length) say('mutuals', mutualsLine(names), Math.min(96, 86 + 2 * names.length));
  else if (s.mutuals?.count)
    say(
      'mutuals',
      `${s.mutuals.count} mutual connection${s.mutuals.count === 1 ? '' : 's'} on LinkedIn`,
      60 + Math.min(20, 2 * s.mutuals.count),
    );
  if (s.colleague)
    say('colleague', `${s.colleague.name}, whom you know, works at ${s.colleague.company} too`, 86);

  // ---- what has already passed between you ----
  const h = s.history;
  if (h?.metAt && monthOf(h.metAt, s.now)) say('history', `You met in ${monthOf(h.metAt, s.now)}`, 80);
  else if (h?.repliedAt && monthOf(h.repliedAt, s.now))
    say('history', `Replied to you in ${monthOf(h.repliedAt, s.now)}`, 78);
  else if (h?.theyWroteAt && monthOf(h.theyWroteAt, s.now))
    say('history', `Wrote to you in ${monthOf(h.theyWroteAt, s.now)}`, 74);
  else if (h?.wroteAt && monthOf(h.wroteAt, s.now))
    say('history', `You wrote to them in ${monthOf(h.wroteAt, s.now)}`, 55);
  else if (h?.connectedOn && !Number.isNaN(new Date(h.connectedOn).getTime()))
    say('history', `Connected on LinkedIn since ${new Date(h.connectedOn).getFullYear()}`, 40);
  else if (h?.knownALittle) say('history', 'You already know each other a little', 45);

  // ---- shared ground: an employer, the school, the city ----
  for (const e of s.pastEmployers ?? []) {
    if (e.mine === 'now' && e.theirs === 'now') say('past_employer', `You're both at ${e.name}`, 82);
    else if (e.theirs === 'now') say('past_employer', `Works at ${e.name}, where you ${e.mine}`, 76);
    else say('past_employer', `Also ${e.mine === 'interned' ? 'was' : 'worked'} at ${e.name}, like you`, 72);
  }
  if (s.school) {
    const { name, gradYear, myGradYear, program } = s.school;
    const short = `'${String(gradYear).slice(-2)}`;
    if (gradYear && myGradYear) say('school', `${name} ${short}, ${yearsApart(myGradYear, gradYear)}`, 76);
    else if (program) say('school', `Also studied ${program} at ${name}`, 75);
    else if (gradYear) say('school', `${name} ${short}, like you`, 72);
    else say('school', `Went to ${name}, like you`, 70);
    if (program && gradYear && myGradYear) say('school', `Also studied ${program}`, 50);
  }
  if (s.city)
    say(
      'city',
      s.city.why === 'target' ? `In ${s.city.name}, where you want to work` : `Also in ${s.city.name}`,
      s.city.why === 'target' ? 45 : 35,
    );

  // ---- why now ----
  if (s.roleChange && s.roleChange.monthsAgo < 12) {
    const r = s.roleChange;
    const when = r.monthsAgo <= 0 ? 'this month' : `${monthsAgo(r.monthsAgo)} ago`;
    say(
      'role_change',
      r.moved && r.company ? `Moved to ${r.company} ${when}` : `New in the role, ${monthsAgo(r.monthsAgo)}`,
      50,
    );
  }

  const kept = order(out).slice(0, WHY_MAX);
  const thin = thinLine(kept.length, s);
  return thin ? [...kept, thin] : kept;
}

/** What each of Discover's reason codes (scoreDiscoverCandidate, recommendPeople) is, and what it is worth. */
const CODE: Record<string, { kind: WhyKind; strength: number }> = {
  referred: { kind: 'warm_path', strength: 92 },
  path: { kind: 'warm_path', strength: 60 },
  colleague: { kind: 'colleague', strength: 86 },
  alumni_target: { kind: 'goal', strength: 95 },
  target_company: { kind: 'goal', strength: 85 },
  function_match: { kind: 'goal', strength: 80 },
  shared_org_now: { kind: 'past_employer', strength: 82 },
  shared_org: { kind: 'past_employer', strength: 75 },
  mutuals: { kind: 'mutuals', strength: 60 },
  like_replied: { kind: 'like', strength: 70 },
  alumni: { kind: 'school', strength: 70 },
  warm: { kind: 'history', strength: 45 },
  like_reached: { kind: 'like', strength: 50 },
  resume_overlap: { kind: 'like', strength: 40 },
  location: { kind: 'city', strength: 45 },
  industry: { kind: 'industry', strength: 40 },
  second_degree: { kind: 'mutuals', strength: 30 },
  search: { kind: 'search', strength: 20 },
};

/**
 * The reasons for someone known only from a search (a new person on Discover), from the reasons the scorer wrote
 * for them: each already comes from the data, so they are ordered and trimmed here, a role and a company on the
 * target list joined into one line, and the honest line added when there is little.
 */
export function whyFromReasons(
  reasons: { code: string; text: string }[],
  c: Pick<WhySignals, 'title' | 'company' | 'headline'> & { mutualCount?: number },
): WhyReason[] {
  const out: WhyReason[] = [];
  const has = (code: string) => reasons.some((r) => r.code === code);
  const hasTarget = has('target_company');
  const hasRole = has('function_match');
  // "Cornell alum at Stripe, on your target list" already says the school and the company
  const alumniTarget = has('alumni_target');
  for (const r of reasons) {
    const c0 = CODE[r.code];
    if (!c0) continue;
    if (alumniTarget && (r.code === 'target_company' || r.code === 'alumni')) continue;
    if (!alumniTarget && hasTarget && hasRole && c.title && c.company) {
      if (r.code === 'target_company') {
        out.push({ kind: 'goal', text: `${c.title} at ${c.company}, on your target list`, strength: 100 });
        continue;
      }
      if (r.code === 'function_match') continue;
    }
    let strength = c0.strength;
    if (r.code === 'mutuals') strength += Math.min(20, 2 * (c.mutualCount ?? 0));
    const text = r.code === 'search' ? `Found by the search: ${r.text}` : r.text;
    if (!out.some((x) => x.kind === c0.kind && x.text === text)) out.push({ kind: c0.kind, text, strength });
  }
  const kept = order(out).slice(0, WHY_MAX);
  const real = kept.filter((r) => r.kind !== 'search').length;
  const thin = thinLine(real, c);
  return thin ? [...kept, thin] : kept;
}
