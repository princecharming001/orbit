/**
 * The plan step in this browser (plan 29 §B4, §B6, §C1 phase 5): local mode's copy of the server's, run from the
 * reply check while a tab is open, with the honest line that Orbit sends while it is open and that signing in makes
 * it always-on. The same core rules decide who is written to first (`planFirstTouchDay`); the drafts are this
 * browser's own (`draftMessage`, the playbook's rules 13 and 14 included in the model's prompt), checked for a
 * researched hook and the student's voice, and queued in the outbox for the recipient's next morning window with
 * the evening review in front of them. Gmail only: LinkedIn never sends on its own.
 *
 * When the time comes (`sendDueQueued` in engine/send.ts) an autopilot first message goes on silence only once the
 * first-message rung is earned, after the same conditions are looked at again (`localFirstTouchGate`) and the voice
 * judge has read it; before the rung only a tap sends it.
 */
import type { Goal, OutboundMessage, User } from '@orbit/core';
import {
  AUTOPILOT_MODE_LEVEL,
  addDaysKey,
  earliestPlannedSend,
  type FirstTouchCandidate,
  type FirstTouchSkip,
  firmKey,
  firstTouchBlock,
  firstTouchRung,
  isFirstTouchKind,
  nextSendWindow,
  planFirstTouchDay,
  reviewWindow,
  SEND_CAPS,
  sendDayAllowed,
  todayKey,
  weekKeys,
  weekPace,
} from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import { LOCAL_AUTOPILOT_NOTE } from './autopilotMode';
import { approvalStreaks, personZone } from './trust';

const DAY = 86_400_000;
/** The week's target when the student never set one (the Limits page's default). */
const DEFAULT_WEEKLY_TARGET = 4;
/** The hour, the student's time, tonight's batch card is raised. */
export const BATCH_CARD_HOUR = 18;
/** db.kv key: who the last plan left out and why, for the status and the chat. */
export const LOCAL_SKIPS_KV = 'autopilot:skipped:';

export interface LocalPlanSummary {
  reason?: 'account' | 'off' | 'paused' | 'no_autopilot_goal' | 'no_gmail';
  goals: number;
  queued: number;
  held: number;
  skipped: number;
  batchCard: boolean;
  /** the honest line: local mode sends only while a tab is open */
  note: string;
}

/** The goals that run on autopilot here: the goal's own level 2, or the student's mode when the goal has none. */
async function autopilotGoals(user: Pick<User, 'id'>, now: Date): Promise<Goal[]> {
  const settings = await db.settings.get(user.id);
  const level = AUTOPILOT_MODE_LEVEL[settings?.autopilotMode ?? 'off'];
  const paused = settings?.autopilotPausedGoals ?? {};
  return (await db.userGoals.where('userId').equals(user.id).toArray())
    .filter((g) => !g.deletedAt && g.status === 'active')
    .filter((g) => (g.autonomyLevel ?? level) === 2 && g.targets.organizations.length > 0)
    .filter((g) => {
      const p = paused[g.id];
      return !p || (p.until !== null && Date.parse(p.until) <= now.getTime());
    })
    .sort((a, b) => a.priority - b.priority);
}

/** Every person the first-message conditions read, from this browser's tables, keyed by person id. */
async function localCandidates(
  userId: string,
  exceptDraft?: string,
): Promise<Map<string, FirstTouchCandidate>> {
  const [people, outbound, chats, facts, messages] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.outbound.where('userId').equals(userId).toArray(),
    db.chats.where('userId').equals(userId).toArray(),
    db.facts.where('userId').equals(userId).toArray(),
    db.messages.where('userId').equals(userId).toArray(),
  ]);
  const written = new Set(outbound.filter((o) => o.status === 'sent').map((o) => o.personId));
  // mail the student sent from Gmail themselves, by address
  const wroteTo = new Set(
    messages.filter((m) => m.direction === 'outbound').flatMap((m) => m.toEmails.map((e) => e.toLowerCase())),
  );
  const pending = new Set(
    outbound
      .filter(
        (o) =>
          o.id !== exceptDraft &&
          isFirstTouchKind(o.kind) &&
          ['draft', 'approved', 'queued', 'sending'].includes(o.status),
      )
      .map((o) => o.personId),
  );
  const open = new Set(
    chats
      .filter(
        (c) => !c.archivedAt && !['identified', 'declined', 'no_response', 'archived'].includes(c.stage),
      )
      .map((c) => c.personId),
  );
  const hooks = new Set(facts.filter((f) => !f.deletedAt).map((f) => f.personId));
  const out = new Map<string, FirstTouchCandidate>();
  for (const p of people) {
    out.set(p.id, {
      personId: p.id,
      name: p.displayName,
      company: p.currentOrganizationRaw ?? null,
      title: p.currentTitle ?? null,
      headline: p.headline ?? null,
      isAlumni: !!p.isAlumni,
      score: p.tieScore ?? Math.round((p.strength ?? 0) * 100),
      hasHook: hooks.has(p.id),
      hasEmail: !!p.primaryEmail,
      hidden: !!p.hiddenAt,
      private: !!p.private,
      doNotContact: !!p.doNotContact,
      openChat: open.has(p.id),
      written:
        written.has(p.id) ||
        [p.primaryEmail, ...(p.emails ?? [])].some((e) => !!e && wroteTo.has(e.toLowerCase())),
      pending: pending.has(p.id),
    });
  }
  return out;
}

/** The send days (Tuesday to Thursday, no holidays) from `key` to the end of its week, `key` included. */
function sendDaysLeft(key: string): number {
  return weekKeys(new Date(`${key}T12:00:00Z`), 'UTC').filter((k) => k >= key && sendDayAllowed(k, 'gmail'))
    .length;
}

/**
 * The plan step for local mode: tomorrow morning's first messages for the goals on autopilot, queued in this
 * browser's outbox with the evening review, and tonight's batch card. Nothing for an account (the server plans).
 */
export async function runLocalAutopilotPlan(user: User, now = new Date()): Promise<LocalPlanSummary> {
  const out: LocalPlanSummary = {
    goals: 0,
    queued: 0,
    held: 0,
    skipped: 0,
    batchCard: false,
    note: LOCAL_AUTOPILOT_NOTE,
  };
  if (isServerUser(user.id)) return { ...out, reason: 'account' };
  const settings = await db.settings.get(user.id);
  if (settings?.autopilotPausedUntil && now.getTime() < Date.parse(settings.autopilotPausedUntil))
    return { ...out, reason: 'paused' };
  const goals = await autopilotGoals(user, now);
  out.goals = goals.length;
  if (!goals.length) {
    out.batchCard = await raiseLocalBatchCard(user, now);
    return { ...out, reason: 'no_autopilot_goal' };
  }
  const { googleSendActive } = await import('./send');
  if (!usesMockConnectors(user.id) && !(await googleSendActive(user.id)))
    return { ...out, reason: 'no_gmail' };

  const tz = user.timezone || 'America/New_York';
  const earliest = earliestPlannedSend(now);
  const planDay = todayKey(new Date(nextSendWindow(earliest, tz, 'gmail', () => 0).notBefore), tz);
  const outbound = await db.outbound.where('userId').equals(user.id).toArray();
  const people = await localCandidates(user.id);
  const autoFirst = outbound.filter(
    (o) =>
      o.autoRung === 'first_touch' &&
      ['queued', 'sending', 'sent'].includes(o.status) &&
      !!(o.sendAt ?? o.sentAt),
  );
  const dayOf = (o: OutboundMessage) => todayKey(new Date(o.sentAt ?? o.sendAt!), tz);
  const rollStart = addDaysKey(planDay, -6);
  const onDayRows = autoFirst.filter((o) => dayOf(o) === planDay);
  let onDay = onDayRows.length;
  let thisWeek = autoFirst.filter((o) => dayOf(o) >= rollStart && dayOf(o) <= planDay).length;
  const firmsOnDay = onDayRows
    .map((o) => ({
      firm: firmKey(people.get(o.personId)?.company),
      name: people.get(o.personId)?.name ?? 'Someone',
    }))
    .filter((f) => f.firm);
  // the week's pace: every first message the week holds, by hand or Orbit's own
  const week = new Set(weekKeys(new Date(`${planDay}T12:00:00Z`), 'UTC'));
  const inWeek = outbound.filter(
    (o) =>
      isFirstTouchKind(o.kind) &&
      ['queued', 'sending', 'sent'].includes(o.status) &&
      !!(o.sentAt ?? o.sendAt) &&
      week.has(dayOf(o)),
  );
  const pace = weekPace({
    target: settings?.weeklyOutreachTarget ?? DEFAULT_WEEKLY_TARGET,
    sentThisWeek: inWeek.length,
    sentToday: inWeek.filter((o) => dayOf(o) === planDay).length,
    now: new Date(`${planDay}T17:00:00Z`),
    tz,
    dailyCap: SEND_CAPS.autoFirstTouchesPerDay,
  });
  let remaining = pace.remaining;
  const daysLeft = sendDaysLeft(planDay);
  const skipped: FirstTouchSkip[] = [];
  const { draftMessage } = await import('./brief');
  const { approveAndSend } = await import('./send');
  for (const goal of goals) {
    const firms = new Set(goal.targets.organizations.map(firmKey).filter(Boolean));
    const candidates = [...people.values()].filter((c) => firms.has(firmKey(c.company)));
    const day = planFirstTouchDay({
      candidates,
      goal: { kind: goal.kind, targets: goal.targets.organizations },
      remaining,
      daysLeft,
      onDay,
      thisWeek,
      firmsOnDay,
    });
    skipped.push(...day.skipped);
    for (const pick of day.picks) {
      // a friend's contact is an account feature: local mode has no friends to ask
      if (pick.route !== 'direct') continue;
      const c = pick.candidate;
      let msg: OutboundMessage;
      try {
        msg = await draftMessage(user, c.personId, 'outreach', 'gmail', null);
      } catch {
        continue;
      }
      await db.outbound.update(msg.id, { goalId: goal.id });
      const reason = await heldBack(user, msg);
      if (reason) {
        await db.outbound.update(msg.id, { autoRung: 'first_touch', error: reason });
        out.held++;
        continue;
      }
      const person = await db.people.get(c.personId);
      const zone = (person && personZone(person)) || tz;
      const w = reviewWindow(nextSendWindow(earliest, zone, 'gmail').notBefore);
      const r = await approveAndSend(user, msg.id, msg.bodyDraft, msg.subject, now, {
        scheduleAt: new Date(w.sendAt),
      });
      if (!r.ok) {
        await db.outbound.update(msg.id, { autoRung: 'first_touch', error: r.error });
        out.held++;
        continue;
      }
      // Orbit approved it itself: it never counts toward a rung, and before the rung it waits for a tap
      await db.outbound.update(msg.id, {
        autoSent: true,
        autoRung: 'first_touch',
        reviewUntil: w.reviewUntil,
      });
      people.set(c.personId, { ...c, pending: true });
      out.queued++;
      onDay++;
      thisWeek++;
      remaining--;
      firmsOnDay.push({ firm: firmKey(c.company), name: c.name });
    }
  }
  out.skipped = skipped.length;
  await db.kv.put({
    key: `${LOCAL_SKIPS_KV}${user.id}`,
    value: {
      at: now.toISOString(),
      skipped: skipped.slice(0, 40).map((x) => ({
        personId: x.personId,
        personName: x.name,
        company: x.company,
        rule: x.rule,
        reason: x.reason,
        at: now.toISOString(),
      })),
    },
  });
  out.batchCard = await raiseLocalBatchCard(user, now);
  return out;
}

/**
 * What keeps a fresh draft out of the batch: no researched hook it opens with, a line only the student can fill in,
 * or the voice check (the voice phase's, no model). The judge reads it once more right before it goes on silence.
 */
async function heldBack(user: User, msg: OutboundMessage): Promise<string | undefined> {
  if (msg.needsInput?.length) return 'It needs one answer from you.';
  // a hook with a source: a claim about them that cites one of their facts, never a generic opener
  const hooked = (msg.claims ?? []).some((c) => !!c.factId);
  if (!hooked) return 'Orbit found nothing researched about them to open with, so it waits for you.';
  const { checkBeforeAutoSend } = await import('./voice');
  const v = await checkBeforeAutoSend(user, msg);
  return v.ok ? undefined : "It didn't sound like you, so it waits for your tap.";
}

/**
 * The send job's second look in this browser (the server's `firstTouchSendGate`): the rung earned, every condition
 * about the person still true, nobody else at the firm written to first today, and (unless `judge: false`) the voice
 * judge saying the student wrote it. `ok: false` carries the reason the student reads.
 */
export async function localFirstTouchGate(
  user: User,
  msg: OutboundMessage,
  now = new Date(),
  opts: { judge?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string; later?: boolean; until?: string }> {
  const streaks = await approvalStreaks(user.id, now);
  const rung = firstTouchRung(
    Array.from({ length: streaks.first_touch.unedited }, () => ({ kind: 'first_touch', edited: false })),
  );
  if (!rung.earned)
    return {
      ok: false,
      reason:
        'It waited for your tap. Until twenty first messages go out as Orbit wrote them, each one in the evening batch needs one.',
    };
  const c = (await localCandidates(user.id, msg.id)).get(msg.personId);
  const goal = msg.goalId ? await db.userGoals.get(msg.goalId) : undefined;
  if (!c) return { ok: false, reason: 'Orbit no longer has that person.' };
  const rule = firstTouchBlock(c, {
    kind: goal?.kind ?? 'recruiting',
    targets: goal?.targets.organizations ?? [],
  });
  if (rule) {
    const { skipReason } = await import('@orbit/core');
    return { ok: false, reason: skipReason(rule, c) };
  }
  const tz = user.timezone || 'America/New_York';
  const today = todayKey(now, tz);
  const firm = firmKey(c.company);
  const sentToday = (await db.outbound.where('userId').equals(user.id).toArray()).filter(
    (o) =>
      o.id !== msg.id &&
      o.autoRung === 'first_touch' &&
      o.status === 'sent' &&
      !!o.sentAt &&
      todayKey(new Date(o.sentAt), tz) === today,
  );
  for (const o of sentToday) {
    const p = await db.people.get(o.personId);
    if (firm && firmKey(p?.currentOrganizationRaw) === firm)
      return {
        ok: false,
        later: true,
        until: nextSendWindow(
          new Date(now.getTime() + DAY),
          personZone((await db.people.get(msg.personId)) ?? {}) || tz,
          'gmail',
        ).notBefore,
        reason: `${p?.displayName ?? 'Someone'} at ${c.company} got a first message this morning, so this one moves to the next morning.`,
      };
  }
  // the judge is a model call: the send job asks for it once, right before the message goes
  if (opts.judge === false) return { ok: true };
  const { judgeFirstMessage } = await import('./voice');
  const j = await judgeFirstMessage(user, msg);
  if (!j.ok) return { ok: false, reason: "It didn't sound like you, so it waits for your tap." };
  return { ok: true };
}

/**
 * Tonight's batch card in this browser (plan 29 §B1): at 18:00 the student's time, once a day, when Orbit's own first
 * messages are queued for the morning; before the rung it says each waits for a tap.
 */
export async function raiseLocalBatchCard(user: User, now = new Date()): Promise<boolean> {
  const tz = user.timezone || 'America/New_York';
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  if (hour < BATCH_CARD_HOUR) return false;
  const queued = (await db.outbound.where('userId').equals(user.id).toArray()).filter(
    (o) =>
      o.autoRung === 'first_touch' &&
      o.status === 'queued' &&
      !!o.sendAt &&
      Date.parse(o.sendAt) > now.getTime() &&
      Date.parse(o.sendAt) <= now.getTime() + 1.5 * DAY,
  );
  if (!queued.length) return false;
  const key = `batch_ready:${todayKey(now, tz)}`;
  if (await db.suggestions.where('dedupeKey').equals(key).first()) return false;
  const streaks = await approvalStreaks(user.id, now);
  const rung = firstTouchRung(
    Array.from({ length: streaks.first_touch.unedited }, () => ({ kind: 'first_touch', edited: false })),
  );
  const n = queued.length;
  const many = n === 1 ? 'first message' : 'first messages';
  const text = rung.earned
    ? `Tomorrow's batch is ready: ${n} ${many} go in the morning unless you hold ${n === 1 ? 'it' : 'one'}. ${LOCAL_AUTOPILOT_NOTE}`
    : `Tomorrow's batch is ready: ${n} ${many} wait for your tap tonight. Until ${rung.needed} go out as Orbit wrote them, only the ones you tap are sent.`;
  const { upsertSuggestions } = await import('./brief');
  await upsertSuggestions(
    user.id,
    [
      {
        kind: 'batch_ready',
        dedupeKey: key,
        reasonText: text,
        signals: { firstTouches: n, rungEarned: rung.earned },
        payload: { firstTouches: n, rungEarned: rung.earned },
        urgency: 0.7,
        goalRelevance: 0.6,
        confidence: 1,
        priorityScore: 0.8,
      },
    ],
    now,
  );
  return true;
}
