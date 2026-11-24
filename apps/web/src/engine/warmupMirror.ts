/**
 * The automated warm-up as this browser shows it. Orbit's server keeps each run (orbit.warmups, pulled into the
 * `warmups` table; the demo keeps its simulated runs there too). Everything else in the app reads a chat's own
 * warm-up plan: the pipeline's progress bar, the "ready to message" card, the first message that names the post. So
 * each run is mirrored onto its chat's plan here (core's `planFromRun`), and the rest of the app needs no second way
 * of looking at a warm-up.
 *
 * Nothing in this file reaches the server or LinkedIn: it only copies what a run says into the chat.
 */
import { type CoffeeChat, newId, planFromRun, type WarmUpRun } from '@orbit/core';
import { addTouchpoint } from '../db/repo';
import { db } from '../db/schema';
import { retireSuggestions } from './stages';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The manual step cards of a chat ("React to one recent post") that no longer ask anything of the student. */
async function retireStepCards(chatId: string, reason: string, now: Date): Promise<void> {
  const cards = await db.suggestions
    .where('chatId')
    .equals(chatId)
    .filter((s) => s.kind === 'warm_up_engage')
    .toArray();
  await retireSuggestions(cards, reason, now);
}

/** The chat a run belongs to: the one already mirroring it, else the person's warm-up under way. */
function chatFor(chats: CoffeeChat[], run: WarmUpRun): CoffeeChat | undefined {
  return (
    chats.find((c) => c.warmUp?.auto?.runId === run.id) ??
    chats.find((c) => c.stage === 'warming' && !c.archivedAt && !c.warmUp?.auto) ??
    chats.find((c) => c.stage === 'warming' && !c.archivedAt)
  );
}

/**
 * Copy runs onto their chats. Returns the chats that changed. A step Orbit ran becomes a done action (and a touch on
 * the person's timeline, once); a run that finished makes the plan ready; a run that stopped hands the steps left back
 * to the student; a run the student stopped on another device takes the chat out of the warm-up here too.
 */
export async function applyWarmUpRuns(
  userId: string,
  runs: WarmUpRun[],
  now = new Date(),
): Promise<string[]> {
  const changed: string[] = [];
  for (const run of runs) {
    if (run.userId !== userId || !Array.isArray(run.steps)) continue;
    const chats = await db.chats
      .where('personId')
      .equals(run.personId)
      .filter((c) => c.userId === userId)
      .toArray();
    // the chat already showing this run wins, wherever it is now: a person merged into another keeps their chat, and
    // the run (which the server still files under the person it started with) follows it
    const chat =
      chatFor(chats, run) ??
      (await db.chats
        .where('userId')
        .equals(userId)
        .filter((c) => c.warmUp?.auto?.runId === run.id)
        .first());
    if (!chat) continue;
    if (chat.personId !== run.personId) {
      await db.warmups.update(run.id, { personId: chat.personId });
      run.personId = chat.personId;
    }
    const person = await db.people.get(chat.personId);
    // a newer run on the same chat is the one it shows
    const shown = chat.warmUp?.auto;
    if (shown && shown.runId !== run.id && chat.warmUp!.startedAt > run.startedAt) continue;
    const plan = planFromRun(run, person?.linkedinSlug ?? '');
    const at = now.toISOString();
    const cancelled = run.status === 'stopped' && run.stopReason === 'cancelled';
    if (cancelled) {
      // stopped by the student (here, or on another device): the chat leaves the warm-up, with what ran kept on it
      if (chat.stage !== 'warming' || (shown && shown.runId !== run.id)) continue;
      await db.chats.update(chat.id, {
        stage: 'identified',
        stageEnteredAt: at,
        warmUp: plan,
        updatedAt: at,
      });
      await db.stageEvents.add({
        id: newId('se'),
        userId,
        chatId: chat.id,
        fromStage: 'warming',
        toStage: 'identified',
        status: 'applied',
        actor: 'user',
        reason: 'warmup:stopped',
        createdAt: at,
        decidedAt: at,
      });
      await retireStepCards(chat.id, 'warmup:stopped', now);
      changed.push(chat.id);
      continue;
    }
    if (same(chat.warmUp, plan)) continue;
    await db.chats.update(chat.id, { warmUp: plan, updatedAt: at });
    // while Orbit runs it there is no step for the student: a card left from the manual plan goes
    if (run.status !== 'stopped') await retireStepCards(chat.id, 'warmup:orbit_runs_it', now);
    for (const a of plan.actions) {
      if (!a.doneAt) continue;
      await addTouchpoint({
        userId,
        personId: chat.personId,
        kind: 'linkedin_engaged',
        occurredAt: a.doneAt,
        refTable: 'warmup',
        refId: `${chat.id}:${a.id}`,
        summary:
          a.kind === 'view_profile'
            ? 'Orbit viewed their LinkedIn profile for you'
            : a.kind === 'react_post'
              ? 'Orbit liked their post for you'
              : 'Orbit left your comment on their post',
        weight: 0.15,
      });
    }
    changed.push(chat.id);
  }
  return changed;
}

/** Every run kept for this student, copied onto its chat (after a pull, and when the app opens). */
export async function mirrorWarmUpRuns(userId: string, now = new Date()): Promise<string[]> {
  const runs = await db.warmups.where('userId').equals(userId).toArray();
  // oldest first, so the newest run of a person is the one left on the chat
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return applyWarmUpRuns(userId, runs, now);
}
