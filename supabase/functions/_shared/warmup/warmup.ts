/**
 * The automated LinkedIn warm-up on the server (docs/plan/13-linkedin-warm-up.md §8).
 *
 *   previewWarmup  reads the person's recent posts once (through the student's own LinkedIn account), picks the one to
 *                  engage with, drafts the comment, and keeps all of it as a preview row. Nothing is scheduled.
 *   startWarmup    the student pressed Start: the comment they saw (edited or not, or left out) is stored as the
 *                  approved text, the steps get their times, and the run is under way. From here nothing is asked and
 *                  no words are written or changed (the table's trigger refuses a change too).
 *   runWarmupStep  one step whose time has come: the visible profile view, the like, or the approved comment. Before
 *                  it acts it checks that the run should still go on, that it is working hours for the student, and
 *                  that the daily caps and the spacing allow it (orbit.warmup_take, under a lock). A step that fails
 *                  is tried once more later that day, then skipped with a note; the run still finishes.
 *   stopWarmup     the student's Stop, at any time.
 *
 * Safety: the only LinkedIn account ever used is the student's own row in orbit.integration_accounts (provider
 * linkedin, status active), and only while its Unipile id is the one the run was started with. No other Unipile
 * account or webhook is listed, read or changed. The sequence never sends a message or a connection request.
 */
import {
  afterGap,
  approvedCommentError,
  autoWarmUpSchedule,
  inWorkingHours,
  nextWorkingDaySlot,
  retrySlot,
  WARMUP_AUTO_CAPS,
  type WarmUpAutoKind,
  type WarmUpPreview,
  type WarmUpPreviewResult,
  type WarmUpRefusal,
  type WarmUpStartResult,
  type WarmUpStepNote,
  type WarmUpStopReason,
  warmUpPostCandidates,
  whenWorking,
} from '@orbit/core/warmup/auto';
import { checkBudget, recordUsage } from '../budget.ts';
import {
  buildUserContext,
  loadPerson,
  loadUserRow,
  styleCardOf,
  userFirstName,
  voiceText,
} from '../compose/context.ts';
import type { Db } from '../db.ts';
import { badRequest, HttpError } from '../http.ts';
import {
  createUnipileWarmup,
  type UnipileWarmup,
  type WarmupFailure,
  type WarmupResult,
} from '../providers/unipileWarmup';
import { firstNameOf } from '../rows.ts';
import type { Services } from '../services.ts';
import { switchGate } from '../switches.ts';
import { localParts, validZone, zonedTime } from '../zones.ts';
import { writeWarmupWords } from './comment.ts';
import { loadWarmupRun } from './shape.ts';

/** A preview is shown again, without reading LinkedIn again, for this long. */
export const PREVIEW_REUSE_MS = 6 * 3_600_000;
/** How many of the person's latest posts are read to choose from. */
export const POSTS_READ = 10;
const DEFAULT_ZONE = 'America/New_York';
/** budget.ts: the day's profile views for one student across all of Orbit; a warm-up view counts toward it */
const PROFILE_VIEWS_CAP = 'unipile_profile_views_daily';

/** The Unipile client for warm-up calls, bound to this request's fetch, the owner's switch and the swarm limit. */
export function warmupClient(s: Pick<Services, 'db' | 'fetch' | 'env' | 'targetTake'>): UnipileWarmup {
  return createUnipileWarmup({
    fetch: s.fetch,
    apiKey: s.env.unipileKey,
    baseUrl: s.env.unipileBase,
    gate: switchGate(s.db, 'unipile_reads'),
    targetTake: s.targetTake,
  });
}

interface OwnAccount {
  accountId: string | null;
  status: string;
}

/** The student's own LinkedIn row: the one place an account id is ever taken from. */
async function ownLinkedin(db: Db, userId: string): Promise<OwnAccount | undefined> {
  const [a] = await db.sql<{ external_account_id: string | null; status: string }>`
    select external_account_id, status from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = 'linkedin'`;
  return a ? { accountId: a.external_account_id, status: a.status } : undefined;
}

/** Why this account cannot be acted through, or undefined when it is active with an id. */
function accountRefusal(a: OwnAccount | undefined): WarmUpRefusal | undefined {
  if (!a) return 'not_connected';
  if (a.status === 'needs_reauth') return 'sign_in';
  if (a.status !== 'active' || !a.accountId) return 'not_connected';
  return undefined;
}

/** One LinkedIn call made for a warm-up, in the honest daily count (plan 41 F). Never fails the caller. */
async function countCall(db: Db, accountId: string, kind: string): Promise<void> {
  await db.sql`select public.orbit_linkedin_calls_add(${accountId}, ${kind}, 'warmup', 1, 0, 0)`.catch(
    () => undefined,
  );
}

/** What a failed read means for the sheet. */
function refusalOf(f: WarmupFailure): WarmUpRefusal {
  if (f.kind === 'unconfigured') return 'unconfigured';
  if (f.kind === 'account') return 'sign_in';
  if (f.kind === 'not_found') return 'no_profile';
  return 'busy';
}

type WarmupRow = {
  id: string;
  user_id: string;
  person_id: string;
  status: string;
  linkedin_account: string | null;
  target_member_id: string | null;
  target_slug: string | null;
  post_id: string | null;
  post_url: string | null;
  post_excerpt: string | null;
  post_at: Date | string | null;
  comment_draft: string | null;
  comment: string | null;
  timezone: string | null;
  warm_up_days: number | null;
  started_at: Date | string | null;
};

const isoOf = (v: Date | string | null | undefined): string | undefined =>
  v == null ? undefined : (v instanceof Date ? v : new Date(v)).toISOString();

function previewOf(row: WarmupRow, now: Date, tz: string, random: () => number): WarmUpPreview {
  const hasPost = !!row.post_id;
  const sched = autoWarmUpSchedule({
    now,
    warmUpDays: row.warm_up_days ?? undefined,
    tz,
    hasPost,
    withComment: hasPost,
    random,
  });
  return {
    id: row.id,
    personId: row.person_id,
    post: hasPost
      ? {
          ...(row.post_url ? { url: row.post_url } : {}),
          excerpt: row.post_excerpt ?? '',
          ...(isoOf(row.post_at) ? { postedAt: isoOf(row.post_at) } : {}),
        }
      : null,
    comment: hasPost ? (row.comment_draft ?? null) : null,
    steps: sched.steps,
    timezone: tz,
  };
}

async function runningFor(db: Db, userId: string, personId: string): Promise<string | undefined> {
  const [r] = await db.sql<{ id: string }>`
    select id from orbit.warmups
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and status = 'running'`;
  return r?.id;
}

/**
 * The plan for one person, before anything runs: their recent posts are read once, one is picked, the comment is
 * drafted. A preview made in the last six hours is shown again as it was, so opening the sheet twice costs LinkedIn
 * one read, not two.
 */
export async function previewWarmup(
  s: Services,
  userId: string,
  personId: string,
  opts: { warmUpDays?: number } = {},
): Promise<WarmUpPreviewResult> {
  const db = s.db;
  const now = s.now();
  const u = await loadUserRow(db, userId);
  if (u.settings.warmup_auto === false) return { ok: false, reason: 'off' };
  const acct = await ownLinkedin(db, userId);
  const noAccount = accountRefusal(acct);
  if (noAccount) return { ok: false, reason: noAccount };
  const accountId = acct!.accountId!;
  const person = await loadPerson(db, userId, personId);
  if (person.is_self || person.do_not_contact || person.hidden_at) return { ok: false, reason: 'blocked' };
  const slug = person.linkedin_slug ?? undefined;
  const identifier = person.linkedin_member_id ?? slug;
  if (!identifier) return { ok: false, reason: 'no_profile' };
  const running = await runningFor(db, userId, personId);
  if (running) return { ok: false, reason: 'running', run: await loadWarmupRun(db, userId, running) };
  const tz = validZone(u.timezone) ?? DEFAULT_ZONE;
  const days =
    typeof opts.warmUpDays === 'number' && Number.isFinite(opts.warmUpDays)
      ? Math.round(opts.warmUpDays)
      : undefined;

  const [kept] = await db.sql<WarmupRow>`
    select * from orbit.warmups
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and status = 'preview'
       and linkedin_account = ${accountId}
       and created_at > ${new Date(now.getTime() - PREVIEW_REUSE_MS)}::timestamptz
     order by created_at desc limit 1`;
  if (kept) {
    if (days !== undefined && days !== kept.warm_up_days) {
      await db.sql`update orbit.warmups set warm_up_days = ${days}::smallint where id = ${kept.id}::uuid`;
      kept.warm_up_days = days;
    }
    return { ok: true, preview: previewOf(kept, now, tz, s.random) };
  }

  const engage = warmupClient(s);
  if (!engage.configured) return { ok: false, reason: 'unconfigured' };
  let memberId = person.linkedin_member_id ?? undefined;
  if (!memberId) {
    // the posts route needs LinkedIn's own id: one quiet profile read (no visit is shown) finds it
    const verdict = await checkBudget(
      db,
      userId,
      { provider: 'unipile', operation: 'profile_view', units: 1 },
      now,
    );
    if (!verdict.ok && verdict.cap === PROFILE_VIEWS_CAP) return { ok: false, reason: 'busy' };
    const p = await engage.profile(accountId, identifier, { visible: false });
    if (!p.ok) return { ok: false, reason: refusalOf(p) };
    await countCall(db, accountId, 'profile');
    await recordUsage(db, { userId, provider: 'unipile', operation: 'profile_view', units: 1, costUsd: 0 });
    memberId = p.value.memberId;
    if (!memberId) return { ok: false, reason: 'no_profile' };
    await db.sql`
      update orbit.people set linkedin_member_id = ${memberId}
       where id = ${personId}::uuid and user_id = ${userId}::uuid and linkedin_member_id is null`.catch(
      () => undefined,
    );
  }
  const posts = await engage.posts(accountId, memberId, { limit: POSTS_READ });
  if (!posts.ok && posts.kind !== 'not_found') return { ok: false, reason: refusalOf(posts) };
  if (posts.ok) await countCall(db, accountId, 'posts');
  const candidates = posts.ok ? warmUpPostCandidates(posts.value, now) : [];
  const words = candidates.length
    ? await writeWarmupWords(s.claude, {
        userId,
        studentFirstName: userFirstName(u),
        student: await buildUserContext(db, u),
        voice: voiceText(styleCardOf(u)),
        personName: person.display_name,
        personHeadline: person.headline ?? person.title,
        candidates,
      })
    : undefined;

  await db.sql`
    delete from orbit.warmups
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and status = 'preview'`;
  const [row] = await db.sql<WarmupRow>`
    insert into orbit.warmups (user_id, person_id, status, linkedin_account, target_member_id, target_slug,
                               post_id, post_url, post_excerpt, post_topic, post_at, comment_draft, warm_up_days,
                               timezone)
    values (${userId}::uuid, ${personId}::uuid, 'preview', ${accountId}, ${memberId}, ${slug ?? null},
            ${words?.post.id ?? null}, ${words?.post.url ?? null}, ${words?.excerpt ?? null},
            ${words?.topic ?? null}, ${words?.post.at ?? null}::timestamptz, ${words?.comment ?? null},
            ${days ?? null}::smallint, ${tz})
    returning *`;
  return { ok: true, preview: previewOf(row!, now, tz, s.random) };
}

/**
 * Start: the comment in `comment` is the text the student saw in the sheet (null: they left it out). It is stored
 * exactly as it came and posted exactly as stored.
 */
export async function startWarmup(
  s: Services,
  userId: string,
  input: { warmupId: string; comment: string | null },
): Promise<WarmUpStartResult> {
  const db = s.db;
  const now = s.now();
  const [row] = await db.sql<WarmupRow>`
    select * from orbit.warmups where id = ${input.warmupId}::uuid and user_id = ${userId}::uuid`;
  if (!row) throw new HttpError(404, 'not_found', 'no such warm-up');
  if (row.status !== 'preview') {
    const run = await loadWarmupRun(db, userId, row.id);
    // pressed twice: the run that is already under way is the answer
    if (row.status === 'running' && run) return { ok: true, run };
    throw new HttpError(409, 'conflict', 'that warm-up is over');
  }
  const u = await loadUserRow(db, userId);
  if (u.settings.warmup_auto === false) return { ok: false, reason: 'off' };
  const acct = await ownLinkedin(db, userId);
  const noAccount = accountRefusal(acct);
  if (noAccount) return { ok: false, reason: noAccount };
  // the account that read the post is the account that acts: another one means the student connected a different
  // LinkedIn since, and the plan is made again from it
  if (acct!.accountId !== row.linkedin_account) return { ok: false, reason: 'not_connected' };
  const [p] = await db.sql<{ gone: boolean; connected: boolean }>`
    select (deleted_at is not null or merged_into is not null or hidden_at is not null or do_not_contact or is_self) as gone,
           (linkedin_connected_on is not null) as connected
      from orbit.people where id = ${row.person_id}::uuid and user_id = ${userId}::uuid`;
  if (!p || p.gone) return { ok: false, reason: 'blocked' };
  const running = await runningFor(db, userId, row.person_id);
  if (running) return { ok: false, reason: 'running', run: await loadWarmupRun(db, userId, running) };

  const comment = input.comment;
  if (comment !== null) {
    if (typeof comment !== 'string') throw badRequest('comment is text, or null to leave it out');
    if (!row.post_id) throw badRequest('there is no post to comment on');
    const wrong = approvedCommentError(comment);
    if (wrong) throw badRequest(wrong);
  }
  const tz = validZone(u.timezone) ?? DEFAULT_ZONE;
  const sched = autoWarmUpSchedule({
    now,
    warmUpDays: row.warm_up_days ?? undefined,
    tz,
    hasPost: !!row.post_id,
    withComment: comment !== null,
    random: s.random,
  });
  try {
    await db.begin(async (tx) => {
      const started = await tx.sql`
        update orbit.warmups
           set status = 'running', comment = ${comment}, comment_approved_at = ${now}::timestamptz,
               started_at = ${now}::timestamptz, ready_at = ${sched.readyAt}::timestamptz, timezone = ${tz},
               connected_at_start = ${p.connected}
         where id = ${row.id}::uuid and status = 'preview'
        returning id`;
      if (!started.length) throw new HttpError(409, 'conflict', 'that warm-up was already started');
      for (const st of sched.steps)
        await tx.sql`
          insert into orbit.warmup_steps (user_id, warmup_id, seq, kind, due_at)
          values (${userId}::uuid, ${row.id}::uuid, ${st.seq}::smallint, ${st.kind}, ${st.dueAt}::timestamptz)`;
      await tx.sql`
        insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
        values (${userId}::uuid, 'user', 'warmup.start', 'warmups', ${row.id},
                ${{
                  personId: row.person_id,
                  steps: sched.steps.map((x) => x.kind),
                  // the student approved these exact words (their length is kept here, the words on the row)
                  commentApproved: comment !== null,
                  commentChars: comment?.length ?? 0,
                  commentEdited: comment !== null && comment !== row.comment_draft,
                }}::jsonb)`;
    });
  } catch (e) {
    // two Starts for one person at once: the unique index let one through
    if (e instanceof HttpError) throw e;
    const other = await runningFor(db, userId, row.person_id);
    if (other) return { ok: false, reason: 'running', run: await loadWarmupRun(db, userId, other) };
    throw e;
  }
  const run = await loadWarmupRun(db, userId, row.id);
  return { ok: true, run: run! };
}

/** The student's Stop. True when a run was under way and is now stopped. */
export async function stopWarmup(
  s: Pick<Services, 'db' | 'now'>,
  userId: string,
  target: { warmupId?: string; personId?: string },
): Promise<{ stopped: boolean; run?: Awaited<ReturnType<typeof loadWarmupRun>> }> {
  const db = s.db;
  const [row] = target.warmupId
    ? await db.sql<{ id: string }>`
        select id from orbit.warmups where id = ${target.warmupId}::uuid and user_id = ${userId}::uuid`
    : await db.sql<{ id: string }>`
        select id from orbit.warmups
         where user_id = ${userId}::uuid and person_id = ${target.personId ?? null}::uuid and status = 'running'`;
  if (!row) return { stopped: false };
  const [r] = await db.sql<{ ok: boolean }>`
    select orbit.warmup_stop(${row.id}::uuid, 'cancelled', ${s.now()}::timestamptz) as ok`;
  if (r?.ok)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'warmup.stop', 'warmups', ${row.id}, ${{ reason: 'cancelled' }}::jsonb)`;
  return { stopped: !!r?.ok, run: await loadWarmupRun(db, userId, row.id) };
}

/** The student saw "the warm-up is done": never shown again, on any device. */
export async function markWarmupTold(db: Db, userId: string, warmupId: string, now: Date): Promise<boolean> {
  const r = await db.sql`
    update orbit.warmups set told_at = ${now}::timestamptz
     where id = ${warmupId}::uuid and user_id = ${userId}::uuid and told_at is null and status <> 'preview'
    returning id`;
  return r.length > 0;
}

// ---- running one step ----------------------------------------------------------------------------------------------

/** How one run of a step ended, for the job log and the tests. */
export type StepOutcome =
  /** nothing to do: not this user's, not pending, not due, or another job has it */
  | { kind: 'nothing'; why: string }
  /** the run stopped (a stop condition, or the account needs the student) */
  | { kind: 'stopped'; reason: WarmUpStopReason | string }
  /** not now: moved to a later time, no try counted */
  | { kind: 'waiting'; why: string; until: string }
  | { kind: 'done' }
  /** the try failed and the step waits for its second one */
  | { kind: 'retry'; error: string; until: string }
  | { kind: 'skipped'; note: WarmUpStepNote };

type StepRow = {
  id: string;
  seq: number;
  kind: WarmUpAutoKind;
  due_at: Date | string;
  status: string;
  attempts: number;
  result: { tries?: Record<string, unknown>[]; interrupted?: boolean } | null;
  warmup_id: string;
  person_id: string;
  run_status: string;
  linkedin_account: string | null;
  target_member_id: string | null;
  target_slug: string | null;
  post_id: string | null;
  comment: string | null;
  timezone: string | null;
};

const CALL_KIND: Record<WarmUpAutoKind, string> = {
  view_profile: 'profile',
  react_post: 'reaction',
  comment_post: 'comment',
};

/**
 * Run one step. Safe to call twice for the same step, at once or one after the other: the claim is one conditional
 * update, so the action is taken once.
 */
export async function runWarmupStep(s: Services, userId: string, stepId: string): Promise<StepOutcome> {
  const db = s.db;
  const now = s.now();
  const [st] = await db.sql<StepRow>`
    select s.id, s.seq, s.kind, s.due_at, s.status, s.attempts, s.result, s.warmup_id,
           w.person_id, w.status as run_status, w.linkedin_account, w.target_member_id, w.target_slug, w.post_id,
           w.comment, w.timezone
      from orbit.warmup_steps s join orbit.warmups w on w.id = s.warmup_id
     where s.id = ${stepId}::uuid and s.user_id = ${userId}::uuid and w.user_id = ${userId}::uuid`;
  if (!st) return { kind: 'nothing', why: 'no such step' };
  if (st.run_status !== 'running') return { kind: 'nothing', why: 'run is not under way' };
  if (st.status !== 'pending') return { kind: 'nothing', why: `step is ${st.status}` };
  if (new Date(st.due_at).getTime() > now.getTime()) return { kind: 'nothing', why: 'not due yet' };
  const tz = validZone(st.timezone) ?? DEFAULT_ZONE;

  const defer = async (why: string, until: Date): Promise<StepOutcome> => {
    await db.sql`
      update orbit.warmup_steps set due_at = ${until}::timestamptz where id = ${stepId}::uuid and status = 'pending'`;
    await touch(db, st.warmup_id);
    return { kind: 'waiting', why, until: until.toISOString() };
  };
  const tomorrow = () => nextWorkingDaySlot(now, tz, s.random);

  // 1. should this run still go on at all?
  const [stop] = await db.sql<{ reason: string | null }>`
    select orbit.warmup_stop_reason(${st.warmup_id}::uuid) as reason`;
  if (stop?.reason) {
    await stopRun(db, userId, st.warmup_id, stop.reason, now);
    return { kind: 'stopped', reason: stop.reason };
  }
  // 2. the student's own account, active, and the one the run was started with (anything else stopped the run above,
  //    except an account that is mid-connect or in a passing error: those wait)
  const acct = await ownLinkedin(db, userId);
  if (acct?.status !== 'active' || !acct.accountId || acct.accountId !== st.linkedin_account)
    return defer('account', tomorrow());
  const accountId = acct.accountId;
  // 3. working hours only, in the student's time zone
  if (!inWorkingHours(now, tz)) return defer('hours', whenWorking(now, tz, s.random));
  const engage = warmupClient(s);
  if (!engage.configured) return defer('unconfigured', tomorrow());
  // 4. a step that already had its tries (a worker died under the last one) is closed, not tried a third time
  if (st.attempts >= WARMUP_AUTO_CAPS.maxAttempts) {
    const ambiguousComment = st.kind === 'comment_post' && lastTryUnsure(st);
    return skip(ambiguousComment ? 'unconfirmed' : 'failed');
  }
  if (st.kind !== 'view_profile' && !st.post_id) return skip('post_gone');
  if (st.kind === 'comment_post' && st.comment === null) return skip('stopped');
  const target = st.target_member_id ?? st.target_slug;
  if (st.kind === 'view_profile' && !target) return skip('no_profile');
  // 5. the day's profile views across all of Orbit (budget.ts): over it, the view waits for tomorrow
  if (st.kind === 'view_profile') {
    const verdict = await checkBudget(
      db,
      userId,
      { provider: 'unipile', operation: 'profile_view', units: 1 },
      now,
    );
    if (!verdict.ok && verdict.cap === PROFILE_VIEWS_CAP) return defer('budget', tomorrow());
  }
  // 6. claim it: one job runs a step
  const claimed = await db.sql<{ attempts: number }>`
    update orbit.warmup_steps set status = 'running', attempts = attempts + 1, claimed_at = ${now}::timestamptz
     where id = ${stepId}::uuid and status = 'pending'
       and exists (select 1 from orbit.warmups w where w.id = warmup_id and w.status = 'running')
    returning attempts`;
  if (!claimed.length) return { kind: 'nothing', why: 'another job has it' };
  const attempt = Number(claimed[0]!.attempts);
  const unclaim = async (until: Date) => {
    await db.sql`
      update orbit.warmup_steps
         set status = 'pending', attempts = greatest(attempts - 1, 0), claimed_at = null, due_at = ${until}::timestamptz
       where id = ${stepId}::uuid and status = 'running'`;
    await touch(db, st.warmup_id);
  };
  // 7. the daily caps and the spacing, counted under a lock so two jobs at once cannot both pass
  const dayStart = zonedTime(localParts(now, tz).key, 0, 0, tz);
  const [take] = await db.sql<{ allowed: boolean; reason: string | null; retry_at: Date | string | null }>`
    select allowed, reason, retry_at from orbit.warmup_take(
      ${userId}::uuid, ${st.person_id}::uuid, ${stepId}::uuid, ${st.kind}, ${accountId},
      ${dayStart}::timestamptz, ${WARMUP_AUTO_CAPS.perDay[st.kind]}::int, ${WARMUP_AUTO_CAPS.minGapSeconds}::int,
      ${WARMUP_AUTO_CAPS.perPersonPerDay}::int, ${now}::timestamptz)`;
  if (!take?.allowed) {
    // too soon after the last action: once the gap has passed, plus a random extra; a full day or a person who
    // already had an action today: the next working day
    const lastAt =
      take?.reason === 'gap' && take.retry_at
        ? new Date(new Date(take.retry_at).getTime() - WARMUP_AUTO_CAPS.minGapSeconds * 1000)
        : undefined;
    const until = lastAt ? whenWorking(afterGap(lastAt, now, s.random), tz, s.random) : tomorrow();
    await unclaim(until);
    return { kind: 'waiting', why: take?.reason ?? 'cap', until: until.toISOString() };
  }
  /** the action was not made after all (no call left this machine): it is not counted */
  const untake = () =>
    db.sql`delete from orbit.warmup_actions where step_id = ${stepId}::uuid and at = ${now}::timestamptz`;

  // 8. the action itself
  let r: WarmupResult<unknown>;
  let found = false;
  try {
    if (st.kind === 'view_profile') r = await engage.profile(accountId, target!, { visible: true });
    else if (st.kind === 'react_post') r = await engage.react(accountId, st.post_id!);
    else {
      // a comment whose earlier try gave no answer may be on the post already: look before posting again
      if (lastTryUnsure(st)) {
        const there = await engage.hasComment(accountId, st.post_id!, st.comment!);
        await countCall(db, accountId, 'comments_read');
        if (!there.ok) {
          await record({ ok: false, error: `check:${there.kind}` });
          if (there.kind === 'account') return needsStudent();
          if (there.kind === 'not_found') return postGone();
          return finishSkip('unconfirmed');
        }
        found = there.value;
      }
      r = found ? { ok: true, value: {} } : await engage.comment(accountId, st.post_id!, st.comment!);
    }
  } catch (e) {
    r = {
      ok: false,
      kind: 'unavailable',
      message: e instanceof Error ? e.message : 'error',
      ambiguous: st.kind !== 'view_profile',
    };
  }

  if (r.ok) {
    if (!found) await countCall(db, accountId, CALL_KIND[st.kind]);
    if (st.kind === 'view_profile') {
      await recordUsage(db, { userId, provider: 'unipile', operation: 'profile_view', units: 1, costUsd: 0 });
      const memberId = (r.value as { memberId?: string }).memberId;
      if (memberId && !st.target_member_id) {
        await db.sql`update orbit.warmups set target_member_id = ${memberId} where id = ${st.warmup_id}::uuid`;
        await db.sql`
          update orbit.people set linkedin_member_id = ${memberId}
           where id = ${st.person_id}::uuid and user_id = ${userId}::uuid and linkedin_member_id is null`.catch(
          () => undefined,
        );
      }
    }
    const already = st.kind === 'react_post' && (r.value as { already?: boolean }).already === true;
    await record({ ok: true, ...(found ? { found: true } : {}), ...(already ? { already: true } : {}) });
    await db.sql`
      update orbit.warmup_steps
         set status = 'done', ran_at = ${now}::timestamptz, note = ${already ? 'already_reacted' : null}
       where id = ${stepId}::uuid and status = 'running'`;
    await finishIfOver(s, userId, st.warmup_id, now);
    return { kind: 'done' };
  }

  const f = r;
  const noCall = f.kind === 'busy' || f.kind === 'off' || f.kind === 'unconfigured';
  if (noCall) {
    // the swarm limit, the owner's switch: not a try, not counted, later
    await untake();
    const until =
      f.kind === 'busy' && f.retryAt ? whenWorking(new Date(f.retryAt), tz, s.random) : tomorrow();
    await unclaim(until);
    return { kind: 'waiting', why: f.kind, until: until.toISOString() };
  }
  await countCall(db, accountId, CALL_KIND[st.kind]);
  await record({
    ok: false,
    error: f.kind,
    ...(f.status ? { status: f.status } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.ambiguous ? { ambiguous: true } : {}),
  });
  if (f.kind === 'account') return needsStudent();
  if (f.kind === 'not_found') return st.kind === 'view_profile' ? finishSkip('no_profile') : postGone();
  if (attempt < WARMUP_AUTO_CAPS.maxAttempts) {
    const until = retrySlot(now, tz, s.random);
    await db.sql`
      update orbit.warmup_steps set status = 'pending', claimed_at = null, due_at = ${until}::timestamptz
       where id = ${stepId}::uuid and status = 'running'`;
    await touch(db, st.warmup_id);
    return { kind: 'retry', error: f.kind, until: until.toISOString() };
  }
  return finishSkip(st.kind === 'comment_post' && f.ambiguous ? 'unconfirmed' : 'failed');

  // ---- the endings ----

  /** one more entry in the step's record of what happened */
  async function record(entry: Record<string, unknown>) {
    await db.sql`
      update orbit.warmup_steps
         set result = jsonb_set(result - 'interrupted', '{tries}',
                                coalesce(result -> 'tries', '[]'::jsonb)
                                || jsonb_build_array(${{ at: now.toISOString(), ...entry }}::jsonb))
       where id = ${stepId}::uuid`;
  }
  /** close a step that never ran (nothing was claimed) */
  async function skip(note: WarmUpStepNote): Promise<StepOutcome> {
    await db.sql`
      update orbit.warmup_steps set status = 'skipped', note = ${note}, ran_at = ${now}::timestamptz
       where id = ${stepId}::uuid and status = 'pending'`;
    await finishIfOver(s, userId, st!.warmup_id, now);
    return { kind: 'skipped', note };
  }
  /** close the claimed step as skipped */
  async function finishSkip(note: WarmUpStepNote): Promise<StepOutcome> {
    await db.sql`
      update orbit.warmup_steps set status = 'skipped', note = ${note}, ran_at = ${now}::timestamptz
       where id = ${stepId}::uuid and status = 'running'`;
    await finishIfOver(s, userId, st!.warmup_id, now);
    return { kind: 'skipped', note };
  }
  /** the post is gone: this step and every other step on that post are skipped; the run goes on */
  async function postGone(): Promise<StepOutcome> {
    await db.sql`
      update orbit.warmup_steps set status = 'skipped', note = 'post_gone', ran_at = ${now}::timestamptz
       where warmup_id = ${st!.warmup_id}::uuid and kind in ('react_post', 'comment_post')
         and status in ('pending', 'running')`;
    await finishIfOver(s, userId, st!.warmup_id, now);
    return { kind: 'skipped', note: 'post_gone' };
  }
  /** LinkedIn turned the account away: the run stops and the steps left go back to the student */
  async function needsStudent(): Promise<StepOutcome> {
    await stopRun(db, userId, st!.warmup_id, 'linkedin_sign_in', now);
    return { kind: 'stopped', reason: 'linkedin_sign_in' };
  }
}

/** Whether the step's last try may have reached LinkedIn without an answer (a timeout, a 5xx, a worker that died). */
function lastTryUnsure(st: Pick<StepRow, 'result'>): boolean {
  if (st.result?.interrupted) return true;
  const tries = st.result?.tries ?? [];
  return tries.length > 0 && tries[tries.length - 1]!.ambiguous === true;
}

/** Raise the run's revision so its updated_at moves and the next pull carries the steps as they are now. */
async function touch(db: Db, warmupId: string): Promise<void> {
  await db.sql`update orbit.warmups set rev = rev + 1 where id = ${warmupId}::uuid`;
}

async function stopRun(db: Db, userId: string, warmupId: string, reason: string, now: Date): Promise<void> {
  const [r] = await db.sql<{ ok: boolean }>`
    select orbit.warmup_stop(${warmupId}::uuid, ${reason}, ${now}::timestamptz) as ok`;
  if (r?.ok)
    await db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'system', 'warmup.stop', 'warmups', ${warmupId}, ${{ reason }}::jsonb)`;
}

/**
 * When no step is left to run, the run is done, and the student is told once: one notification row, written by the
 * one update that sets notified_at.
 */
export async function finishIfOver(
  s: Pick<Services, 'db'>,
  userId: string,
  warmupId: string,
  now: Date,
): Promise<boolean> {
  const db = s.db;
  await touch(db, warmupId);
  const done = await db.sql<{ person_id: string }>`
    update orbit.warmups w
       set status = 'done', finished_at = ${now}::timestamptz
     where w.id = ${warmupId}::uuid and w.status = 'running'
       and not exists (select 1 from orbit.warmup_steps x
                        where x.warmup_id = w.id and x.status in ('pending', 'running'))
    returning person_id`;
  if (!done.length) return false;
  const first = await db.sql`
    update orbit.warmups set notified_at = ${now}::timestamptz
     where id = ${warmupId}::uuid and notified_at is null
    returning id`;
  if (!first.length) return true;
  const personId = done[0]!.person_id;
  const [p] = await db.sql<{ first_name: string | null; display_name: string }>`
    select first_name, display_name from orbit.people where id = ${personId}::uuid`;
  const [n] = await db.sql<{ ran: number }>`
    select count(*)::int as ran from orbit.warmup_steps where warmup_id = ${warmupId}::uuid and status = 'done'`;
  const name = p ? firstNameOf(p) : 'them';
  const ran = Number(n?.ran ?? 0);
  await db.sql`
    insert into orbit.notifications (user_id, kind, title, body, link)
    values (${userId}::uuid, 'system',
            ${ran > 0 ? `Orbit finished the warm-up for ${name}` : `Orbit could not run the warm-up for ${name}`},
            ${ran > 0 ? 'Your first message is ready to write.' : 'You can still write to them without it.'},
            ${`/people/${personId}`})`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'system', 'warmup.done', 'warmups', ${warmupId}, ${{ stepsRan: ran }}::jsonb)`;
  return true;
}
