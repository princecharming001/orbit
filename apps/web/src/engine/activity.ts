/**
 * What Orbit is doing (plan 23 §4.7): one store every background reader reports to, so one quiet line can say it.
 * The readers (the reply check, the LinkedIn sync and enrichment, the photo and logo queues, the hop reads, the
 * notetakers, the account's server sync) call startActivity when they begin, progressActivity as they go and
 * endActivity when they stop. The line shows the newest of them, or "Up to date" with when replies were last checked,
 * or the first problem (LinkedIn signed out, today's reads used up). Today's counts are read from the same rows the
 * readers already keep (the enrichment budget, the photo and logo day counters, the reply check), never counted here,
 * so they always agree with Settings.
 *
 * In memory only: what runs is a fact about this open page. Nothing here is sent anywhere.
 */
import type { User } from '@orbit/core';
import { db } from '../db/schema';
import { enrichmentStatus } from './enrichment';
import { DAILY, linkedInPaused, readBudget } from './enrichment/store';
import { linkedInLiveStatus } from './linkedinLive';

export interface ActivityItem {
  id: string;
  /** "Reading LinkedIn profiles", "Checking for replies" */
  text: string;
  done?: number;
  total?: number;
  /** ms */
  startedAt: number;
  /** ms: the last start or progress; an item quiet for 10 minutes is taken as stuck and dropped */
  touchedAt: number;
  /** where clicking the line goes */
  link?: string;
  /**
   * slow, steady background work (a photo or a logo every few seconds, all afternoon): listed in the popover, never
   * on the line, so the line still reads "Up to date" while it trickles on
   */
  quiet?: boolean;
}

export interface ActivityProblem {
  id: string;
  text: string;
  /** the words of the link that fixes it */
  fix: string;
  link: string;
}

/** An item with no progress for this long is dropped (and logged): a reader that died never leaves the line stuck. */
export const STALE_MS = 10 * 60_000;
/** The line never changes faster than this. */
export const LINE_EVERY_MS = 2000;

const live = new Map<string, ActivityItem>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const fn of listeners) fn();
}

export function subscribeActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Changes whenever an item starts, moves or ends, for useSyncExternalStore. */
export function activityVersion(): number {
  return version;
}

export function startActivity(
  id: string,
  text: string,
  opts: { total?: number; link?: string; now?: number; quiet?: boolean } = {},
): void {
  const now = opts.now ?? Date.now();
  const cur = live.get(id);
  live.set(id, {
    id,
    text,
    total: opts.total,
    done: opts.total !== undefined ? 0 : undefined,
    link: opts.link,
    ...(opts.quiet ? { quiet: true } : {}),
    startedAt: cur?.startedAt ?? now,
    touchedAt: now,
  });
  emit();
}

export function progressActivity(
  id: string,
  done: number,
  opts: { total?: number; text?: string; now?: number } = {},
): void {
  const cur = live.get(id);
  if (!cur) return;
  live.set(id, {
    ...cur,
    done,
    total: opts.total ?? cur.total,
    text: opts.text ?? cur.text,
    touchedAt: opts.now ?? Date.now(),
  });
  emit();
}

export function endActivity(id: string): void {
  if (live.delete(id)) emit();
}

/** Run `work` as one activity: started now, ended however it finishes. */
export async function asActivity<T>(
  id: string,
  text: string,
  work: () => Promise<T>,
  opts: { total?: number; link?: string } = {},
): Promise<T> {
  startActivity(id, text, opts);
  try {
    return await work();
  } finally {
    endActivity(id);
  }
}

/** What runs now, newest first, without the stuck ones (each dropped one is logged once). */
export function liveActivities(now = Date.now()): ActivityItem[] {
  for (const [id, a] of live)
    if (now - a.touchedAt > STALE_MS) {
      live.delete(id);
      console.warn(
        `activity: dropped "${a.text}", no progress for ${Math.round((now - a.touchedAt) / 60_000)} min`,
      );
    }
  return [...live.values()].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
}

/** tests only */
export function resetActivityForTests(): void {
  live.clear();
  version = 0;
}

/** "Reading LinkedIn profiles · 12 of 40" */
export function itemText(a: Pick<ActivityItem, 'text' | 'done' | 'total'>): string {
  if (a.total !== undefined && a.total > 0) return `${a.text} · ${a.done ?? 0} of ${a.total}`;
  return a.done ? `${a.text} · ${a.done.toLocaleString('en-US')}` : a.text;
}

/** "just now", "2 min ago", "3 h ago" */
export function agoWords(at: string | undefined, now: number): string | undefined {
  if (!at) return undefined;
  // the same words as the "Checked for replies" line in Drafts
  const diff = now - Date.parse(at);
  if (!Number.isFinite(diff) || diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export interface ActivityLine {
  state: 'running' | 'idle' | 'problem';
  text: string;
  /** the fix for a problem */
  fix?: { text: string; link: string };
}

/**
 * The one line: the first problem (it needs the student, so it outranks work in progress), else the newest live item
 * that is not quiet (at most one is shown), else "Up to date" and when the replies were last checked.
 */
export function activityLine(
  items: ActivityItem[],
  problems: ActivityProblem[],
  lastReplyCheckAt: string | undefined,
  now: number,
): ActivityLine {
  const p = problems[0];
  if (p) return { state: 'problem', text: p.text, fix: { text: p.fix, link: p.link } };
  const top = items.find((a) => !a.quiet);
  if (top) return { state: 'running', text: itemText(top) };
  const ago = agoWords(lastReplyCheckAt, now);
  return { state: 'idle', text: ago ? `Up to date · checked replies ${ago}` : 'Up to date' };
}

// ---------- today's counts ----------

export interface ActivityCounts {
  /** LinkedIn profiles read today, background and on view, against the day's allowance */
  profiles: number;
  profilesOf: number;
  searches: number;
  searchesOf: number;
  photos: number;
  logos: number;
  /** LinkedIn activity read for routes today */
  posts: number;
  repliesChecked: number;
  notes: number;
  /** every profile filled in so far, the number Settings shows */
  profilesFilled: number;
}

const dayCountKey = (userId: string) => `activity:day:${userId}`;
const today = (now: Date) => now.toISOString().slice(0, 10);

type DayCounts = { day: string; repliesChecked?: number; notes?: number; posts?: number };

/** One more reply check, note filed or post read today (kept in db.kv: the readers that do not count themselves). */
export async function countActivity(
  userId: string,
  kind: 'repliesChecked' | 'notes' | 'posts',
  n = 1,
  now = new Date(),
): Promise<void> {
  if (n <= 0) return;
  const day = today(now);
  await db.transaction('rw', db.kv, async () => {
    const cur = (await db.kv.get(dayCountKey(userId)))?.value as DayCounts | undefined;
    const row: DayCounts = cur?.day === day ? { ...cur } : { day };
    row[kind] = (row[kind] ?? 0) + n;
    await db.kv.put({ key: dayCountKey(userId), value: row });
  });
}

/** Today's counts, read from the rows the readers keep. */
export async function activityCounts(user: Pick<User, 'id'>, now = new Date()): Promise<ActivityCounts> {
  const day = today(now);
  const [budget, photos, logos, mine, status] = await Promise.all([
    readBudget(user.id, now),
    db.kv.get(`photos:day:${user.id}`),
    db.kv.get(`logos:day:${user.id}`),
    db.kv.get(dayCountKey(user.id)),
    enrichmentStatus(user, now),
  ]);
  const used = (v: unknown) => {
    const x = v as { day?: string; used?: number } | undefined;
    return x?.day === day ? (x.used ?? 0) : 0;
  };
  const c = (mine?.value as DayCounts | undefined)?.day === day ? (mine!.value as DayCounts) : { day };
  return {
    profiles: (budget.used.profile ?? 0) + (budget.used.view ?? 0),
    profilesOf: DAILY.profile + DAILY.view,
    searches: budget.used.search ?? 0,
    searchesOf: DAILY.search,
    photos: used(photos?.value),
    logos: used(logos?.value) + (budget.used.company ?? 0),
    posts: c.posts ?? 0,
    repliesChecked: c.repliesChecked ?? 0,
    notes: c.notes ?? 0,
    profilesFilled: status.profiles,
  };
}

// ---------- problems ----------

/** What needs the student: LinkedIn signed out, LinkedIn's reads paused for the day, an account that needs signing in. */
export async function activityProblems(user: User, now = new Date()): Promise<ActivityProblem[]> {
  const out: ActivityProblem[] = [];
  const rows = await db.integrations.where('userId').equals(user.id).toArray();
  const li = await linkedInLiveStatus(user, now).catch(() => undefined);
  if (li?.signedOut)
    out.push({
      id: 'linkedin-signed-out',
      text: 'LinkedIn signed you out',
      fix: 'Sign in again',
      link: '/settings/integrations',
    });
  const budget = await readBudget(user.id, now);
  if (li?.connected && linkedInPaused(budget, now))
    out.push({
      id: 'linkedin-paused',
      text: 'Daily LinkedIn reads used',
      fix: 'More tomorrow',
      link: '/settings/integrations',
    });
  const NAMES: Record<string, string> = {
    google: 'Google',
    fathom: 'Fathom',
    granola: 'Granola',
    fireflies: 'Fireflies',
    wispr: 'Wispr Flow',
    calcom: 'Cal.com',
  };
  for (const r of rows)
    if (r.status === 'needs_reauth' && NAMES[r.provider])
      out.push({
        id: `reauth-${r.provider}`,
        text: `${NAMES[r.provider]} needs you to sign in again`,
        fix: 'Sign in again',
        link: '/settings/integrations',
      });
  return out;
}
