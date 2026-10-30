import { todayKey } from '../util/ids';
import { isBusinessDayKey } from './calendar';

/**
 * The weekly target as a plan for each day. The week runs Monday to Sunday; first messages go out on working days
 * (business days, without the student's quiet days), spread evenly. Each morning's number is what is left of the
 * week over the working days left, so a slow start raises the days after it (catching up) and a fast one lowers them
 * (holding back, so the week does not bunch). The sending limits cap any one day. The day setup ends counts for
 * nothing: the pace starts on the next working day, with the week's target cut to the days left in it.
 */
export interface WeekPace {
  /** the week's goal; in the week setup ended, cut to the working days after it */
  target: number;
  /** first messages sent this week, and today */
  sent: number;
  sentToday: number;
  /** what the week still needs */
  remaining: number;
  /** working days that count this week, and those left from today on */
  workDays: number;
  daysLeft: number;
  /** first messages planned for today, from the numbers at the start of the day */
  today: number;
  /** of today's, the ones not sent yet */
  leftToday: number;
  /** where an even pace stands by the end of today */
  expected: number;
  status: PaceStatus;
  /** today's number was held at the daily sending limits */
  capped: boolean;
  /** Monday to Sunday: which days carry first messages, and where today is */
  days: PaceDay[];
}

export interface PaceDay {
  /** YYYY-MM-DD in the student's timezone */
  key: string;
  /** a working day in this week's plan (not a weekend, holiday, quiet day, or the setup day and before) */
  counted: boolean;
  /** relative to today */
  when: 'past' | 'today' | 'future';
}

export type PaceStatus =
  /** setup ended today: nothing planned until the next working day */
  | 'starting'
  /** a weekend, a holiday or a quiet day */
  | 'resting'
  | 'behind'
  | 'on_pace'
  | 'ahead'
  /** the week's target is met */
  | 'done';

export interface PaceInput {
  /** first messages a week */
  target: number;
  sentThisWeek: number;
  sentToday: number;
  now: Date;
  tz?: string;
  /** weekdays (0 = Sunday) the student keeps free of messages */
  quietDays?: number[];
  /** the most first messages one day can carry: the Gmail and LinkedIn daily limits together */
  dailyCap: number;
  /** when setup ended (ISO); its day and the days before it do not count */
  startedAt?: string;
}

const DAY = 86_400_000;
const dayNo = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY);
const keyOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const weekdayOf = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

/** A working day for first messages: a business day the student did not keep quiet. */
export function isSendingDay(key: string, quietDays: number[] = []): boolean {
  return isBusinessDayKey(key) && !quietDays.includes(weekdayOf(key));
}

/** The day keys of the week (Monday to Sunday) that holds `now`, in `tz`. */
export function weekKeys(now: Date, tz?: string): string[] {
  const today = dayNo(todayKey(now, tz));
  const monday = today - ((weekdayOf(keyOf(today)) + 6) % 7);
  return Array.from({ length: 7 }, (_, i) => keyOf(monday + i));
}

export function weekPace(i: PaceInput): WeekPace {
  const quiet = i.quietDays ?? [];
  const todayK = todayKey(i.now, i.tz);
  const startK = i.startedAt ? todayKey(new Date(i.startedAt), i.tz) : undefined;
  const week = weekKeys(i.now, i.tz);
  const sending = week.filter((k) => isSendingDay(k, quiet));
  // the setup day and the days before it are not part of the plan
  const counted = startK ? sending.filter((k) => k > startK) : sending;
  const target =
    sending.length && counted.length < sending.length
      ? Math.ceil((i.target * counted.length) / sending.length)
      : counted.length
        ? i.target
        : 0;
  const sent = i.sentThisWeek;
  const sentToday = Math.min(i.sentToday, sent);
  const sentBefore = sent - sentToday;
  const remaining = Math.max(0, target - sent);
  const left = counted.filter((k) => k >= todayK);
  const todayCounts = left[0] === todayK;
  const before = counted.filter((k) => k < todayK).length;
  const through = before + (todayCounts ? 1 : 0);
  const share = (days: number) => (counted.length ? (target * days) / counted.length : 0);
  const expected = Math.round(share(through));
  // the day's number comes from where the day started, so it holds still while today's messages go out
  const even = todayCounts ? Math.ceil(Math.max(0, target - sentBefore) / left.length) : 0;
  const today = Math.min(even, Math.max(0, i.dailyCap));
  const leftToday = Math.min(Math.max(0, today - sentToday), remaining);
  const slack = Math.max(1, target * 0.1);
  const status: PaceStatus =
    target > 0 && sent >= target
      ? 'done'
      : startK === todayK
        ? 'starting'
        : !todayCounts
          ? 'resting'
          : share(before) - sentBefore >= slack
            ? 'behind'
            : sent - expected >= slack
              ? 'ahead'
              : 'on_pace';
  return {
    target,
    sent,
    sentToday,
    remaining,
    workDays: counted.length,
    daysLeft: left.length,
    today,
    leftToday,
    expected,
    status,
    capped: even > today,
    days: week.map((key) => ({
      key,
      counted: counted.includes(key),
      when: key < todayK ? 'past' : key === todayK ? 'today' : 'future',
    })),
  };
}

/** The most first messages a week the sending limits allow: a full day's limits on each working day. */
export function weeklyCapacity(
  s: { dailySendCapGmail: number; dailySendCapLinkedin: number; quietDays?: number[] },
  workDaysPerWeek = 5,
): number {
  const weekdaysOff = (s.quietDays ?? []).filter((d) => d >= 1 && d <= 5).length;
  return Math.max(0, workDaysPerWeek - weekdaysOff) * (s.dailySendCapGmail + s.dailySendCapLinkedin);
}

/** One sentence on today's place in the week, for the morning brief: what to send, or why nothing is planned. */
export function paceLine(p: WeekPace, nextDay?: string): string {
  const n = (k: number) => `${k} first message${k === 1 ? '' : 's'}`;
  // "1 first message keeps", "3 first messages keep"
  const verb = (k: number, v: string) => (k === 1 ? `${v}s` : v);
  switch (p.status) {
    case 'done':
      return 'Done for the week. Anything more is a bonus.';
    case 'starting':
      return `Your pace starts ${nextDay ?? 'on the next working day'}.`;
    case 'resting':
      return p.remaining
        ? `Nothing planned today. ${p.remaining} left for ${nextDay ?? 'the next working day'}.`
        : 'Nothing planned today.';
    case 'behind':
      if (!p.leftToday) return "Today's catch-up is sent.";
      return p.capped
        ? `${n(p.leftToday)} today, the most your sending limits allow.`
        : `${n(p.leftToday)} today ${verb(p.leftToday, 'catch')} you up.`;
    case 'ahead':
      return p.leftToday
        ? `Ahead of pace. ${n(p.leftToday)} today ${verb(p.leftToday, 'keep')} it steady.`
        : 'Ahead of pace.';
    default:
      if (!p.leftToday) return "Today's first messages are sent.";
      return p.capped
        ? `${n(p.leftToday)} today, held at your sending limits.`
        : `${n(p.leftToday)} today ${verb(p.leftToday, 'keep')} you on pace.`;
  }
}
