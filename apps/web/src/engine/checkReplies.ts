/**
 * The reply check (plan 18): while the app is open, Orbit reads the places a reply can arrive every few minutes and
 * when the window comes back, then runs the stage rules at once, so a card moves within minutes of the reply, the
 * booking or the meeting's end instead of at the next day's brief.
 *
 * One check, in order: Gmail and the calendar (an incremental, quiet sync, when Google is connected and signed in),
 * the student's LinkedIn messages (when LinkedIn is connected live in this browser), then the timed rules (a booked
 * meeting that ended, two weeks after a thank-you, silence after the bumps). Each reader moves its chats itself and
 * every move is a stage event with its reason and evidence, so a check that finds nothing new changes nothing, and
 * two checks never move a chat twice. What the check found is kept in db.kv for the "Checked for replies 2 min ago"
 * line on the board and in Drafts.
 *
 * Nothing here runs when the app is closed: it is a timer in the open page, nothing more. An Orbit account's server
 * reads its own mail and LinkedIn; the sample student has nothing to read, so only the rules run for them.
 */
import type { User } from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { currentGoogleToken } from '../integrations/google';
import { isServerUser } from '../integrations/orbitApi';
import { countActivity, endActivity, startActivity } from './activity';
import { evaluateImmediateSuggestions } from './brief';
import { syncLinkedInReplies } from './linkedinInbox';
import { runTimedStageRules } from './stages';
import { syncGoogle } from './sync';

/** While the app is open, replies are checked this often. */
export const CHECK_EVERY_MS = 3 * 60_000;
/** The window coming back (focus, the tab shown again) checks again only when the last check is older than this. */
export const CHECK_ON_FOCUS_AFTER_MS = 60_000;
/** db.kv key prefix (plus the user id) of the last check's record. */
export const REPLY_CHECK_KV = 'replies-check:';

export type ReplySource = 'gmail' | 'linkedin';

export interface ReplyCheckState {
  checkedAt: string;
  /** what was read this time */
  sources: ReplySource[];
  /** a source that could not be read, in words the line can show */
  problems: { source: ReplySource; message: string }[];
  /** chats Orbit moved during this check (a reply read, a meeting over) */
  moved: number;
  /** why it ran */
  reason: 'open' | 'interval' | 'focus' | 'manual';
}

/** Where a reply can reach this student, as the line on the board sees it. */
export interface ReplySources {
  /** Google is connected (replies and meetings are read from Gmail and the calendar) */
  gmail: boolean;
  /** the live LinkedIn row is connected in this browser */
  linkedin: boolean;
  /** the sample student: nothing real to read, but the check (and its line) still runs */
  demo: boolean;
}

export function replyCheckKey(userId: string): string {
  return `${REPLY_CHECK_KV}${userId}`;
}

export async function replySources(userId: string): Promise<ReplySources> {
  const rows = await db.integrations.where('userId').equals(userId).toArray();
  const li = rows.find((i) => i.provider === 'linkedin_live');
  return {
    gmail: rows.some((i) => i.provider === 'google' && i.status === 'active'),
    linkedin: !!li && li.status !== 'revoked' && !!li.externalAccountId,
    demo: rows.some((i) => i.provider === 'demo'),
  };
}

export async function lastReplyCheck(userId: string): Promise<ReplyCheckState | undefined> {
  const row = await db.kv.get(replyCheckKey(userId));
  const v = row?.value as ReplyCheckState | undefined;
  return v && typeof v.checkedAt === 'string' ? v : undefined;
}

let running: Promise<ReplyCheckState> | undefined;
const watchers = new Set<() => void>();
function changed() {
  for (const w of watchers) w();
}

/** True while a check is running: the line says "Checking for replies". */
export function checkingReplies(): boolean {
  return !!running;
}

export function watchReplyCheck(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/**
 * Read every connected source once, run the stage rules, record when. Checks that overlap share one run (a "Check
 * now" during the timer's check waits for it rather than reading everything twice). Never throws: a source that
 * fails is a problem on the record, and the rules still run.
 */
export function checkReplies(
  user: User,
  opts: { now?: Date; reason?: ReplyCheckState['reason']; fetch?: typeof fetch } = {},
): Promise<ReplyCheckState> {
  if (running) return running;
  startActivity('replies', 'Checking for replies');
  const run = checkOnce(user, opts)
    .then(async (s) => {
      await countActivity(user.id, 'repliesChecked', 1, opts.now).catch(() => undefined);
      return s;
    })
    .finally(() => {
      running = undefined;
      endActivity('replies');
      changed();
    });
  running = run;
  changed();
  return run;
}

async function checkOnce(
  user: User,
  opts: { now?: Date; reason?: ReplyCheckState['reason']; fetch?: typeof fetch },
): Promise<ReplyCheckState> {
  const now = opts.now ?? new Date();
  const state: ReplyCheckState = {
    checkedAt: now.toISOString(),
    sources: [],
    problems: [],
    moved: 0,
    reason: opts.reason ?? 'manual',
  };
  const local = !isServerUser(user.id) && !usesMockConnectors(user.id);
  const sources = await replySources(user.id);
  if (local && sources.gmail) {
    if (!currentGoogleToken()) {
      // the sign-in lasts an hour, or until the tab closes: Gmail cannot be read until the student signs in again
      state.problems.push({ source: 'gmail', message: 'Gmail is signed out' });
    } else {
      try {
        await syncGoogle(user, { quiet: true });
        state.sources.push('gmail');
      } catch (e) {
        state.problems.push({ source: 'gmail', message: `Gmail could not be read (${messageOf(e)})` });
      }
    }
  }
  if (local && sources.linkedin) {
    const r = await syncLinkedInReplies(user, { now, fetch: opts.fetch }).catch((e) => ({
      ok: false as const,
      reason: 'error' as const,
      message: messageOf(e),
    }));
    if (r.ok) state.sources.push('linkedin');
    else if (r.reason === 'error')
      state.problems.push({ source: 'linkedin', message: `LinkedIn could not be read (${r.message})` });
  }
  // the clock rules, right away: a meeting that ended is a chat to thank for now, not tomorrow morning
  const before = now.toISOString();
  const settings = await db.settings.get(user.id);
  await runTimedStageRules(user.id, settings?.maxBumps ?? 2, now).catch(() => undefined);
  const moved = await db.stageEvents
    .where('userId')
    .equals(user.id)
    .filter((e) => e.status === 'applied' && e.actor === 'system' && e.createdAt >= before)
    .toArray();
  state.moved = moved.length;
  // what the new stage calls for (the thank-you after a meeting) shows up in Drafts at once
  for (const e of moved) {
    const chat = await db.chats.get(e.chatId);
    if (chat)
      await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: chat.personId }, now).catch(
        () => undefined,
      );
  }
  // plan 23 §4.6: a reply a plan was waiting on ("after Dana replies") releases the next step's draft
  await import('./targetPlan').then((m) => m.releaseHeldSteps(user, now)).catch(() => undefined);
  await db.kv.put({ key: replyCheckKey(user.id), value: state });
  return state;
}

/** A check unless one ran in the last `after` ms (the window coming back, the app opening again). */
export async function autoCheckReplies(
  user: User,
  opts: { now?: Date; reason?: ReplyCheckState['reason']; after?: number } = {},
): Promise<ReplyCheckState | undefined> {
  const now = opts.now ?? new Date();
  const last = await lastReplyCheck(user.id);
  const at = last ? Date.parse(last.checkedAt) : Number.NaN;
  if (Number.isFinite(at) && now.getTime() - at < (opts.after ?? CHECK_ON_FOCUS_AFTER_MS)) return undefined;
  return checkReplies(user, { now, reason: opts.reason ?? 'focus' });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "just now", "2 min ago", "3 h ago": how long ago the last check was, for the line. */
export function checkedAgo(iso: string, now = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
