import type { ProposedTime } from '../types';

/**
 * Proposed-time extraction for email bodies.
 *
 * A small tokenizer turns the text into DAY / DATE / REL (today, tomorrow) / TIME / RANGE / MOD (at, around, after,
 * before, from, between) / PART (morning, afternoon) / ZONE tokens. Adjacent tokens (separated only by spaces,
 * commas, colons or parentheses) form a chunk, and each chunk is read as one or more proposals. Every wall-clock
 * time is resolved in a real IANA zone: the zone stated next to the time, else a zone stated for the whole message
 * ("all times Eastern", "I'm on Pacific time"), else the student's own zone. Only Intl APIs are used.
 */

const ZONE_ABBR: Record<string, string> = {
  ET: 'America/New_York',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CT: 'America/Chicago',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MT: 'America/Denver',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  GMT: 'UTC',
  UTC: 'UTC',
  BST: 'Europe/London',
  CET: 'Europe/Paris',
  CEST: 'Europe/Paris',
  IST: 'Asia/Kolkata',
  SGT: 'Asia/Singapore',
  JST: 'Asia/Tokyo',
};
const ZONE_NAME: Record<string, string> = {
  eastern: 'America/New_York',
  central: 'America/Chicago',
  mountain: 'America/Denver',
  pacific: 'America/Los_Angeles',
};

export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Map "ET", "PST", "Eastern", "pacific time" or an IANA name to an IANA zone. */
export function resolveZone(token: string): string | undefined {
  const t = token
    .trim()
    .replace(/^\(|\)$/g, '')
    .trim();
  const upper = t.toUpperCase();
  if (ZONE_ABBR[upper] && t === upper) return ZONE_ABBR[upper];
  const name = t
    .toLowerCase()
    .replace(/\s+(standard|daylight)/, '')
    .replace(/\s+time$/, '')
    .trim();
  if (ZONE_NAME[name]) return ZONE_NAME[name];
  if (/^[A-Z][A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/.test(t) && isValidTimeZone(t)) return t;
  return undefined;
}

interface Civil {
  y: number;
  m: number; // 1..12
  d: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(
  instant: Date,
  tz: string,
): { y: number; m: number; d: number; h: number; min: number; s: number; dow: number } {
  const parts = fmt(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24,
    min: Number(get('minute')),
    s: Number(get('second')),
    dow: DOW_SHORT.indexOf(get('weekday')),
  };
}

function offsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads y-m-d h:min. */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off1 = offsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function addDays(c: Civil, n: number): Civil {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function civilKey(c: Civil): number {
  return c.y * 10000 + c.m * 100 + c.d;
}
function civilDow(c: Civil): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}
export function civilIso(c: Civil): string {
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// tokenizer

type Tok =
  | { k: 'day'; dow: number }
  | { k: 'date'; m: number; d: number; y?: number }
  | { k: 'ord'; d: number }
  | { k: 'rel'; offset: number; part?: Part }
  | { k: 'time'; h: number; min: number; ap?: 'am' | 'pm'; clock: boolean; ish: boolean }
  | { k: 'part'; part: Part }
  | { k: 'zone'; tz: string }
  | { k: 'mod'; mod: 'at' | 'around' | 'after' | 'before' | 'from' | 'between' }
  | { k: 'range'; word: string }
  | { k: 'or' }
  | { k: 'next'; word: string }
  | { k: 'week'; offset: number; relative: boolean }
  | { k: 'past' }
  | { k: 'conn' };
type Part = 'morning' | 'afternoon' | 'evening';
type Positioned = Tok & { start: number; end: number };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_WORDS: [RegExp, number][] = [
  [/^sun(day)?$/, 0],
  [/^mon(day)?$/, 1],
  [/^tue(s(day)?)?$|^tuesday$/, 2],
  [/^wed(s|nesday)?$/, 3],
  [/^thu(r(s(day)?)?)?$|^thursday$/, 4],
  [/^fri(day)?$/, 5],
  [/^sat(urday)?$/, 6],
];
/** Abbreviations that are also ordinary English words only count when capitalised. */
const AMBIGUOUS_DAY = /^(sun|sat|mon|wed)$/;
const ZONE_ALT =
  '\\(?\\b(?:ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|AKST|AKDT|HST|GMT|UTC|BST|CET|CEST|IST|SGT|JST)\\)?(?![A-Za-z])|\\b(?:eastern|central|mountain|pacific)(?:\\s+(?:standard|daylight))?(?:\\s+time)?(?![a-z])|[A-Z][a-z]+\\/[A-Z][A-Za-z_]+(?:\\/[A-Z][A-Za-z_]+)?';

const TOKEN_RE = new RegExp(
  [
    // 1 m/d(/y)
    '(?<mdy>(?<![\\d/.])(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?(?![\\d/]))',
    // month name + day
    '(?<mon>\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?(?![\\d:a-z]))',
    // day + month name
    '(?<dmon>(?<![\\d/.:])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?)',
    // the 8th
    '(?<ord>\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b)',
    // weekday
    '(?<day>\\b(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\\b\\.?)',
    // relative day
    '(?<rel>\\b(today|tonight|tomorrow|tmrw|tmr|this\\s+(?:morning|afternoon|evening))\\b)',
    // week scope: "next week", "the week after", "week after next"
    '(?<week>\\b(?:(?:this\\s+coming|this|next|the\\s+following|following|the\\s+coming|coming)\\s+week|(?:the\\s+)?week\\s+after(?:\\s+(?:next|that))?)\\b)',
    '(?<named>\\b(noon|midday|midnight)\\b)',
    // clock time
    "(?<time>(?<![\\d/:.$£€#])(\\d{1,2})(?::([0-5]\\d))?(?:\\s?(a\\.m\\.?|p\\.m\\.?|am|pm)(?![a-z])|([ap])(?![a-z]))?(-?ish|\\s?o'?clock)?(?![\\d/:%a-z]))",
    `(?<zone>${ZONE_ALT})`,
    '(?<part>\\b(?:in\\s+the\\s+)?(morning|afternoon|evening|night)\\b)',
    '(?<mod>(?:\\b(?:any\\s?time\\s+|sometime\\s+)?(at|around|about|after|before|by|from|between|approx(?:imately)?)\\b)|@|~)',
    '(?<range>\\s-\\s|-|\\b(?:to|through|thru|until|till|til|and)\\b)',
    '(?<or>\\bor\\b|\\/)',
    '(?<next>\\b(?:next|this(?:\\s+coming)?|coming)\\b)',
    '(?<past>\\b(?:last|past|yesterday|ago|earlier|previous)\\b)',
    '(?<conn>\\b(?:on|the|either|works?|my\\s+time|your\\s+time)\\b)',
  ].join('|'),
  'gi',
);

const NOT_TIME_AFTER =
  /^\s*(min(ute)?s?|hours?|hrs?|people|years?|yrs?|days?|weeks?|months?|percent|k\b|x\b|times\b|of\b|interns?|students?|questions?|projects?|teams?|slides?)/i;

function tokenize(text: string): Positioned[] {
  const out: Positioned[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const g = m.groups ?? {};
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (!raw.length) {
      TOKEN_RE.lastIndex++;
      continue;
    }
    const push = (t: Tok) => out.push({ ...t, start, end } as Positioned);
    if (g.mdy) {
      const parts = g.mdy.split('/').map((x) => Number.parseInt(x, 10));
      const [mo, d, y] = parts as [number, number, number | undefined];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
        push({ k: 'date', m: mo, d, y: y === undefined ? undefined : y < 100 ? 2000 + y : y });
      continue;
    }
    if (g.mon) {
      const mm = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i.exec(g.mon)!;
      const word = mm[1]!;
      if (/^may$/i.test(word) && word !== 'May') continue;
      if (/^mar$/i.test(word) && word !== 'Mar') continue;
      const mo = MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
      const d = Number.parseInt(mm[2]!, 10);
      if (mo >= 1 && d >= 1 && d <= 31)
        push({ k: 'date', m: mo, d, y: mm[3] ? Number.parseInt(mm[3], 10) : undefined });
      continue;
    }
    if (g.dmon) {
      const mm = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)/i.exec(g.dmon)!;
      const word = mm[2]!;
      if (/^(may|mar)$/i.test(word) && word[0] !== word[0]!.toUpperCase()) continue;
      const mo = MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
      const d = Number.parseInt(mm[1]!, 10);
      if (mo >= 1 && d >= 1 && d <= 31) push({ k: 'date', m: mo, d });
      continue;
    }
    if (g.ord) {
      const d = Number.parseInt(/\d+/.exec(g.ord)![0], 10);
      if (d >= 1 && d <= 31) push({ k: 'ord', d });
      continue;
    }
    if (g.day) {
      const word = g.day.replace(/\.$/, '');
      const lower = word.toLowerCase();
      if (AMBIGUOUS_DAY.test(lower) && word[0] !== word[0]!.toUpperCase()) continue;
      const hit = DAY_WORDS.find(([re]) => re.test(lower));
      if (hit) push({ k: 'day', dow: hit[1] });
      continue;
    }
    if (g.rel) {
      const w = g.rel.toLowerCase();
      if (w === 'today') push({ k: 'rel', offset: 0 });
      else if (w === 'tonight') push({ k: 'rel', offset: 0, part: 'evening' });
      else if (w.startsWith('this')) push({ k: 'rel', offset: 0, part: w.split(/\s+/)[1] as Part });
      else push({ k: 'rel', offset: 1 });
      continue;
    }
    if (g.week) {
      const w = g.week.toLowerCase().replace(/\s+/g, ' ');
      if (w.endsWith('after next')) push({ k: 'week', offset: 2, relative: false });
      else if (w.includes('after')) push({ k: 'week', offset: 1, relative: true });
      else push({ k: 'week', offset: /^this(?! coming)/.test(w) ? 0 : 1, relative: false });
      continue;
    }
    if (g.named) {
      const w = g.named.toLowerCase();
      push({
        k: 'time',
        h: w === 'midnight' ? 0 : 12,
        min: 0,
        ap: w === 'midnight' ? 'am' : 'pm',
        clock: true,
        ish: false,
      });
      continue;
    }
    if (g.time) {
      const mm = /^(\d{1,2})(?::([0-5]\d))?(?:\s?(a\.m\.?|p\.m\.?|am|pm)|([ap]))?(-?ish|\s?o'?clock)?/i.exec(
        g.time,
      )!;
      const h = Number.parseInt(mm[1]!, 10);
      const min = mm[2] ? Number.parseInt(mm[2], 10) : 0;
      const apRaw = (mm[3] ?? mm[4] ?? '').toLowerCase();
      const ap = apRaw.startsWith('a') ? 'am' : apRaw.startsWith('p') ? 'pm' : undefined;
      const ish = Boolean(mm[5]);
      if (NOT_TIME_AFTER.test(text.slice(end))) continue;
      if (ap && (h < 1 || h > 12)) continue;
      if (!ap && !mm[2] && (h < 1 || h > 12)) continue;
      if (mm[2] && h > 23) continue;
      push({ k: 'time', h, min, ap, clock: Boolean(ap || mm[2]), ish });
      continue;
    }
    if (g.zone) {
      const tz = resolveZone(g.zone);
      if (tz) push({ k: 'zone', tz });
      continue;
    }
    if (g.part) {
      const w = g.part.toLowerCase().split(/\s+/).pop()!;
      push({ k: 'part', part: w === 'night' ? 'evening' : (w as Part) });
      continue;
    }
    if (g.mod) {
      const w = g.mod.toLowerCase().trim().split(/\s+/).pop()!;
      const mod =
        w === '@' || w === 'at'
          ? 'at'
          : w === '~' || w === 'around' || w === 'about' || w.startsWith('approx')
            ? 'around'
            : w === 'by' || w === 'before'
              ? 'before'
              : (w as 'after' | 'from' | 'between');
      push({ k: 'mod', mod });
      continue;
    }
    if (g.range) {
      push({ k: 'range', word: g.range.trim().toLowerCase() });
      continue;
    }
    if (g.or) {
      push({ k: 'or' });
      continue;
    }
    if (g.next) {
      push({ k: 'next', word: g.next.toLowerCase().split(/\s+/)[0]! });
      continue;
    }
    if (g.past) {
      push({ k: 'past' });
      continue;
    }
    if (g.conn) push({ k: 'conn' });
  }
  return out;
}

/** Group adjacent tokens. Tokens are adjacent when only spaces, commas, colons or parentheses separate them. */
function chunks(text: string, toks: Positioned[]): Positioned[][] {
  const out: Positioned[][] = [];
  let cur: Positioned[] = [];
  for (const t of toks) {
    const prev = cur[cur.length - 1];
    if (prev && !/^[\s,:()]*$/.test(text.slice(prev.end, t.start))) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// interpretation

interface TimeSpec {
  h: number;
  min: number;
  ap?: 'am' | 'pm';
  clock: boolean;
  mod?: string;
  end?: { h: number; min: number; ap?: 'am' | 'pm' };
  start: number;
  stop: number;
}
type Anchor =
  | { k: 'day'; dow: number; next: boolean; week?: number }
  | { k: 'date'; m: number; d: number; y?: number; dow?: number }
  | { k: 'ord'; d: number; dow?: number }
  | { k: 'rel'; offset: number };
interface Draft {
  anchors: Anchor[];
  anchorStart?: number;
  anchorEnd?: number;
  times: TimeSpec[];
  part?: Part;
  zone?: string;
  zoneEnd?: number;
  past: boolean;
  /** "2pm Thursday": the time came before its day, so a later time starts a new proposal */
  timeFirst?: boolean;
}
interface Proposal {
  anchor: Anchor;
  time: TimeSpec;
  part?: Part;
  zone?: string;
  raw: string;
}

function to24(h: number, ap: 'am' | 'pm' | undefined): number {
  if (ap === 'pm' && h < 12) return h + 12;
  if (ap === 'am' && h === 12) return 0;
  return h;
}

function resolveHours(t: TimeSpec, part?: Part): { start: number; end?: number } {
  const startClock = (ap: 'am' | 'pm' | undefined) => to24(t.h, ap) + t.min / 60;
  let startAp = t.ap;
  if (!startAp) {
    if (t.min && t.h > 12)
      startAp = undefined; // 24h clock
    else if (t.end?.ap) {
      const cand = to24(t.h, t.end.ap) + t.min / 60;
      const endH = to24(t.end.h, t.end.ap) + t.end.min / 60;
      startAp = cand <= endH ? t.end.ap : 'am';
    } else if (part === 'morning') startAp = 'am';
    else if (part === 'afternoon' || part === 'evening') startAp = 'pm';
    else if (t.h >= 1 && t.h <= 7) startAp = 'pm';
    else if (t.h === 12) startAp = 'pm';
    else startAp = t.h > 12 ? undefined : 'am';
  }
  const start = startClock(startAp);
  if (!t.end) return { start };
  let end = to24(t.end.h, t.end.ap) + t.end.min / 60;
  if (!t.end.ap) {
    end = to24(t.end.h, start >= 12 && t.end.h < 12 ? 'pm' : undefined) + t.end.min / 60;
    if (end <= start && t.end.h < 12) end += 12;
  }
  if (end <= start) return { start };
  return { start, end };
}

/** Week offset (0 this week, 1 next week, 2 the week after) that applies to a bare weekday at [start, end). */
type WeekAt = (start: number, end: number) => number | undefined;

/**
 * Week scopes in a message: "next week is wide open. Tues 10am?" puts Tuesday in next week, and "I'm away next
 * week, but how about the week after? Tuesday at 2pm?" two weeks out. A scope right after the weekday ("Tuesday
 * next week") wins; otherwise the closest scope earlier in the message (within a few sentences) applies.
 */
function weekScopes(text: string, toks: Positioned[]): WeekAt {
  const scopes: { start: number; end: number; offset: number; blocked: boolean }[] = [];
  for (const t of toks) {
    if (t.k !== 'week') continue;
    const prev = scopes[scopes.length - 1];
    scopes.push({
      start: t.start,
      end: t.end,
      offset: t.relative ? (prev?.offset ?? 0) + t.offset : t.offset,
      blocked: weekIsBlocked(text, t.start, t.end),
    });
  }
  return (start, end) => {
    const after = scopes.find((s) => s.start >= end && s.start - end <= 2);
    if (after) return after.offset;
    let hit: number | undefined;
    for (const s of scopes)
      if (s.end <= start && start - s.end <= 250) hit = s.blocked ? undefined : s.offset;
    return hit;
  };
}

const WEEK_BLOCKED =
  /\b(not|cannot|can'?t|won'?t|isn'?t|doesn'?t|busy|booked|slammed|swamped|packed|hectic|away|out|off|traveling|travelling|vacation|pto|leave|conference|offsite|unavailable)\b/i;
const WEEK_OPEN = /\b(open|free|available|works?|flexible|better|easier|how about|what about)\b/i;

/** "I'm traveling next week" names a week the time is NOT in; "next week is wide open" names the week it is in. */
function weekIsBlocked(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, end + 80);
  const lo = before.split(/[.;!?\n]|,|\bbut\b|\bthough\b|\bhowever\b/i).pop() ?? '';
  const hi = after.split(/[.;!?\n]|,|\bbut\b|\bthough\b|\bhowever\b/i)[0] ?? '';
  const clause = `${lo} ${hi}`;
  if (!WEEK_BLOCKED.test(clause)) return false;
  return !(WEEK_OPEN.test(clause) && !/\b(not|cannot)\b|n['’]t\b/i.test(clause));
}

function interpretChunk(
  text: string,
  chunk: Positioned[],
  weekAt: WeekAt = () => undefined,
): { proposals: Proposal[]; leftover: Draft[] } {
  const proposals: Proposal[] = [];
  const leftover: Draft[] = [];
  const emitted: Proposal[] = [];
  let d: Draft = { anchors: [], times: [], past: false };
  let pendingNext = false;
  let pendingNextStart: number | undefined;
  let pendingPast = false;
  let mod: string | undefined;
  let rangeOpen = false;
  let between = false;
  const flush = (keepAnchors: boolean) => {
    if (d.anchors.length && d.times.length && !d.past) {
      for (const a of d.anchors)
        for (const t of d.times) {
          const stop = d.zoneEnd && d.zoneEnd > t.stop && d.zoneEnd - t.stop < 24 ? d.zoneEnd : t.stop;
          const timeRaw = text.slice(t.start, stop);
          const anchorRaw = text.slice(d.anchorStart!, d.anchorEnd!);
          const raw =
            d.anchorStart! <= t.start && t.start - d.anchorEnd! < 24
              ? text.slice(d.anchorStart!, stop)
              : d.anchorStart! > t.stop && d.anchorStart! - t.stop < 24
                ? text.slice(t.start, Math.max(d.anchorEnd!, stop))
                : `${anchorRaw} ${timeRaw}`;
          const p: Proposal = {
            anchor: a,
            time: t,
            part: d.part,
            zone: d.zone,
            raw: raw.trim().replace(/[.,]$/, ''),
          };
          proposals.push(p);
          emitted.push(p);
        }
    } else if ((d.anchors.length || d.times.length) && !d.past) leftover.push(d);
    const next: Draft = { anchors: keepAnchors ? d.anchors : [], times: [], past: false };
    if (keepAnchors) {
      next.anchorStart = d.anchorStart;
      next.anchorEnd = d.anchorEnd;
      next.part = d.part;
    }
    d = next;
    rangeOpen = false;
    between = false;
  };
  const addAnchor = (a: Anchor, t: Positioned) => {
    const last = d.anchors[d.anchors.length - 1];
    // "Thurs 10/8", "Monday the 12th": a weekday followed by its date is one anchor; keep the date and the weekday
    if (last && last.k === 'day' && (a.k === 'date' || a.k === 'ord') && t.start - (d.anchorEnd ?? 0) < 4) {
      d.anchors[d.anchors.length - 1] = { ...a, dow: last.dow };
    } else {
      if (d.anchors.length && d.times.length) flush(false);
      if (!d.anchors.length && d.times.length) d.timeFirst = true;
      d.anchors.push(a);
    }
    const from = pendingNext && pendingNextStart !== undefined ? pendingNextStart : t.start;
    if (d.anchorStart === undefined || from < d.anchorStart) d.anchorStart = from;
    d.anchorEnd = Math.max(d.anchorEnd ?? 0, t.end);
    if (pendingPast) d.past = true;
    pendingPast = false;
    pendingNext = false;
  };
  for (let i = 0; i < chunk.length; i++) {
    const t = chunk[i]!;
    const nextTok = chunk[i + 1];
    switch (t.k) {
      case 'past':
        pendingPast = true;
        break;
      case 'next':
        pendingNext = t.word === 'next';
        pendingNextStart = t.start;
        break;
      case 'day':
        addAnchor({ k: 'day', dow: t.dow, next: pendingNext, week: weekAt(t.start, t.end) }, t);
        break;
      case 'date':
        addAnchor({ k: 'date', m: t.m, d: t.d, y: t.y }, t);
        break;
      case 'ord':
        addAnchor({ k: 'ord', d: t.d }, t);
        break;
      case 'rel':
        addAnchor({ k: 'rel', offset: t.offset }, t);
        if (t.part) d.part = t.part;
        break;
      case 'part':
        d.part = t.part;
        break;
      case 'zone':
        d.zone = t.tz;
        d.zoneEnd = t.end;
        for (const p of emitted) p.zone ??= t.tz;
        break;
      case 'mod':
        mod = t.mod;
        if (t.mod === 'between') between = true;
        break;
      case 'range': {
        const last = d.times[d.times.length - 1];
        if (t.word === 'and' && !between) break;
        if (last && !last.end && nextTok?.k === 'time') rangeOpen = true;
        break;
      }
      case 'or':
        mod = undefined;
        break;
      case 'time': {
        const prev = chunk[i - 1];
        const cued =
          t.clock ||
          t.ish ||
          Boolean(mod) ||
          rangeOpen ||
          (nextTok?.k === 'range' && chunk[i + 2]?.k === 'time') ||
          nextTok?.k === 'part' ||
          prev?.k === 'part' ||
          Boolean(d.part);
        if (!cued) break;
        if (rangeOpen) {
          const last = d.times[d.times.length - 1]!;
          last.end = { h: t.h, min: t.min, ap: t.ap };
          last.stop = t.end;
          rangeOpen = false;
          break;
        }
        if (d.times.length && d.anchors.length) flush(!d.timeFirst);
        pendingPast = false;
        d.times.push({
          h: t.h,
          min: t.min,
          ap: t.ap,
          clock: t.clock,
          mod,
          start: mod && prev?.k === 'mod' ? prev.start : t.start,
          stop: t.end,
        });
        mod = undefined;
        break;
      }
      default:
        break;
    }
  }
  flush(false);
  return { proposals, leftover };
}

const NEGATING = /\b(not|can'?t|cannot|busy|class|meeting|conflict|except|unless|until|booked|out)\b/i;

function sentenceIndexAt(text: string, pos: number): number {
  let n = 0;
  const re = /[.!?](?=\s)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < pos) n++;
  return n;
}

/** A zone stated for the whole message: "All times Eastern", "I'm on Pacific time", "(all PT)". */
export function statedMessageZone(text: string): string | undefined {
  const z =
    '(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|GMT|UTC|BST|eastern|central|mountain|pacific)(?:\\s+(?:standard|daylight))?(?:\\s+time)?';
  const res = [
    new RegExp(
      `\\b(?:all\\s+)?times?\\s+(?:(?:are|listed|below|above|here)\\s+)*(?:in\\s+)?${z}(?![A-Za-z])`,
      'i',
    ),
    new RegExp(`\\bi'?m\\s+(?:on|in|based\\s+in)\\s+${z}(?![A-Za-z])`, 'i'),
    new RegExp(`\\b(?:on|in)\\s+${z}\\s+time\\b`, 'i'),
    new RegExp(`\\((?:all\\s+)?(?:times?\\s+(?:in\\s+)?)?${z}\\)`, 'i'),
  ];
  for (const re of res) {
    const m = re.exec(text);
    if (m) {
      const tz = resolveZone(m[1]!);
      if (tz) return tz;
    }
  }
  return undefined;
}

function resolveAnchorDate(
  a: Anchor,
  today: Civil,
  todayDow: number,
  sameDayPassed: boolean,
): Civil | undefined {
  switch (a.k) {
    case 'rel':
      return addDays(today, a.offset);
    case 'day': {
      // "next Thursday" and a weekday under "next week" are that day in the following Monday-to-Sunday week;
      // "the week after" is one week later still
      const week = a.week ?? (a.next ? 1 : undefined);
      if (week !== undefined && week > 0) {
        const monday = addDays(today, -((todayDow + 6) % 7));
        return addDays(monday, 7 * week + ((a.dow + 6) % 7));
      }
      let delta = (a.dow - todayDow + 7) % 7;
      if (delta === 0 && (a.next || sameDayPassed)) delta = 7;
      return addDays(today, delta);
    }
    case 'date': {
      let c: Civil = { y: a.y ?? today.y, m: a.m, d: a.d };
      if (a.y === undefined && civilKey(c) < civilKey(addDays(today, -60))) c = { ...c, y: c.y + 1 };
      return c;
    }
    case 'ord': {
      let c: Civil = { y: today.y, m: today.m, d: a.d };
      if (a.d < today.d)
        c = today.m === 12 ? { y: today.y + 1, m: 1, d: a.d } : { y: today.y, m: today.m + 1, d: a.d };
      if (a.dow !== undefined && civilDow(c) !== a.dow) {
        const alt = c.m === 12 ? { y: c.y + 1, m: 1, d: a.d } : { y: c.y, m: c.m + 1, d: a.d };
        if (civilDow(alt) === a.dow) c = alt;
      }
      return c;
    }
  }
}

export interface ExtractOptions {
  /** IANA zone used when the text states none (the student's own zone). Defaults to the host zone. */
  timeZone?: string;
}

/**
 * Extract proposed meeting times. Times without a day ("2pm") are ignored, as are past references ("last Friday at
 * 5") and times that have already passed. `timeZone` on a result is set only when the text states a zone.
 */
export function extractTimes(text: string, reference: Date, opts: ExtractOptions = {}): ProposedTime[] {
  const fallbackTz = isValidTimeZone(opts.timeZone) ? opts.timeZone : hostTimeZone();
  const norm = text.replace(/[–‒]/g, '-').replace(/[—]/g, ', ').replace(/ /g, ' ');
  const messageZone = statedMessageZone(norm);
  const toks = tokenize(norm);
  const weekAt = weekScopes(norm, toks);
  const proposals: Proposal[] = [];
  const leftovers: { draft: Draft; sentence: number; start: number; end: number }[] = [];
  for (const c of chunks(norm, toks)) {
    const r = interpretChunk(norm, c, weekAt);
    proposals.push(...r.proposals);
    for (const l of r.leftover) {
      const start = Math.min(l.anchorStart ?? Number.POSITIVE_INFINITY, ...l.times.map((t) => t.start));
      const end = Math.max(l.anchorEnd ?? 0, ...l.times.map((t) => t.stop));
      leftovers.push({ draft: l, sentence: sentenceIndexAt(norm, start), start, end });
    }
  }
  // "I'm free Thursday, anytime after 2pm": a lone day and a lone time in the same sentence belong together
  const bySentence = new Map<number, typeof leftovers>();
  for (const l of leftovers) bySentence.set(l.sentence, [...(bySentence.get(l.sentence) ?? []), l]);
  for (const group of bySentence.values()) {
    const anchors = group.filter((g) => g.draft.anchors.length && !g.draft.times.length);
    const times = group.filter((g) => g.draft.times.length && !g.draft.anchors.length);
    if (anchors.length !== 1 || !times.length) continue;
    const a = anchors[0]!;
    for (const t of times) {
      const lo = Math.min(a.start, t.start);
      const hi = Math.max(a.end, t.end);
      const between = norm.slice(Math.min(a.end, t.end), Math.max(a.start, t.start));
      if (NEGATING.test(between) || between.length > 60) continue;
      for (const anchor of a.draft.anchors)
        for (const time of t.draft.times)
          proposals.push({
            anchor,
            time,
            part: t.draft.part ?? a.draft.part,
            zone: t.draft.zone ?? a.draft.zone,
            raw: norm.slice(lo, hi).trim(),
          });
    }
  }
  const out: ProposedTime[] = [];
  for (const p of proposals) {
    const statedZone = p.zone ?? messageZone;
    const tz = statedZone ?? fallbackTz;
    const now = zonedParts(reference, tz);
    const today: Civil = { y: now.y, m: now.m, d: now.d };
    const hours = resolveHours(p.time, p.part);
    const nowHours = now.h + now.min / 60;
    const date = resolveAnchorDate(p.anchor, today, now.dow, hours.start <= nowHours);
    if (!date) continue;
    let startH = hours.start;
    let endH = hours.end;
    if (p.time.mod === 'before' && endH === undefined) {
      endH = startH;
      startH = Math.max(0, startH - 1);
    }
    const start = zonedTimeToUtc(
      date.y,
      date.m,
      date.d,
      Math.floor(startH),
      Math.round((startH % 1) * 60),
      tz,
    );
    if (start.getTime() < reference.getTime()) continue; // never propose a time that has already passed
    if (start.getTime() - reference.getTime() > 200 * 86_400_000) continue;
    const end =
      endH === undefined
        ? undefined
        : zonedTimeToUtc(date.y, date.m, date.d, Math.floor(endH), Math.round((endH % 1) * 60), tz);
    if (out.some((o) => o.startIso === start.toISOString() && o.endIso === end?.toISOString())) continue;
    out.push({
      startIso: start.toISOString(),
      ...(end ? { endIso: end.toISOString() } : {}),
      raw: p.raw,
      ...(statedZone ? { timeZone: statedZone } : {}),
    });
  }
  return out.sort((a, b) => a.startIso.localeCompare(b.startIso));
}

/** The first date (no time needed) mentioned in a fragment, as YYYY-MM-DD in `tz`; used for OOO return dates. */
export function extractFirstDate(fragment: string, reference: Date, timeZone?: string): string | undefined {
  const tz = isValidTimeZone(timeZone) ? timeZone : hostTimeZone();
  const now = zonedParts(reference, tz);
  const today: Civil = { y: now.y, m: now.m, d: now.d };
  const toks = tokenize(fragment.replace(/[–—]/g, '-'));
  let pendingNext = false;
  let dayAnchor: Anchor | undefined;
  for (const t of toks) {
    if (t.k === 'next') pendingNext = t.word === 'next';
    else if (t.k === 'day') {
      dayAnchor = { k: 'day', dow: t.dow, next: pendingNext };
    } else if (t.k === 'date' || t.k === 'ord' || t.k === 'rel') {
      const a: Anchor =
        t.k === 'date'
          ? { k: 'date', m: t.m, d: t.d, y: t.y }
          : t.k === 'ord'
            ? { k: 'ord', d: t.d, dow: dayAnchor?.k === 'day' ? dayAnchor.dow : undefined }
            : { k: 'rel', offset: t.offset };
      const c = resolveAnchorDate(a, today, now.dow, true);
      return c ? civilIso(c) : undefined;
    } else if (dayAnchor && t.k !== 'conn') break;
  }
  if (dayAnchor) {
    const c = resolveAnchorDate(dayAnchor, today, now.dow, true);
    return c ? civilIso(c) : undefined;
  }
  return undefined;
}
