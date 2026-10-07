import { todayKey } from '../util/ids';

/**
 * Business days for follow-up timing. A bump counts days on which a busy professional actually reads mail:
 * weekdays that are not a US federal holiday, not the day after Thanksgiving, and not inside the Dec 20 to Jan 2
 * winter freeze (nobody answers a networking note then, and a nudge that lands in it reads as tone-deaf).
 * Days are calendar days in the student's timezone.
 */

const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** Day number (days since 1970-01-01) of a YYYY-MM-DD key. */
const dayOfKey = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY);
const keyOfDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Day of the month of the n-th `weekday` (0 = Sunday) in a month; n = -1 is the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0));
  const last = lastDate.getUTCDay();
  return lastDate.getUTCDate() - ((last - weekday + 7) % 7);
}

/** A fixed-date holiday that falls on a weekend is observed on the Friday before or the Monday after. */
function observed(year: number, month: number, day: number): string {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const shift = dow === 6 ? -1 : dow === 0 ? 1 : 0;
  return keyOfDay(dayOfKey(keyOf(year, month, day)) + shift);
}

const holidayCache = new Map<number, Set<string>>();

/** US federal holidays (observed dates) plus the day after Thanksgiving, as YYYY-MM-DD keys. */
export function usHolidays(year: number): Set<string> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const set = new Set<string>([
    observed(year, 1, 1),
    keyOf(year, 1, nthWeekday(year, 1, 1, 3)), // Martin Luther King Jr. Day
    keyOf(year, 2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday
    keyOf(year, 5, nthWeekday(year, 5, 1, -1)), // Memorial Day
    observed(year, 6, 19),
    observed(year, 7, 4),
    keyOf(year, 9, nthWeekday(year, 9, 1, 1)), // Labor Day
    keyOf(year, 10, nthWeekday(year, 10, 1, 2)), // Columbus Day / Indigenous Peoples' Day
    observed(year, 11, 11),
    keyOf(year, 11, thanksgiving),
    keyOf(year, 11, thanksgiving + 1),
    observed(year, 12, 25),
  ]);
  holidayCache.set(year, set);
  return set;
}

/** Dec 20 to Jan 2: offices are half empty and nobody wants a nudge. */
export function inWinterFreeze(key: string): boolean {
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return (m === 12 && d >= 20) || (m === 1 && d <= 2);
}

export function isBusinessDayKey(key: string): boolean {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (inWinterFreeze(key)) return false;
  return !usHolidays(Number(key.slice(0, 4))).has(key);
}

/** Is `d` a business day, judged by its calendar date in `tz`? */
export function isBusinessDay(d: Date, tz?: string): boolean {
  return isBusinessDayKey(todayKey(d, tz));
}

/** The weekday (0 = Sunday) of `d` in `tz`. */
export function localWeekday(d: Date, tz?: string): number {
  return new Date(`${todayKey(d, tz)}T00:00:00Z`).getUTCDay();
}

/**
 * Business days that have fully started after `a`, up to and including the calendar day of `b`, in `tz`.
 * Mail sent on a Monday has 1 business day behind it on Tuesday and 5 on the following Monday.
 */
export function businessDaysBetween(a: Date, b: Date, tz?: string): number {
  const from = dayOfKey(todayKey(a, tz));
  const to = dayOfKey(todayKey(b, tz));
  let n = 0;
  for (let k = from + 1; k <= to; k++) if (isBusinessDayKey(keyOfDay(k))) n++;
  return n;
}

/** The moment `n` business days after `d` (same clock time, on the n-th business day after its calendar day). */
export function addBusinessDays(d: Date, n: number, tz?: string): Date {
  const from = dayOfKey(todayKey(d, tz));
  let k = from;
  let left = n;
  while (left > 0) {
    k++;
    if (isBusinessDayKey(keyOfDay(k))) left--;
  }
  return new Date(d.getTime() + (k - from) * DAY);
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** A month name or its usual abbreviation, as a whole word ("mar" in "market" is not March). */
const MONTH_NAME =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
/** A weekday name or its usual abbreviation, as a whole word ("mon" in "month" is not Monday). */
const WEEKDAY_NAME =
  /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/;
const NAMED_DATE = new RegExp(`\\b${MONTH_NAME} (\\d{1,2})(?:st|nd|rd|th)?\\b`);
const NAMED_DATE_REV = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_NAME}`);
/** "the end of the month", "the start of next month", "the end of October", "next month" */
const MONTH_EDGE = new RegExp(
  `\\b(?:(end|start|beginning) of (?:(the|this|next) month\\b|${MONTH_NAME})|next month\\b)`,
);
const monthIndex = (name: string) => MONTHS.findIndex((x) => x.startsWith(name.slice(0, 3))) + 1;

/**
 * The day an out-of-office reply says the person is back ("back on Monday, October 12", "returning 10/12",
 * "out until Oct 12", "away until Friday", "back in the office on the 12th", "out from Oct 5 to Oct 12"), as the
 * start of that day in `tz` terms, or undefined when the reply names no date. Dates without a year are taken as the
 * next such date on or after the reply; a range or "through" names the last day away, so they are back the day after.
 */
export function parseReturnDate(text: string, sentAt: Date, tz?: string): Date | undefined {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  // "from Oct 5 to Oct 12", "between 10/5 and 10/12": the end of the range is the last day away
  // ("Oct 5-Oct 12", "Monday - Friday" with a bare hyphen too, but never the hyphen inside a word like "e-mail");
  // "until" names the day they are back, the others the last day away
  const range =
    /\b(?:from|between) [^.;\n]{1,30}?(?: (to|until|till|through|thru|and) |(?<=\d|day)\s*[-\u2013]\s*|\s+[-\u2013]\s+)([^.;\n]{0,40})/.exec(
      t,
    );
  if (range) {
    // "away from my desk and e-mail until Oct 12": an "until" after the range word still names the day they are back
    const back = /\b(?:until|till) ([^.;\n]*)$/.exec(range[2]!);
    const end = back
      ? datePhrase(back[1]!, sentAt, tz, 0)
      : datePhrase(range[2]!, sentAt, tz, range[1] === 'until' || range[1] === 'till' ? 0 : DAY);
    if (end) return end;
  }
  const cue =
    /\b(back(?: in (?:the )?office)?|return(?:ing)?(?: to (?:the )?office)?|until|through|thru|till|resum(?:e|ing))\b(?: on)?(?: the)? ?([^.;\n]{0,40})/g;
  let m: RegExpExecArray | null;
  while ((m = cue.exec(t))) {
    // "out through Friday" means back the day after
    const extra = /^(through|thru)$/.test(m[1]!) ? DAY : 0;
    const d = datePhrase(m[2] ?? '', sentAt, tz, extra);
    if (d) return d;
  }
  return undefined;
}

/** The first date named at the start of `rest` ("October 12", "12 Oct", "10/12", "the 12th", "Friday"), plus `extra`. */
function datePhrase(rest: string, sentAt: Date, tz: string | undefined, extra: number): Date | undefined {
  const sentKey = todayKey(sentAt, tz);
  const sentDay = dayOfKey(sentKey);
  const sentYear = Number(sentKey.slice(0, 4));
  const sentMonth = Number(sentKey.slice(5, 7));
  // "October 12", "Oct 12th", "12 October"
  const named = NAMED_DATE.exec(rest) ?? undefined;
  const namedRev = NAMED_DATE_REV.exec(rest) ?? undefined;
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(rest) ?? undefined;
  // "the 12th": a day of this month, or of next month once it has passed
  const ordinal = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/.exec(rest) ?? undefined;
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  if (named) {
    month = monthIndex(named[1]!);
    day = Number(named[2]);
  } else if (namedRev) {
    month = monthIndex(namedRev[2]!);
    day = Number(namedRev[1]);
  } else if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
  } else if (ordinal) {
    day = Number(ordinal[1]);
    month = sentMonth;
    if (dayOfKey(keyOf(sentYear, month, day)) < sentDay) month = (month % 12) + 1;
    if (month < sentMonth) year = sentYear + 1;
  }
  if (month && day && month <= 12 && day <= 31) {
    let y = year ?? sentYear;
    let k = dayOfKey(keyOf(y, month, day));
    if (!year && k < sentDay) k = dayOfKey(keyOf(++y, month, day));
    if (!Number.isNaN(k) && k >= sentDay) return new Date(sentAt.getTime() + (k - sentDay) * DAY + extra);
    return undefined;
  }
  // "until the end of the month", "back at the start of next month": they are back on the first of a month
  const edge = MONTH_EDGE.exec(rest);
  // (the month after the named one for "the end of October", the named one itself for "the start of November")
  let target = 0; // months after the sent month
  if (edge?.[3]) target = ((monthIndex(edge[3]) - sentMonth + 12) % 12) + (edge[1] === 'end' ? 1 : 0);
  else if (edge) target = edge[1] === 'end' && edge[2] === 'next' ? 2 : 1;
  if (edge && target > 0) {
    const m0 = sentMonth - 1 + target;
    const k = dayOfKey(keyOf(sentYear + Math.floor(m0 / 12), (m0 % 12) + 1, 1));
    return new Date(sentAt.getTime() + (k - sentDay) * DAY);
  }
  const wd = WEEKDAY_NAME.exec(rest);
  if (wd) {
    const target = WEEKDAYS.findIndex((x) => x.startsWith(wd[1]!));
    const dow = new Date(`${sentKey}T00:00:00Z`).getUTCDay();
    const delta = (target - dow + 7) % 7 || 7;
    return new Date(sentAt.getTime() + delta * DAY + extra);
  }
  if (/\btomorrow\b/.test(rest)) return new Date(sentAt.getTime() + DAY);
  if (/\bnext week\b/.test(rest)) {
    const dow = new Date(`${sentKey}T00:00:00Z`).getUTCDay();
    return new Date(sentAt.getTime() + ((1 - dow + 7) % 7 || 7) * DAY);
  }
  return undefined;
}

/** Out-of-office wording, for replies that arrive without an auto-reply header. */
export const OUT_OF_OFFICE =
  /\b(out of (the )?office|on (vacation|leave|pto|parental leave)|away (from (the )?office )?until|auto(-| )?reply|automatic reply|limited access to (my )?email)\b/i;
