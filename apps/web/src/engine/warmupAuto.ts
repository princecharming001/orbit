/**
 * The automated LinkedIn warm-up in the browser (docs/plan/13-linkedin-warm-up.md §8).
 *
 * With an Orbit account and the student's own LinkedIn connected, Orbit's server runs the steps: this file asks it
 * for the plan (`previewAutoWarmUp`), starts it with the exact comment the student approved (`startAutoWarmUp`),
 * stops it (`stopWarmUp`) and says once that it is done (`warmUpsToTell`). The run comes down with the sync and is
 * copied onto the chat by engine/warmupMirror.ts.
 *
 * The local copy has no server and keeps the manual flow: `autoWarmUpMode` is undefined there, and every caller falls
 * back to the reminders. The demo, once its sample LinkedIn is connected, simulates the run in this browser with the
 * mock connector's posts, so the feature can be tried: nothing leaves the browser.
 */
import {
  type AutoActionLog,
  autoWarmUpSchedule,
  type CoffeeChat,
  draftWarmUpComment,
  newId,
  type Person,
  planFromRun,
  postExcerpt,
  type User,
  WARMUP_REFUSAL_WORDS,
  type WarmUpPreview,
  type WarmUpRefusal,
  type WarmUpRun,
  wallKey,
  warmUpCapVerdict,
} from '@orbit/core';
import { notify } from '../db/repo';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { callApi, isAccountMode, isServerUser, isSignedIn } from '../integrations/orbitApi';
import { evaluateImmediateSuggestions, startsWithWarmUp, startWarmUpOrOutreach } from './brief';
import { moveChat } from './move';
import { freshLinkedinStatus, pushOutbox, serverIdOf } from './serverSync';
import { retireSuggestions } from './stages';
import { applyWarmUpRuns } from './warmupMirror';

export type AutoWarmUpMode = 'server' | 'demo';

async function demoLinkedInConnected(userId: string): Promise<boolean> {
  const row = await db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'linkedin_live')
    .first();
  return !!row && row.status !== 'revoked' && !!row.externalAccountId;
}

/**
 * Whether Orbit can run a warm-up for this student, and how: `server` for an Orbit account whose LinkedIn is
 * connected and active there, `demo` for the sample student with the sample LinkedIn connected. Undefined (the local
 * copy, LinkedIn not connected, or "Run warm-ups for me" turned off): the steps are the student's to do by hand.
 */
export async function autoWarmUpMode(user: Pick<User, 'id'>): Promise<AutoWarmUpMode | undefined> {
  const settings = await db.settings.get(user.id);
  if (settings?.warmUpAuto === false) return undefined;
  if (usesMockConnectors(user.id)) return (await demoLinkedInConnected(user.id)) ? 'demo' : undefined;
  if (!isAccountMode() || !isSignedIn() || !isServerUser(user.id)) return undefined;
  const { status } = await freshLinkedinStatus();
  return status === 'active' ? 'server' : undefined;
}

/**
 * Whether starting on this person should open the start sheet: Orbit can run warm-ups for the student, and a first
 * message to this person starts with one. False: the caller starts as it always did (a manual warm-up, or a draft).
 */
export async function opensWarmUpSheet(user: Pick<User, 'id'>, personId: string): Promise<boolean> {
  if (!(await startsWithWarmUp(user, personId, 'linkedin'))) return false;
  return !!(await autoWarmUpMode(user));
}

export type PreviewOutcome =
  | { ok: true; preview: WarmUpPreview; mode: AutoWarmUpMode }
  | { ok: false; reason: WarmUpRefusal | 'error'; message: string };

const refused = (reason: WarmUpRefusal): { ok: false; reason: WarmUpRefusal; message: string } => ({
  ok: false,
  reason,
  message: WARMUP_REFUSAL_WORDS[reason],
});

// ---- the demo's stand-in for LinkedIn -------------------------------------------------------------------------------

const DEMO_POSTS = [
  {
    topic: 'new hires shipping one small real change in their first week',
    text: 'New hires should ship one small real change in their first week. We dropped the week of onboarding decks last year and the difference showed within a month.',
  },
  {
    topic: 'writing a one-page memo before every meeting',
    text: 'A one-page memo before the meeting saves the meeting. If nobody can write down what we are deciding, we are not ready to decide it.',
  },
  {
    topic: 'asking about the project that failed in interviews',
    text: 'The best interview question I know is about a project that failed. How someone tells that story says more than any case study.',
  },
];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const demoPreviews = new Map<string, { preview: WarmUpPreview; topic?: string; url?: string }>();

async function demoPreview(user: User, person: Person, now: Date): Promise<PreviewOutcome> {
  const settings = await db.settings.get(user.id);
  // a few demo people post nothing, so the "profile view only" plan can be seen too
  const picked = hash(person.id) % 4 === 3 ? undefined : DEMO_POSTS[hash(person.id) % DEMO_POSTS.length];
  const comment = picked ? draftWarmUpComment(picked.topic, { seed: person.id }).text : null;
  const sched = autoWarmUpSchedule({
    now,
    warmUpDays: settings?.warmUpDays,
    tz: user.timezone,
    hasPost: !!picked,
    withComment: !!picked,
  });
  const url = person.linkedinSlug
    ? `https://www.linkedin.com/in/${person.linkedinSlug}/recent-activity/all/`
    : undefined;
  const preview: WarmUpPreview = {
    id: newId('wup'),
    personId: person.id,
    post: picked ? { excerpt: postExcerpt(picked.text), ...(url ? { url } : {}) } : null,
    comment: comment || null,
    steps: sched.steps,
    timezone: user.timezone,
  };
  demoPreviews.set(preview.id, { preview, topic: picked?.topic, url });
  return { ok: true, preview, mode: 'demo' };
}

// ---- preview, start, stop ---------------------------------------------------------------------------------------------

/**
 * The plan for one person before anything runs: the post Orbit picked, the comment it drafted, the days. In account
 * mode the server reads the person's posts once for this; nothing is scheduled until Start.
 */
export async function previewAutoWarmUp(
  user: User,
  personId: string,
  now = new Date(),
): Promise<PreviewOutcome> {
  const mode = await autoWarmUpMode(user);
  const person = await db.people.get(personId);
  if (!person) return refused('no_profile');
  if (!mode) return refused((await db.settings.get(user.id))?.warmUpAuto === false ? 'off' : 'not_connected');
  if (person.doNotContact || person.hiddenAt) return refused('blocked');
  if (!person.linkedinSlug && !person.linkedinMemberId) return refused('no_profile');
  if (await alreadyInTouch(person.id))
    return {
      ok: false,
      reason: 'blocked',
      message: `You are already in touch with ${person.firstName}, so there is nothing to warm up.`,
    };
  if (mode === 'demo') return demoPreview(user, person, now);
  const settings = await db.settings.get(user.id);
  const days = settings?.warmUpDays;
  // someone added a moment ago goes up first, so the server knows who the plan is for
  await pushOutbox().catch(() => undefined);
  const r = await callApi('/warmups/preview', {
    personId: serverIdOf(person.id) ?? person.id,
    ...(typeof days === 'number' && days >= 2 && days <= 10 ? { warmUpDays: Math.round(days) } : {}),
  });
  if (!r.ok)
    return {
      ok: false,
      reason: 'error',
      // someone added a moment ago has not reached the server yet
      message:
        r.status === 404
          ? `Orbit is still saving ${person.firstName}. Try again in a moment.`
          : r.message || 'Orbit could not make the plan. Try again in a moment.',
    };
  if (!r.value.ok) {
    if (r.value.reason === 'running' && r.value.run) await keepRun(user.id, person.id, r.value.run);
    return refused(r.value.reason);
  }
  return { ok: true, preview: { ...r.value.preview, personId: person.id }, mode };
}

/** A chat with this person that is past the warm-up: written to, answered, booked. */
async function alreadyInTouch(personId: string): Promise<boolean> {
  const chats = await db.chats.where('personId').equals(personId).toArray();
  return chats.some(
    (c) =>
      !c.archivedAt && !['identified', 'warming', 'declined', 'no_response', 'archived'].includes(c.stage),
  );
}

/** A run from the server, kept here under the local person's id and copied onto the chat. */
async function keepRun(userId: string, personId: string, run: WarmUpRun): Promise<WarmUpRun> {
  const mine = { ...run, userId, personId };
  await db.warmups.put(mine);
  return mine;
}

export type StartOutcome =
  | { ok: true; run: WarmUpRun; chat: CoffeeChat }
  | { ok: false; reason: WarmUpRefusal | 'error'; message: string };

/**
 * Start. `comment` is the text in the sheet when the student pressed Start (their edits included), or null when they
 * left the comment out. It is sent as it is and is the only text Orbit ever posts for this warm-up.
 */
export async function startAutoWarmUp(
  user: User,
  preview: WarmUpPreview,
  comment: string | null,
  source: CoffeeChat['source'] = 'manual',
  now = new Date(),
): Promise<StartOutcome> {
  const person = await db.people.get(preview.personId);
  if (!person) return refused('no_profile');
  const mode = await autoWarmUpMode(user);
  if (!mode) return refused((await db.settings.get(user.id))?.warmUpAuto === false ? 'off' : 'not_connected');
  let run: WarmUpRun;
  if (mode === 'demo') {
    const kept = demoPreviews.get(preview.id);
    const settings = await db.settings.get(user.id);
    const hasPost = !!preview.post;
    const sched = autoWarmUpSchedule({
      now,
      warmUpDays: settings?.warmUpDays,
      tz: user.timezone,
      hasPost,
      withComment: hasPost && comment !== null,
    });
    run = {
      id: newId('wu'),
      userId: user.id,
      personId: person.id,
      status: 'running',
      ...(preview.post
        ? {
            post: {
              excerpt: preview.post.excerpt,
              ...(kept?.url ? { url: kept.url } : {}),
              ...(kept?.topic ? { topic: kept.topic } : {}),
            },
          }
        : {}),
      comment: hasPost ? comment : null,
      steps: sched.steps.map((s) => ({
        id: newId('wus'),
        seq: s.seq,
        kind: s.kind,
        dueAt: s.dueAt,
        status: 'pending',
        attempts: 0,
      })),
      startedAt: now.toISOString(),
      readyAt: sched.readyAt,
      updatedAt: now.toISOString(),
    };
    await db.warmups.put(run);
    demoPreviews.delete(preview.id);
  } else {
    const r = await callApi('/warmups/start', { warmupId: preview.id, comment });
    if (!r.ok)
      return {
        ok: false,
        reason: 'error',
        message: r.message || 'Orbit could not start the warm-up. Try again.',
      };
    if (!r.value.ok) {
      if (r.value.reason === 'running' && r.value.run) await keepRun(user.id, person.id, r.value.run);
      return refused(r.value.reason);
    }
    run = await keepRun(user.id, person.id, r.value.run);
  }
  // the chat goes to Warming up with Orbit's plan on it (a manual warm-up already under way is handed over)
  const started = await startWarmUpOrOutreach(user, person.id, 'linkedin', source, {
    plan: planFromRun(run, person.linkedinSlug ?? ''),
  });
  const chat = started.chat ?? (await db.chats.where('personId').equals(person.id).first());
  if (!chat) return { ok: false, reason: 'error', message: 'Orbit could not open the warm-up. Try again.' };
  await applyWarmUpRuns(user.id, [run], now);
  return { ok: true, run, chat: (await db.chats.get(chat.id)) ?? chat };
}

/** The run Orbit has under way (or last had) for a chat's warm-up. */
export async function runOfChat(chat: Pick<CoffeeChat, 'warmUp'>): Promise<WarmUpRun | undefined> {
  const id = chat.warmUp?.auto?.runId;
  return id ? db.warmups.get(id) : undefined;
}

/**
 * Stop a warm-up, at any time. One Orbit runs is stopped on the server first (nothing more is done on LinkedIn from
 * that moment); then the chat leaves the warm-up and goes back to "to contact", with what already ran kept on it. A
 * manual warm-up is simply dropped.
 */
export async function stopWarmUp(
  user: Pick<User, 'id'>,
  chatId: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const chat = await db.chats.get(chatId);
  if (!chat?.warmUp) return { ok: true };
  const auto = chat.warmUp.auto;
  if (auto?.status === 'running') {
    const run = await db.warmups.get(auto.runId);
    let stopped: WarmUpRun | undefined;
    // every run but the sample student's lives on the server: it is stopped there or it is not stopped (a browser
    // that is signed out of Orbit says so, and never pretends)
    if (!usesMockConnectors(user.id)) {
      const r = await callApi('/warmups/stop', { warmupId: serverIdOf(auto.runId) ?? auto.runId });
      if (!r.ok)
        return {
          ok: false,
          message:
            r.reason === 'signed_out' || r.reason === 'off'
              ? 'Sign in to Orbit to stop this warm-up. It is still running.'
              : 'Orbit could not stop the warm-up. Check your connection and try again.',
        };
      stopped = r.value.run;
    }
    const base = stopped ?? run;
    if (base) {
      const at = now.toISOString();
      const mine: WarmUpRun = {
        ...base,
        id: auto.runId,
        userId: user.id,
        personId: chat.personId,
        status: base.status === 'running' ? 'stopped' : base.status,
        stopReason: base.status === 'running' ? 'cancelled' : base.stopReason,
        finishedAt: base.finishedAt ?? at,
        steps: base.steps.map((s) =>
          s.status === 'pending' || s.status === 'running' ? { ...s, status: 'skipped', note: 'stopped' } : s,
        ),
      };
      await db.warmups.put(mine);
      // a run that finished or stopped for another reason while the tap was on its way is shown as it is
      const changed = await applyWarmUpRuns(user.id, [mine], now);
      if (mine.stopReason === 'cancelled' && changed.length) {
        await evaluateImmediateSuggestions(user.id, { chatId, personId: chat.personId }, now).catch(
          () => undefined,
        );
        return { ok: true };
      }
    }
  }
  const fresh = await db.chats.get(chatId);
  if (fresh?.stage === 'warming') {
    const cards = await db.suggestions
      .where('chatId')
      .equals(chatId)
      .filter((s) => s.kind === 'warm_up_engage')
      .toArray();
    await retireSuggestions(cards, 'warmup:stopped', now);
    await moveChat(user, fresh, 'identified', 'warmup:stopped');
  }
  return { ok: true };
}

// ---- done: told once --------------------------------------------------------------------------------------------------

/** The warm-ups that finished and the student has not been told about yet. */
export async function warmUpsToTell(userId: string): Promise<WarmUpRun[]> {
  const runs = await db.warmups.where('userId').equals(userId).toArray();
  return runs.filter((r) => r.status === 'done' && !r.toldAt);
}

/**
 * Mark a finished warm-up as told (here at once, and on the server so no other device says it again), make its
 * "ready to message" card now, and leave a line in the notifications. Returns the words for the toast.
 */
export async function tellWarmUpDone(
  user: Pick<User, 'id'>,
  run: WarmUpRun,
  now = new Date(),
): Promise<{ text: string; personId: string } | undefined> {
  const kept = await db.warmups.get(run.id);
  if (!kept || kept.toldAt) return undefined;
  await db.warmups.update(run.id, { toldAt: now.toISOString() });
  if (isServerUser(user.id) && !usesMockConnectors(user.id))
    void callApi('/warmups/told', { warmupId: serverIdOf(run.id) ?? run.id }).catch(() => undefined);
  const person = await db.people.get(run.personId);
  const first = person?.firstName || 'them';
  const ran = run.steps.filter((s) => s.status === 'done').length;
  await applyWarmUpRuns(user.id, [{ ...kept, toldAt: now.toISOString() }], now);
  const chat = await db.chats
    .where('personId')
    .equals(run.personId)
    .filter((c) => c.warmUp?.auto?.runId === run.id)
    .first();
  if (chat)
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: run.personId }, now).catch(
      () => undefined,
    );
  const title =
    ran > 0 ? `Orbit finished the warm-up for ${first}.` : `Orbit could not run the warm-up for ${first}.`;
  const body = ran > 0 ? 'Your first message is ready to write.' : 'You can still write to them without it.';
  await notify(user.id, 'system', title, body, `/people/${run.personId}`);
  return { text: `${title} ${body}`, personId: run.personId };
}

// ---- the demo's simulated run -----------------------------------------------------------------------------------------

/**
 * The demo only: let the simulated runs catch up to `now`. Each step whose time has come is marked done at that time,
 * inside the same daily caps the server holds (a step over a cap waits); a run stops when its chat left the warm-up or
 * the person was hidden; a run with no step left is done. Returns how many runs changed.
 */
export async function tickDemoWarmUps(
  user: Pick<User, 'id' | 'timezone'>,
  now = new Date(),
  opts: { /** a step the demo was asked to run now, whatever the caps say */ force?: string } = {},
): Promise<number> {
  if (!usesMockConnectors(user.id)) return 0;
  const all = await db.warmups.where('userId').equals(user.id).toArray();
  const running = all.filter((r) => r.status === 'running');
  if (!running.length) return 0;
  const settings = await db.settings.get(user.id);
  const connected = await demoLinkedInConnected(user.id);
  const today = wallKey(now, user.timezone);
  const log: AutoActionLog[] = [];
  for (const r of all)
    for (const s of r.steps)
      if (s.status === 'done' && s.ranAt && wallKey(new Date(s.ranAt), user.timezone) === today)
        log.push({ kind: s.kind, at: s.ranAt, personId: r.personId, stepId: s.id });
  let changed = 0;
  for (const run of running) {
    const person = await db.people.get(run.personId);
    const chat = await db.chats
      .where('personId')
      .equals(run.personId)
      .filter((c) => c.warmUp?.auto?.runId === run.id)
      .first();
    const stop = (reason: string): WarmUpRun => ({
      ...run,
      status: 'stopped',
      stopReason: reason,
      finishedAt: now.toISOString(),
      steps: run.steps.map((s) =>
        s.status === 'pending' ? { ...s, status: 'skipped', note: 'stopped' } : s,
      ),
    });
    let next: WarmUpRun | undefined;
    if (settings?.warmUpAuto === false) next = stop('setting_off');
    else if (!connected) next = stop('linkedin_disconnected');
    else if (!person || person.hiddenAt) next = stop('hidden');
    else if (person.doNotContact) next = stop('do_not_contact');
    else if (chat && chat.stage !== 'warming')
      next = stop(['outreach_sent', 'no_response', 'declined'].includes(chat.stage) ? 'messaged' : 'replied');
    else {
      const steps = run.steps.map((s) => ({ ...s }));
      let moved = false;
      for (const s of steps.sort((a, b) => a.seq - b.seq)) {
        if (s.status !== 'pending' || Date.parse(s.dueAt) > now.getTime()) continue;
        // a step whose day is today runs inside today's caps; one from an earlier day ran on its day
        const due = new Date(s.dueAt);
        if (wallKey(due, user.timezone) === today && s.id !== opts.force) {
          const v = warmUpCapVerdict({
            kind: s.kind,
            personId: run.personId,
            stepId: s.id,
            now: due,
            today: log,
          });
          if (!v.allowed) continue;
          log.push({ kind: s.kind, at: s.dueAt, personId: run.personId, stepId: s.id });
        }
        s.status = 'done';
        s.attempts = 1;
        s.ranAt = s.dueAt;
        moved = true;
      }
      if (moved) {
        const over = steps.every((s) => s.status !== 'pending');
        const last = steps.reduce((t, s) => (s.ranAt && s.ranAt > t ? s.ranAt : t), run.startedAt);
        next = { ...run, steps, ...(over ? { status: 'done' as const, finishedAt: last } : {}) };
      }
    }
    if (!next) continue;
    next.updatedAt = now.toISOString();
    await db.warmups.put(next);
    await applyWarmUpRuns(user.id, [next], now);
    changed++;
  }
  return changed;
}

/** The demo only: bring the next step of a simulated run to now, so the whole sequence can be watched in a minute. */
export async function demoRunNextStep(user: Pick<User, 'id' | 'timezone'>, runId: string, now = new Date()) {
  if (!usesMockConnectors(user.id)) return;
  const run = await db.warmups.get(runId);
  if (run?.status !== 'running') return;
  const next = run.steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .find((s) => s.status === 'pending');
  if (!next) return;
  await db.warmups.put({
    ...run,
    steps: run.steps.map((s) => (s.id === next.id ? { ...s, dueAt: now.toISOString() } : s)),
  });
  await tickDemoWarmUps(user, now, { force: next.id });
}
