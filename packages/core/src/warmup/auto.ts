/**
 * The automated LinkedIn warm-up: the same three steps as the manual one (a visible profile view, a like on one recent
 * post, the comment the student approved), run by Orbit's server from the student's own LinkedIn account after they
 * approve the plan once. This file is the part both sides share and none of it touches the network:
 *
 * - WARMUP_AUTO_CAPS, every limit in one place: how many automated actions a student's account makes a day, how far
 *   apart, how many on one person, the working hours, how often a failed step is tried again;
 * - the schedule: working days in the student's time zone (no weekends, no US holidays), a random minute inside
 *   working hours, one step per person per day, counted from the day the profile is viewed;
 * - the cap verdict the server's counter gives (orbit.warmup_take holds the same rules under a lock);
 * - which post to engage with, what a comment may look like, and the run as the browser shows it.
 *
 * Nothing here writes or changes a comment after the student pressed Start: the approved text is stored once by the
 * server and posted as it is.
 */
import { usHolidays } from '../suggestions/calendar';
import type { ID, WarmUpAction, WarmUpPlan } from '../types';
import {
  atLocalHour,
  linkedinActivityUrl,
  linkedinProfileUrl,
  WARMUP_DAYS_MAX,
  WARMUP_DAYS_MIN,
  wallClock,
  wallKey,
} from './rules';

export type WarmUpAutoKind = 'view_profile' | 'react_post' | 'comment_post';
export const WARMUP_AUTO_KINDS: readonly WarmUpAutoKind[] = ['view_profile', 'react_post', 'comment_post'];

/**
 * Every limit on the automated warm-up. LinkedIn tolerates about 100 of each action a day per account (Unipile's
 * guidance); these stay far under it, because the same account also reads profiles and sends messages for the student.
 */
export const WARMUP_AUTO_CAPS = {
  /** automated actions one student's account makes in one of their days, by kind */
  perDay: { view_profile: 15, react_post: 10, comment_post: 4 } as Record<WarmUpAutoKind, number>,
  /** any two automated actions of one student are at least this far apart */
  minGapSeconds: 90,
  /** and up to this much more, at random, so they never fall at fixed intervals */
  gapJitterSeconds: 90,
  /** automated actions on one person in one day (a second try of the same step does not count twice) */
  perPersonPerDay: 1,
  /** working hours in the student's time zone: a step runs from 9:00 up to 17:00, Monday to Friday */
  workStartHour: 9,
  workEndHour: 17,
  /** a step that failed is tried once more, then skipped */
  maxAttempts: 2,
  /** how long after a failure the second try comes, in minutes, at random between the two */
  retryAfterMinutes: { min: 45, max: 120 },
  /** the longest comment Orbit posts (LinkedIn's own limit, through Unipile, is 1,250 characters) */
  commentMaxChars: 600,
  /** a post older than this is not engaged with */
  postMaxAgeDays: 45,
  /** how many recent posts the comment writer is shown to choose from */
  postCandidates: 5,
  /**
   * plans a student can ask for in a day (each reads the person's posts on LinkedIn once, and their profile when
   * Orbit does not know them yet); a plan shown again within six hours is not read again and does not count
   */
  previewsPerDay: 25,
} as const;

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ---- working days and hours ---------------------------------------------------------------------------------------

/** Monday to Friday, and not a US federal holiday. `key` is YYYY-MM-DD. */
export function isWorkingDay(key: string): boolean {
  const wd = new Date(`${key}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !usHolidays(Number(key.slice(0, 4))).has(key);
}

const addDays = (key: string, n: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The `n`-th working day after `key` (n = 0: `key` itself when it is one, else the next). */
export function workingDayAfter(key: string, n: number): string {
  let at = key;
  if (n === 0) {
    while (!isWorkingDay(at)) at = addDays(at, 1);
    return at;
  }
  for (let added = 0; added < n; ) {
    at = addDays(at, 1);
    if (isWorkingDay(at)) added++;
  }
  return at;
}

/** Whether `now` is inside working hours on a working day, in the student's time zone. */
export function inWorkingHours(now: Date, tz?: string): boolean {
  const key = wallKey(now, tz);
  if (!isWorkingDay(key)) return false;
  const hour = new Date(wallClock(now.getTime(), tz)).getUTCHours();
  return hour >= WARMUP_AUTO_CAPS.workStartHour && hour < WARMUP_AUTO_CAPS.workEndHour;
}

const windowOf = (key: string, tz?: string) => ({
  start: atLocalHour(key, WARMUP_AUTO_CAPS.workStartHour, tz).getTime(),
  end: atLocalHour(key, WARMUP_AUTO_CAPS.workEndHour, tz).getTime(),
});

/** A random minute inside working hours on day `key`, not before `fromMs`; undefined when the day has no room left. */
function slotOn(
  key: string,
  tz: string | undefined,
  random: () => number,
  fromMs?: number,
): Date | undefined {
  if (!isWorkingDay(key)) return undefined;
  const { start, end } = windowOf(key, tz);
  const lo = Math.max(start, fromMs ?? start);
  const minutes = Math.floor((end - lo) / MIN_MS);
  if (minutes < 1) return undefined;
  return new Date(lo + Math.floor(random() * minutes) * MIN_MS);
}

/** A random minute inside working hours on the first working day after today. */
export function nextWorkingDaySlot(now: Date, tz?: string, random: () => number = Math.random): Date {
  const key = workingDayAfter(wallKey(now, tz), 1);
  return slotOn(key, tz, random)!;
}

/**
 * `at` when it falls inside working hours; otherwise a random minute in the next working window (later the same day
 * when `at` is before 9:00 on a working day, else the next working day).
 */
export function whenWorking(at: Date, tz?: string, random: () => number = Math.random): Date {
  if (inWorkingHours(at, tz)) return at;
  const key = wallKey(at, tz);
  const today = slotOn(key, tz, random, at.getTime());
  return today ?? nextWorkingDaySlot(at, tz, random);
}

/**
 * When a failed step is tried again: 45 to 120 minutes later the same day, or, when working hours end first, a random
 * minute the next working day.
 */
export function retrySlot(now: Date, tz?: string, random: () => number = Math.random): Date {
  const { min, max } = WARMUP_AUTO_CAPS.retryAfterMinutes;
  const t = new Date(now.getTime() + Math.round((min + random() * (max - min)) * MIN_MS));
  return wallKey(t, tz) === wallKey(now, tz) && inWorkingHours(t, tz)
    ? t
    : nextWorkingDaySlot(now, tz, random);
}

/** The earliest moment an action may follow the last one: the gap plus a random extra. */
export function afterGap(lastAt: Date | undefined, now: Date, random: () => number = Math.random): Date {
  if (!lastAt) return now;
  const wait =
    (WARMUP_AUTO_CAPS.minGapSeconds + Math.floor(random() * WARMUP_AUTO_CAPS.gapJitterSeconds)) * 1000;
  return new Date(Math.max(now.getTime(), lastAt.getTime() + wait));
}

// ---- the schedule -------------------------------------------------------------------------------------------------

export interface AutoStepPlan {
  /** w1, w2, w3: the ids the manual plan's actions carry */
  id: string;
  seq: number;
  kind: WarmUpAutoKind;
  dueAt: string;
}

export interface AutoSchedule {
  steps: AutoStepPlan[];
  /** when the first message is expected to be offered: the last step's time */
  readyAt: string;
}

/**
 * When each automated step runs. The profile view is today, a minute or more from now, when the student starts inside
 * working hours; otherwise at a random minute of the next working window. The like and the comment fall on later
 * working days counted from the view's day, on the same days as the manual plan (`buildWarmUpPlan`) except that no two
 * steps share a day, so one person never sees two actions from the student in a day. Every time is a random minute
 * inside working hours in the student's time zone.
 *
 * No recent post: the profile view only. Comment left out: the view and the like.
 */
export function autoWarmUpSchedule(o: {
  now: Date;
  warmUpDays?: number;
  tz?: string;
  hasPost: boolean;
  withComment: boolean;
  random?: () => number;
}): AutoSchedule {
  const random = o.random ?? Math.random;
  const days = Number.isFinite(o.warmUpDays) ? Math.round(o.warmUpDays as number) : 4;
  const n = Math.min(WARMUP_DAYS_MAX, Math.max(WARMUP_DAYS_MIN, days));
  const today = wallKey(o.now, o.tz);
  let first: Date | undefined;
  if (inWorkingHours(o.now, o.tz)) {
    // soon, not on the second the button was pressed: one to ten minutes from now, inside the window
    const soon = o.now.getTime() + (1 + Math.floor(random() * 10)) * MIN_MS;
    first = soon < windowOf(today, o.tz).end ? new Date(soon) : undefined;
  } else first = slotOn(today, o.tz, random, o.now.getTime());
  first ??= nextWorkingDaySlot(o.now, o.tz, random);
  const day0 = wallKey(first, o.tz);
  const at = (k: number) => slotOn(workingDayAfter(day0, k), o.tz, random)!.toISOString();
  const reactDay = Math.max(1, Math.floor(n / 2));
  const commentDay = Math.max(reactDay + 1, n - 1);
  const steps: AutoStepPlan[] = [{ id: 'w1', seq: 1, kind: 'view_profile', dueAt: first.toISOString() }];
  if (o.hasPost) {
    steps.push({ id: 'w2', seq: 2, kind: 'react_post', dueAt: at(reactDay) });
    if (o.withComment) steps.push({ id: 'w3', seq: 3, kind: 'comment_post', dueAt: at(commentDay) });
  }
  return { steps, readyAt: steps[steps.length - 1]!.dueAt };
}

// ---- the daily caps -----------------------------------------------------------------------------------------------

/** One automated action a student's account took (or tried), as the counter keeps it. */
export interface AutoActionLog {
  kind: WarmUpAutoKind;
  at: string;
  personId: string;
  stepId?: string;
}

export type CapVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** `gap`: too soon after the last action; `day_cap`: the day's count for this kind is used; `person_day`:
       *  this person already had an action today */
      reason: 'gap' | 'day_cap' | 'person_day';
      /** with `gap`: when the gap has passed */
      retryAt?: string;
    };

/**
 * May this action run now? `today` holds the student's automated actions since the start of their day, of every kind.
 * The server asks orbit.warmup_take, which applies the same three rules under a lock and records the action when it
 * is allowed; this is the rule in one readable place, and what the demo's simulation uses.
 */
export function warmUpCapVerdict(o: {
  kind: WarmUpAutoKind;
  personId: string;
  stepId?: string;
  now: Date;
  today: AutoActionLog[];
  /** the student's last automated action of any kind, when it was before today */
  lastAt?: string;
}): CapVerdict {
  const times = [...o.today.map((a) => Date.parse(a.at)), ...(o.lastAt ? [Date.parse(o.lastAt)] : [])].filter(
    (t) => Number.isFinite(t) && t <= o.now.getTime(),
  );
  const last = times.length ? Math.max(...times) : undefined;
  if (last !== undefined && o.now.getTime() - last < WARMUP_AUTO_CAPS.minGapSeconds * 1000)
    return {
      allowed: false,
      reason: 'gap',
      retryAt: new Date(last + WARMUP_AUTO_CAPS.minGapSeconds * 1000).toISOString(),
    };
  if (o.today.filter((a) => a.kind === o.kind).length >= WARMUP_AUTO_CAPS.perDay[o.kind])
    return { allowed: false, reason: 'day_cap' };
  const onPerson = o.today.filter((a) => a.personId === o.personId && (!o.stepId || a.stepId !== o.stepId));
  if (onPerson.length >= WARMUP_AUTO_CAPS.perPersonPerDay) return { allowed: false, reason: 'person_day' };
  return { allowed: true };
}

// ---- the post and the comment -------------------------------------------------------------------------------------

export interface WarmUpPostCandidate {
  /** the id a like or a comment is sent to (LinkedIn's social id, "urn:li:activity:…") */
  id: string;
  url?: string;
  text: string;
  /** ISO, when LinkedIn gave a date */
  at?: string;
  isRepost?: boolean;
}

/**
 * The posts worth engaging with, best first: the person's own posts (not reposts) with some words in them, from the
 * last 45 days, newest first. At most five. Empty: the warm-up is the profile view only.
 */
export function warmUpPostCandidates(posts: WarmUpPostCandidate[], now: Date): WarmUpPostCandidate[] {
  const oldest = now.getTime() - WARMUP_AUTO_CAPS.postMaxAgeDays * DAY_MS;
  const seen = new Set<string>();
  return posts
    .filter((p) => {
      if (!p.id || p.isRepost || seen.has(p.id)) return false;
      seen.add(p.id);
      if (p.text.trim().length < 40) return false;
      const t = p.at ? Date.parse(p.at) : Number.NaN;
      // a post with no readable date is kept: LinkedIn lists the newest first
      return !Number.isFinite(t) || (t >= oldest && t <= now.getTime() + DAY_MS);
    })
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ta = a.p.at ? Date.parse(a.p.at) : Number.NaN;
      const tb = b.p.at ? Date.parse(b.p.at) : Number.NaN;
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
      return a.i - b.i;
    })
    .slice(0, WARMUP_AUTO_CAPS.postCandidates)
    .map((x) => x.p);
}

/** The start of a post, cut at a word, for "like their post: …". */
export function postExcerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

const FLATTERY =
  /\b(amazing|awesome|incredible|inspiring|inspirational|brilliant|fantastic|insightful|great (post|insights?|share|read|points?)|love this|loved this|well said|so true|thanks for sharing|couldn'?t agree more|spot on)\b/i;

/**
 * What the writer's text becomes before the student sees it: plain quotes off, no em or en dashes, no exclamation
 * marks, one paragraph. Only ever applied to a draft, never to the text the student approved.
 */
export function tidyWarmUpComment(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/!+/g, '.')
    .replace(/\.{2,}$/g, '.')
    .replace(/,\s*\./g, '.')
    .trim();
}

/** Why a drafted comment is not offered: empty, too long, praise, a link, a hashtag or a mention. Empty: it is fine. */
export function warmUpCommentProblems(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (!t) out.push('empty');
  if (t.length > WARMUP_AUTO_CAPS.commentMaxChars) out.push('too_long');
  if (FLATTERY.test(t)) out.push('flattery');
  if (/https?:\/\/|www\./i.test(t)) out.push('link');
  if (/(^|\s)#\w/.test(t)) out.push('hashtag');
  if (/(^|\s)@\w/.test(t) || /\{\{\d+\}\}/.test(t)) out.push('mention');
  return out;
}

/**
 * Whether the text the student approved can be posted as it is: some words, not over the length, and none of
 * LinkedIn's mention markers ({{0}}), which would be read as a tag. Returns what is wrong, in words for the sheet.
 */
export function approvedCommentError(text: string): string | undefined {
  if (!text.trim()) return 'Write the comment, or leave it out.';
  if (text.length > WARMUP_AUTO_CAPS.commentMaxChars)
    return `Keep the comment under ${WARMUP_AUTO_CAPS.commentMaxChars} characters.`;
  if (/\{\{\d+\}\}/.test(text)) return 'Take the double braces out of the comment.';
  return undefined;
}

// ---- the run, as the browser shows it -----------------------------------------------------------------------------

export type WarmUpStepStatus = 'pending' | 'running' | 'done' | 'skipped';
export type WarmUpRunStatus = 'running' | 'done' | 'stopped';

/** Why a run stopped before its last step. */
export type WarmUpStopReason =
  | 'cancelled'
  | 'replied'
  | 'messaged'
  | 'connected'
  /** the student sent them a connection request from Orbit (Connect) */
  | 'connect_sent'
  | 'do_not_contact'
  | 'hidden'
  | 'merged'
  | 'person_gone'
  | 'linkedin_disconnected'
  | 'linkedin_parked'
  | 'linkedin_sign_in'
  | 'linkedin_changed'
  | 'setting_off';

/** Why a step did not run, or how it ended. */
export type WarmUpStepNote =
  | 'post_gone'
  | 'failed'
  | 'unconfirmed'
  | 'already_reacted'
  | 'stopped'
  | 'no_profile';

export interface WarmUpRunStep {
  id: ID;
  seq: number;
  kind: WarmUpAutoKind;
  dueAt: string;
  status: WarmUpStepStatus;
  attempts: number;
  ranAt?: string;
  note?: WarmUpStepNote | string;
}

/** One automated warm-up as the server keeps it and the browser receives it (orbit.warmups with its steps). */
export interface WarmUpRun {
  id: ID;
  userId: ID;
  personId: ID;
  status: WarmUpRunStatus;
  stopReason?: WarmUpStopReason | string;
  /** the post the like and the comment go on; unset when the person has no recent post */
  post?: { url?: string; excerpt?: string; topic?: string; postedAt?: string };
  /** the comment approved at Start, exactly as posted; null or unset when left out */
  comment?: string | null;
  steps: WarmUpRunStep[];
  startedAt: string;
  readyAt: string;
  finishedAt?: string;
  /** when the student was told it is done (the toast they saw); unset: not told yet */
  toldAt?: string;
  updatedAt?: string;
}

/**
 * What the start sheet shows before anything runs: the post Orbit picked, the comment it drafted and the days of the
 * steps. Nothing is scheduled until the student presses Start; the comment they approve there (edited or not) is the
 * only text that is ever posted.
 */
export interface WarmUpPreview {
  /** the preview's id: Start names it, so the post is the one the student saw */
  id: ID;
  personId: ID;
  /** null: no recent post, so the warm-up is the profile view only */
  post: { url?: string; excerpt: string; postedAt?: string } | null;
  /** the drafted comment; null when there is no post, or none could be written */
  comment: string | null;
  /** the steps with their days, the comment step included when there is a post */
  steps: AutoStepPlan[];
  timezone: string;
}

/**
 * Why a warm-up cannot be previewed or started right now. `off`: "Run warm-ups for me" is off; `not_connected` and
 * `sign_in`: LinkedIn is not connected, or needs a new sign-in; `unconfigured`: this server cannot reach LinkedIn;
 * `no_profile`: Orbit has no LinkedIn profile for the person; `unknown_person`: the server does not have the person
 * yet (they were added a moment ago); `blocked`: they are hidden or marked do not contact;
 * `busy`: LinkedIn cannot be read right now, try later; `running`: a warm-up for them is already under way.
 */
export type WarmUpRefusal =
  | 'off'
  | 'not_connected'
  | 'sign_in'
  | 'unconfigured'
  | 'no_profile'
  | 'unknown_person'
  | 'blocked'
  | 'busy'
  | 'running';

export type WarmUpPreviewResult =
  | { ok: true; preview: WarmUpPreview }
  | { ok: false; reason: WarmUpRefusal; run?: WarmUpRun };
export type WarmUpStartResult =
  | { ok: true; run: WarmUpRun }
  | { ok: false; reason: WarmUpRefusal; run?: WarmUpRun };

/** A refusal in words for the student. */
export const WARMUP_REFUSAL_WORDS: Record<WarmUpRefusal, string> = {
  off: 'Run warm-ups for me is off in Settings. Turn it on, or do the steps yourself.',
  not_connected: 'Connect LinkedIn in Settings so Orbit can run the warm-up for you.',
  sign_in: 'LinkedIn needs you to sign in again. Reconnect it in Settings, then start the warm-up.',
  unconfigured: 'Orbit cannot reach LinkedIn right now. You can still do the steps yourself.',
  no_profile: 'Orbit has no LinkedIn profile for this person, so there is nothing to warm up on.',
  unknown_person: 'Orbit is still saving this person. Try again in a moment.',
  blocked: 'This person is hidden or marked do not contact, so Orbit will not start a warm-up.',
  busy: 'LinkedIn cannot be read right now. Try again in a little while.',
  running: 'A warm-up for this person is already under way.',
};

/** What each step is called while Orbit runs it. */
export const AUTO_STEP_LABELS: Record<WarmUpAutoKind, string> = {
  view_profile: 'Orbit views their profile',
  react_post: 'Orbit likes one recent post',
  comment_post: 'Orbit leaves the comment you approved',
};

const MANUAL_LABELS: Record<WarmUpAutoKind, string> = {
  view_profile: 'Look at their profile and what they post about',
  react_post: 'React to one recent post that you genuinely find useful',
  comment_post: 'Leave one substantive comment: a question or an added point, not praise',
};

/** A step's note in words, for the person's page. */
export const WARMUP_STEP_NOTE_WORDS: Record<WarmUpStepNote, string> = {
  post_gone: 'The post is gone, so Orbit skipped this step.',
  failed: 'LinkedIn did not take this step, twice. Orbit skipped it.',
  unconfirmed: 'LinkedIn did not confirm the comment. Orbit did not try again, so it is never posted twice.',
  already_reacted: 'You had already reacted to this post.',
  stopped: 'Not run: the warm-up stopped first.',
  no_profile: 'Orbit could not find their LinkedIn profile.',
};

/** Why a run stopped, in words. `first` is the person's first name. */
export function warmUpStopWords(reason: string | undefined, first: string): string {
  switch (reason) {
    case 'cancelled':
      return 'You stopped this warm-up.';
    case 'replied':
      return `${first} wrote to you, so Orbit stopped the warm-up.`;
    case 'messaged':
      return `You already wrote to ${first}, so Orbit stopped the warm-up.`;
    case 'connected':
      return `You and ${first} are connected now, so Orbit stopped the warm-up.`;
    case 'connect_sent':
      return `You sent ${first} a connection request, so Orbit stopped the warm-up.`;
    case 'do_not_contact':
      return `${first} is marked do not contact, so Orbit stopped the warm-up.`;
    case 'hidden':
    case 'merged':
    case 'person_gone':
      return `${first} is no longer in your list, so Orbit stopped the warm-up.`;
    case 'linkedin_sign_in':
      return 'LinkedIn needs you to sign in again, so Orbit stopped the warm-up. The steps left are yours to do.';
    case 'linkedin_disconnected':
    case 'linkedin_parked':
    case 'linkedin_changed':
      return 'LinkedIn is not connected, so Orbit stopped the warm-up. The steps left are yours to do.';
    case 'setting_off':
      return 'You turned off "Run warm-ups for me". The steps left are yours to do.';
    default:
      return 'Orbit stopped this warm-up.';
  }
}

/**
 * The chat's warm-up plan as a run stands: one action per step, done with the time it ran, skipped with why. A step
 * that engaged with the post carries the post's topic as its note, so the first message can name the post. A run Orbit
 * stopped hands the steps it never reached back to the student, open again under their manual labels; a run the
 * student stopped leaves them closed (the chat leaves the warm-up).
 */
export function planFromRun(run: WarmUpRun, slug: string): WarmUpPlan {
  const live = run.status !== 'stopped';
  // stopped by Orbit (LinkedIn needs a sign-in, the setting went off): the steps it never reached are the student's
  // to do, not steps anyone skipped. Stopped by the student: nothing is left to do.
  const handBack = run.status === 'stopped' && run.stopReason !== 'cancelled';
  const actions: WarmUpAction[] = run.steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const done = s.status === 'done';
      const open = handBack && s.status !== 'done' && (s.status !== 'skipped' || s.note === 'stopped');
      const skipped = s.status === 'skipped' && !open;
      const noteWords = !open && s.note ? WARMUP_STEP_NOTE_WORDS[s.note as WarmUpStepNote] : undefined;
      return {
        id: `w${s.seq}`,
        kind: s.kind,
        label: live || done || skipped ? AUTO_STEP_LABELS[s.kind] : MANUAL_LABELS[s.kind],
        url:
          s.kind === 'view_profile' ? linkedinProfileUrl(slug) : (run.post?.url ?? linkedinActivityUrl(slug)),
        dueAt: s.dueAt,
        ...(done ? { doneAt: s.ranAt ?? s.dueAt } : {}),
        ...(skipped ? { skippedAt: s.ranAt ?? run.finishedAt ?? s.dueAt } : {}),
        ...(done && s.kind !== 'view_profile' && run.post?.topic ? { note: run.post.topic } : {}),
        ...(noteWords ? { autoNote: noteWords } : {}),
      };
    });
  return {
    startedAt: run.startedAt,
    readyAt: run.status === 'done' ? (run.finishedAt ?? run.readyAt) : run.readyAt,
    actions,
    auto: {
      runId: run.id,
      status: run.status,
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      comment: run.comment ?? null,
      ...(run.post?.url ? { postUrl: run.post.url } : {}),
      ...(run.post?.excerpt ? { postExcerpt: run.post.excerpt } : {}),
    },
  };
}

/** Whether Orbit is running this plan right now (the student has nothing to do). */
export function autoWarmUpRunning(plan: WarmUpPlan | undefined): boolean {
  return plan?.auto?.status === 'running';
}

// ---- the plan in plain words --------------------------------------------------------------------------------------

/** "Today", "Tomorrow", "Wednesday" within the week, else "Mon, Dec 14", in the student's time zone. */
export function autoDayLabel(iso: string, now: Date, tz?: string): string {
  const key = wallKey(new Date(iso), tz);
  const today = wallKey(now, tz);
  const diff = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  const d = new Date(`${key}T12:00:00Z`);
  if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface AutoPlanLine {
  kind: WarmUpAutoKind;
  day: string;
  text: string;
}

/**
 * The whole plan as the start sheet says it: "Today: view Priya's profile." "Wednesday: like their post: …"
 * "Thursday: comment on that post." The comment's own words are shown under its line, where the student can edit them.
 */
export function autoPlanLines(o: {
  firstName: string;
  steps: { kind: WarmUpAutoKind; dueAt: string }[];
  postExcerpt?: string;
  now: Date;
  tz?: string;
}): AutoPlanLine[] {
  const name = o.firstName.trim() || 'their';
  const whose = name === 'their' ? 'their' : `${name}${/s$/i.test(name) ? "'" : "'s"}`;
  return o.steps.map((s) => ({
    kind: s.kind,
    day: autoDayLabel(s.dueAt, o.now, o.tz),
    text:
      s.kind === 'view_profile'
        ? `view ${whose} profile.`
        : s.kind === 'react_post'
          ? o.postExcerpt
            ? `like their post: "${o.postExcerpt}"`
            : 'like their most recent post.'
          : 'comment on that post.',
  }));
}
