/**
 * When a batch goes (plan 38 §B3): the times for many emails the student approved at once, paced so a student's Gmail
 * reads like a person writing, never a blast. Pure: no database, no sending.
 *
 * - A pace sets the day's number and the hours: Steady (8 a day) and Faster (up to the day's limit) on weekdays, 8:00
 *   to 11:30 and 13:00 to 16:00 in each person's own time; Gentle (4 a day) on autopilot's window, Tuesday to
 *   Thursday mornings. Never a US federal holiday.
 * - A random 6 to 20 minutes between two emails on the same day, whatever their zones (they leave one account).
 * - Never two people at one company on the same day (recruiters at one firm compare notes).
 * - The day's number counts what is already scheduled that day, in the student's own day, the way the daily limit
 *   counts it (`checkSendAllowed`).
 * Each message goes to the earliest day with room, after that day's last send. The plan is seeded, so the preview the
 * student sees is the plan that runs.
 */
import {
  addDaysKey,
  nextSendWindow,
  sendDayAllowed,
  usHolidays,
  zonedInstant,
  zonedParts,
} from '@orbit/core';

export type BatchPace = 'steady' | 'faster' | 'gentle';

export const BATCH_PACES: Record<
  BatchPace,
  { title: string; line: string; perDay: number | 'cap'; windows: 'workday' | 'autopilot' }
> = {
  steady: { title: 'Steady', line: 'Up to 8 a day, weekdays', perDay: 8, windows: 'workday' },
  faster: { title: 'Faster', line: 'Up to your daily limit', perDay: 'cap', windows: 'workday' },
  gentle: { title: 'Gentle', line: 'Up to 4 a day, Tue to Thu mornings', perDay: 4, windows: 'autopilot' },
};

/** Minutes between two emails on one day: a random point in this range, so the rhythm is never mechanical. */
export const BATCH_GAP_MIN = { min: 6, max: 20 } as const;
/** The hours a weekday batch goes, in the recipient's time: the morning and the early afternoon. */
export const WORKDAY_WINDOWS = [
  { start: { hour: 8, minute: 0 }, end: { hour: 11, minute: 30 } },
  { start: { hour: 13, minute: 0 }, end: { hour: 16, minute: 0 } },
] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A small seeded random, so a plan shown is the plan that runs. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The student's own day, which is how the daily limit counts. */
export const studentDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The day's number for a pace under the student's daily limit. */
export function perDayFor(pace: BatchPace, cap: number): number {
  const p = BATCH_PACES[pace].perDay;
  return Math.max(1, Math.min(cap, p === 'cap' ? cap : p));
}

function workdayAllowed(key: string): boolean {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 && !usHolidays(Number(key.slice(0, 4))).has(key);
}

/** The earliest moment at or after `from` inside a weekday window in `zone`, with a few minutes of jitter at a start. */
export function nextWorkdayOpen(from: Date, zone: string, random: () => number = Math.random): Date {
  let key = zonedParts(from, zone).key;
  for (let i = 0; i < 30; i++, key = addDaysKey(key, 1)) {
    if (!workdayAllowed(key)) continue;
    for (const w of WORKDAY_WINDOWS) {
      const start = zonedInstant(key, w.start.hour, w.start.minute, zone).getTime();
      const end = zonedInstant(key, w.end.hour, w.end.minute, zone).getTime();
      if (from.getTime() >= end) continue;
      if (from.getTime() >= start) return from;
      return new Date(Math.min(start + Math.floor(random() * 9) * MINUTE, end - MINUTE));
    }
  }
  return from;
}

/** The earliest moment at or after `from` in the pace's hours for this recipient. */
export function nextBatchOpen(from: Date, zone: string, pace: BatchPace, random: () => number): Date {
  if (BATCH_PACES[pace].windows === 'autopilot') {
    const at = new Date(nextSendWindow(from, zone, 'gmail', random).notBefore);
    return at < from ? from : at;
  }
  return nextWorkdayOpen(from, zone, random);
}

/** Whether `at` is inside the pace's hours for this recipient (so a time a gap later still fits that day). */
function inWindow(at: Date, zone: string, pace: BatchPace): boolean {
  const p = zonedParts(at, zone);
  if (BATCH_PACES[pace].windows === 'autopilot') {
    if (!sendDayAllowed(p.key, 'gmail')) return false;
    const m = p.hour * 60 + p.minute;
    return m >= 8 * 60 && m <= 10 * 60 + 30;
  }
  if (!workdayAllowed(p.key)) return false;
  const m = p.hour * 60 + p.minute;
  return WORKDAY_WINDOWS.some(
    (w) => m >= w.start.hour * 60 + w.start.minute && m < w.end.hour * 60 + w.end.minute,
  );
}

/** The student's next midnight after `d`. */
function nextStudentDay(d: Date): Date {
  const x = new Date(d.getTime() + DAY);
  x.setHours(0, 0, 0, 0);
  return x;
}

export interface BatchItem {
  id: string;
  /** the recipient's IANA zone (their own, else the student's) */
  zone: string;
  /** a key for their company (lowercased name or domain); empty when unknown */
  company?: string;
}

export interface TakenSend {
  at: Date;
  company?: string;
}

/**
 * The time for each item, in the order given: the earliest day with room and no one else at that company, after that
 * day's last send by a random gap, inside the recipient's hours. `taken` is what is already scheduled.
 */
export function planBatch(opts: {
  items: BatchItem[];
  pace: BatchPace;
  /** the student's daily email limit */
  cap: number;
  /** the earliest a send may go; the first is at least ten minutes after it */
  start: Date;
  taken?: TakenSend[];
  seed?: number;
  /** keep two people at one company on different days (on unless the student turned it off) */
  oneCompanyADay?: boolean;
}): { id: string; at: Date }[] {
  const rand = seeded(opts.seed ?? 11);
  const perDay = perDayFor(opts.pace, opts.cap);
  const spread = opts.oneCompanyADay !== false;
  const count = new Map<string, number>();
  const last = new Map<string, Date>();
  const companies = new Map<string, Set<string>>();
  const note = (at: Date, company?: string) => {
    const k = studentDay(at);
    count.set(k, (count.get(k) ?? 0) + 1);
    if (!last.has(k) || last.get(k)! < at) last.set(k, at);
    if (company) {
      if (!companies.has(k)) companies.set(k, new Set());
      companies.get(k)!.add(company);
    }
  };
  for (const t of opts.taken ?? []) note(t.at, t.company);
  const earliest = new Date(opts.start.getTime() + 10 * MINUTE);
  const out: { id: string; at: Date }[] = [];
  for (const item of opts.items) {
    let from = earliest;
    let at: Date | undefined;
    for (let guard = 0; guard < 120 && !at; guard++) {
      const open = nextBatchOpen(from, item.zone, opts.pace, rand);
      const k = studentDay(open);
      const full = (count.get(k) ?? 0) >= perDay;
      const sameFirm = spread && !!item.company && !!companies.get(k)?.has(item.company);
      if (full || sameFirm) {
        from = nextStudentDay(open);
        continue;
      }
      // after the day's last send, by a gap; if that runs past the hours, the next opening (maybe another day)
      const prev = last.get(k);
      const gap = (BATCH_GAP_MIN.min + rand() * (BATCH_GAP_MIN.max - BATCH_GAP_MIN.min)) * MINUTE;
      const after = prev ? new Date(Math.max(open.getTime(), prev.getTime() + gap)) : open;
      if (after.getTime() !== open.getTime() && !inWindow(after, item.zone, opts.pace)) {
        from = after;
        continue;
      }
      at = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE);
    }
    const when = at ?? earliest;
    out.push({ id: item.id, at: when });
    note(when, item.company);
  }
  return out;
}

export interface PlanDay {
  key: string;
  /** "Tue, Nov 12" */
  label: string;
  count: number;
  first: Date;
  last: Date;
}

/** The plan as days, in the student's own time, for the preview. */
export function planDays(times: Date[], locale = 'en-US'): PlanDay[] {
  const by = new Map<string, Date[]>();
  for (const t of times) {
    const k = studentDay(t);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(t);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ts]) => {
      const sorted = ts.sort((a, b) => a.getTime() - b.getTime());
      return {
        key,
        label: sorted[0]!.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
        count: sorted.length,
        first: sorted[0]!,
        last: sorted[sorted.length - 1]!,
      };
    });
}

/** "8:14 am" in the student's time. */
export function clockTime(d: Date, locale = 'en-US'): string {
  return d
    .toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])M$/i, (_, x: string) => ` ${x.toLowerCase()}m`);
}

/** A company's key for spacing: its name, lowercased, without the usual suffixes. */
export function companyKey(name: string | undefined | null): string | undefined {
  const k = (name ?? '')
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return k || undefined;
}
