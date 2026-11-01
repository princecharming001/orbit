/**
 * Autopilot as the screens and the chat see it (plan 29 §B5): the status (what is queued for the morning, held, sent
 * today on Orbit's own, the replies that need the student, the pauses, the rungs, the caps), a hold, a pause, the
 * student's answer to a question a reply asked, and the mode. One call each through orbitApi for an account. In
 * local mode the same shapes are read from this browser's outbox, cards and settings, with the honest line: Orbit
 * sends while it is open; sign in for always-on.
 *
 * The status also writes the cards the funnel raised on the server (Needs you, the breaker) into this browser's
 * suggestions table, so Drafts, Today and the chat show them like any other card.
 */
import type {
  AutopilotItem,
  AutopilotMode,
  AutopilotStatus,
  AutopilotWeek,
  OutboundMessage,
  ServerDraft,
  Suggestion,
  User,
} from '@orbit/core';
import {
  AUTO_FIRST_TOUCH_RUNG,
  AUTO_KINDS,
  AUTOPILOT_MODE_LEVEL,
  firstTouchRung,
  isFirstTouchKind,
  newId,
  REVIEW_WINDOW_HOURS,
  SEND_CAPS,
} from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { keepServerDraft } from './serverSync';
import { approvalStreaks, OFFER_AT } from './trust';

/** What local mode can honestly promise. */
export const LOCAL_AUTOPILOT_NOTE = 'Sends while Orbit is open; sign in for always-on.';
/** First messages are the last rung (plan 29 §B2.2): core's number, which the server counts against too. */
export const FIRST_TOUCH_RUNG = AUTO_FIRST_TOUCH_RUNG;
/** db.kv key of the last status an account saw, for the brief when the tab was closed overnight. */
export const STATUS_KV = 'autopilot:status:';

type Fail = { ok: false; message: string };

export interface StatusResult {
  ok: true;
  status: AutopilotStatus;
  /** read from this browser, not a server */
  local: boolean;
  /** the honest line for local mode */
  note?: string;
}

function localItem(
  o: OutboundMessage,
  name: string,
  company: string | null,
  status: AutopilotItem['status'],
): AutopilotItem {
  return {
    draftId: o.id,
    personId: o.personId,
    personName: name,
    company,
    kind: o.kind,
    subject: o.subject ?? null,
    sendAt: o.sendAt ?? null,
    sentAt: o.sentAt ?? null,
    status,
    ...(o.autoRung ? { autoRung: o.autoRung as AutopilotItem['autoRung'] } : {}),
    ...(o.error && status === 'held' ? { reason: o.error } : {}),
  };
}

/** The status from this browser: the outbox, the cards and the settings row. */
export async function localAutopilotStatus(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<AutopilotStatus> {
  const [settings, outbound, streaks, cards] = await Promise.all([
    db.settings.get(user.id),
    db.outbound.where('userId').equals(user.id).toArray(),
    approvalStreaks(user.id, now),
    db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => (s.kind === 'needs_you' || s.kind === 'breaker') && s.status === 'pending')
      .toArray(),
  ]);
  const people = new Map(
    (await db.people.bulkGet([...new Set(outbound.map((o) => o.personId))]))
      .filter((p) => !!p)
      .map((p) => [p!.id, p!]),
  );
  const nameOf = (id: string) => people.get(id)?.displayName ?? 'them';
  const orgOf = (id: string) => people.get(id)?.currentOrganizationRaw ?? null;
  const dayKey = now.toDateString();
  const first = firstTouchRung(
    Array.from({ length: streaks.first_touch.unedited }, () => ({ kind: 'first_touch', edited: false })),
  );
  // an autopilot first message before the rung is earned waits for the student's tap (plan 29 §B2.2); a tapped one
  // is theirs (autoSent false) and goes like any approval
  const queued = outbound
    .filter(
      (o) => o.status === 'queued' && !!o.autopilot && !!o.sendAt && Date.parse(o.sendAt) > now.getTime(),
    )
    .sort((a, b) => a.sendAt!.localeCompare(b.sendAt!))
    .map((o) =>
      localItem(
        o,
        nameOf(o.personId),
        orgOf(o.personId),
        o.autoRung === 'first_touch' && o.autoSent && !first.earned ? 'needs_tap' : 'queued',
      ),
    );
  const held = outbound
    .filter((o) => o.status === 'draft' && !!o.error && (o.autoSent || o.autopilot || o.error === 'held'))
    .map((o) => localItem(o, nameOf(o.personId), orgOf(o.personId), 'held'));
  const sentToday = outbound
    .filter(
      (o) =>
        !!o.autoSent && o.status === 'sent' && !!o.sentAt && new Date(o.sentAt).toDateString() === dayKey,
    )
    .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))
    .map((o) => localItem(o, nameOf(o.personId), orgOf(o.personId), 'sent'));
  const needsYou: AutopilotItem[] = cards
    .filter((s) => s.kind === 'needs_you' && !s.payload.closed)
    .map((s) => ({
      draftId: (s.outboundMessageId as string | undefined) ?? s.id,
      personId: s.personId ?? null,
      personName:
        (s.payload.personName as string | undefined) ?? (s.personId ? nameOf(s.personId) : 'Someone'),
      company: s.personId ? orgOf(s.personId) : null,
      kind: 'reply',
      replyClass: 'question',
      subject: null,
      sendAt: null,
      sentAt: null,
      status: 'needs_you',
      question: (s.payload.question as string | undefined) ?? s.reasonText,
      messageId: s.payload.messageId as string | undefined,
    }));
  const auto = new Set(settings?.autoKinds ?? []);
  const rungs: AutopilotStatus['rungs'] = [
    ...AUTO_KINDS.map((kind) => ({
      kind,
      needed: OFFER_AT,
      unchanged: Math.min(OFFER_AT, streaks[kind].unedited),
      unlocked: auto.has(kind),
    })),
    {
      kind: 'first_touch' as const,
      needed: first.needed,
      unchanged: first.unchanged,
      unlocked: first.earned,
    },
  ];
  const pausedGoals = Object.entries(settings?.autopilotPausedGoals ?? {})
    .filter(([, p]) => p.until === null || Date.parse(p.until) > now.getTime())
    .map(([goalId, p]) => ({ goalId, title: '', until: p.until, reason: p.text }));
  for (const g of pausedGoals) g.title = (await db.userGoals.get(g.goalId))?.title ?? 'a goal';
  const pausedUntil =
    settings?.autopilotPausedUntil && Date.parse(settings.autopilotPausedUntil) > now.getTime()
      ? settings.autopilotPausedUntil
      : null;
  const weekAgo = now.getTime() - 7 * 86_400_000;
  return {
    mode: settings?.autopilotMode ?? 'off',
    pausedUntil,
    pausedGoals,
    queued,
    held,
    sentToday,
    needsYou,
    rungs,
    caps: {
      autoPerDay: SEND_CAPS.autoPerDay,
      firstTouchPerWeek: SEND_CAPS.autoFirstTouchesPerWeek,
      firstTouchPerDay: SEND_CAPS.autoFirstTouchesPerDay,
      usedToday: sentToday.length,
      firstTouchesThisWeek: outbound.filter(
        (o) => !!o.autoSent && isFirstTouchKind(o.kind) && !!o.sentAt && Date.parse(o.sentAt) >= weekAgo,
      ).length,
    },
    reviewUntil: queued.find((q) => q.sendAt)?.sendAt
      ? new Date(Date.parse(queued[0]!.sendAt!) - REVIEW_WINDOW_HOURS * 3_600_000).toISOString()
      : null,
    ...(await localPlanCards(user.id, now)),
  };
}

/**
 * The last seven days on autopilot in this browser (plan 29 §B1): what Orbit sent on its own, how many of those
 * people answered, the calls that followed, and the breaker's pauses with what they paused.
 */
export async function localWeek(userId: string, now = new Date()): Promise<AutopilotWeek> {
  const since = now.getTime() - 7 * 86_400_000;
  const within = (iso?: string) => !!iso && Date.parse(iso) >= since && Date.parse(iso) <= now.getTime();
  const [outbound, messages, chats, events, cards] = await Promise.all([
    db.outbound.where('userId').equals(userId).toArray(),
    db.messages.where('userId').equals(userId).toArray(),
    db.chats.where('userId').equals(userId).toArray(),
    db.stageEvents.where('userId').equals(userId).toArray(),
    db.suggestions.where('userId').equals(userId).toArray(),
  ]);
  const sent = outbound.filter((o) => o.autoSent && o.status === 'sent' && within(o.sentAt));
  const replies = sent.filter((o) =>
    messages.some(
      (m) =>
        m.direction === 'inbound' &&
        m.fromPersonId === o.personId &&
        Date.parse(m.sentAt) > Date.parse(o.sentAt!),
    ),
  ).length;
  const people = new Set(sent.map((o) => o.personId));
  const chatIds = new Set(chats.filter((c) => people.has(c.personId)).map((c) => c.id));
  const calls = events.filter(
    (e) =>
      e.status === 'applied' && e.toStage === 'scheduled' && chatIds.has(e.chatId) && within(e.createdAt),
  ).length;
  const trips = cards.filter((c) => c.kind === 'breaker' && within(c.createdAt));
  const paused = [
    ...new Set(
      trips
        .map((c) => (c.payload.company as string | undefined) ?? (c.payload.title as string | undefined))
        .filter((x): x is string => !!x),
    ),
  ];
  return { sent: sent.length, replies, calls, pushbacks: trips.length, paused };
}

/** Who this browser's last plan left out and why, and tonight's batch card when it is up (plan 29 §B4). */
async function localPlanCards(
  userId: string,
  now: Date,
): Promise<Pick<AutopilotStatus, 'skipped' | 'friendAsks' | 'batch' | 'week'>> {
  const { LOCAL_SKIPS_KV } = await import('./autopilotPlan');
  const kept = (await db.kv.get(`${LOCAL_SKIPS_KV}${userId}`))?.value as
    | { at: string; skipped: NonNullable<AutopilotStatus['skipped']> }
    | undefined;
  const fresh = kept && now.getTime() - Date.parse(kept.at) < 36 * 3_600_000;
  const card = (
    await db.suggestions
      .where('userId')
      .equals(userId)
      .filter((x) => x.kind === 'batch_ready' && x.status === 'pending')
      .toArray()
  )
    .filter((x) => now.getTime() - Date.parse(x.createdAt) < 18 * 3_600_000)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    skipped: fresh ? kept.skipped : [],
    friendAsks: [],
    week: await localWeek(userId, now),
    batch: card
      ? { at: card.createdAt, text: card.reasonText, firstTouches: Number(card.payload.firstTouches) || 0 }
      : null,
  };
}

/** The status: the server's for an account (and its cards written into this browser), this browser's otherwise. */
export async function autopilotStatus(
  user: Pick<User, 'id'>,
  now = new Date(),
): Promise<StatusResult | Fail> {
  if (!isServerUser(user.id)) {
    return {
      ok: true,
      status: await localAutopilotStatus(user, now),
      local: true,
      note: LOCAL_AUTOPILOT_NOTE,
    };
  }
  const r = await callApi('/autopilot/status', {});
  if (!r.ok) return { ok: false, message: r.message };
  await db.kv.put({ key: `${STATUS_KV}${user.id}`, value: { at: now.toISOString(), status: r.value } });
  await syncAutopilotCards(user.id, r.value, now).catch(() => undefined);
  return { ok: true, status: r.value, local: false };
}

/** The last status an account saw, from db.kv (the brief reads it before the server answers). */
export async function cachedStatus(userId: string): Promise<AutopilotStatus | undefined> {
  const row = await db.kv.get(`${STATUS_KV}${userId}`);
  const v = row?.value as { status?: AutopilotStatus } | undefined;
  return v?.status;
}

/**
 * The server's Needs you and breaker cards as this browser's suggestions (the fake api never pushes sync pages, and a
 * real account sees them before the next pull): one card per question, one per paused goal; a card the student
 * answered or dismissed stays answered.
 */
export async function syncAutopilotCards(
  userId: string,
  status: AutopilotStatus,
  now = new Date(),
): Promise<void> {
  const expires = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  const upsert = async (
    c: Omit<Suggestion, 'id' | 'userId' | 'status' | 'carriedOver' | 'expiresAt' | 'createdAt'>,
  ) => {
    const had = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
    if (had) {
      if (had.status === 'pending')
        await db.suggestions.update(had.id, { reasonText: c.reasonText, payload: c.payload });
      return;
    }
    await db.suggestions.add({
      id: newId('s'),
      userId,
      status: 'pending',
      carriedOver: 0,
      expiresAt: expires,
      createdAt: now.toISOString(),
      ...c,
    });
  };
  for (const q of status.needsYou) {
    const question = q.question ?? 'They asked you something.';
    await upsert({
      kind: 'needs_you',
      dedupeKey: `needs_you:${q.messageId ?? q.draftId}`,
      personId: q.personId ?? undefined,
      outboundMessageId: undefined,
      priorityScore: 0.85,
      reasonText: `${q.personName} asked: "${question}" What should I say?`,
      signals: { replyClass: 'question' },
      payload: {
        question,
        personName: q.personName,
        company: q.company,
        messageId: q.messageId,
        draftId: q.draftId,
        replyClass: 'question',
      },
    });
  }
  // a question answered since is done
  const open = new Set(status.needsYou.map((q) => `needs_you:${q.messageId ?? q.draftId}`));
  const mine = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter(
      (s) => s.kind === 'needs_you' && s.status === 'pending' && !s.payload.closed && !!s.payload.messageId,
    )
    .toArray();
  for (const s of mine)
    if (!open.has(s.dedupeKey) && s.signals.fromServer !== false)
      await db.suggestions.update(s.id, { status: 'done', decidedAt: now.toISOString() });
  for (const g of status.pausedGoals) {
    if (g.reason === 'You paused it') continue;
    await upsert({
      kind: 'breaker',
      dedupeKey: `breaker:${g.goalId}`,
      priorityScore: 0.9,
      reasonText: `${g.reason} Read it?`,
      signals: { goalId: g.goalId },
      payload: { goalId: g.goalId, title: g.title, reason: g.reason },
    });
  }
  // the plan step's cards (plan 29 §B4): tonight's batch, and each ask to a friend it drafted
  if (status.batch)
    await upsert({
      kind: 'batch_ready',
      dedupeKey: `batch_ready:${status.batch.at.slice(0, 10)}`,
      priorityScore: 0.8,
      reasonText: status.batch.text,
      signals: { firstTouches: status.batch.firstTouches, fromServer: true },
      payload: { firstTouches: status.batch.firstTouches },
    });
  for (const a of status.friendAsks ?? [])
    await upsert({
      kind: 'friend_ask_ready',
      dedupeKey: `friend_ask:${a.friendUserId}:${a.targetPersonId}`,
      priorityScore: 0.7,
      reasonText: `${a.friendName.split(' ')[0]} knows ${a.targetName}${a.company ? ` at ${a.company}` : ''}. Ask ${a.friendName.split(' ')[0]} for the intro?`,
      signals: { fromServer: true },
      payload: { ...a, cardId: a.id },
    });
}

/**
 * A tap on a first message in tomorrow's batch before the rung is earned (plan 29 §B2.2): it goes at its time as the
 * student's own approval. An account approves it on the server for the same time; here it simply becomes the
 * student's (not Orbit's own), which also counts it toward the rung once it is sent.
 */
export async function tapBatchItem(
  user: Pick<User, 'id'>,
  item: Pick<AutopilotItem, 'draftId' | 'sendAt'>,
): Promise<{ ok: true } | Fail> {
  if (isServerUser(user.id)) {
    const r = await callApi('/drafts/approve', {
      draftId: item.draftId,
      ...(item.sendAt ? { sendAt: item.sendAt } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  }
  const m = await db.outbound.get(item.draftId);
  if (!m || m.userId !== user.id || m.status !== 'queued')
    return { ok: false, message: 'It is no longer in the batch.' };
  await db.outbound.update(m.id, { autoSent: false });
  return { ok: true };
}

/**
 * The ask to a friend the plan drafted (plan 29 §A2.5): sent to the friend with its note on the student's tap, or set
 * aside. The friend forwards; nothing ever goes to the contact from the student.
 */
export async function answerPlanAsk(
  user: Pick<User, 'id'>,
  ask: Pick<
    NonNullable<AutopilotStatus['friendAsks']>[number],
    'id' | 'friendUserId' | 'targetPersonId' | 'note'
  >,
  send: boolean,
  now = new Date(),
): Promise<{ ok: true } | Fail> {
  if (!isServerUser(user.id)) return { ok: false, message: 'Asking a friend needs an Orbit account.' };
  const r = send
    ? await callApi('/friends/asks', {
        friendUserId: ask.friendUserId,
        targetPersonId: ask.targetPersonId,
        note: ask.note,
      })
    : await callApi('/autopilot/dismiss', { id: ask.id });
  if (!r.ok) return { ok: false, message: r.message };
  const card = await db.suggestions
    .where('dedupeKey')
    .equals(`friend_ask:${ask.friendUserId}:${ask.targetPersonId}`)
    .first();
  if (card)
    await db.suggestions.update(card.id, {
      status: send ? 'done' : 'dismissed',
      decidedAt: now.toISOString(),
    });
  return { ok: true };
}

/** Hold one queued send: the batch goes without it, and the draft is back in the student's hands. */
export async function holdSend(
  user: Pick<User, 'id'>,
  draftId: string,
): Promise<{ ok: true; item?: AutopilotItem } | Fail> {
  if (isServerUser(user.id)) {
    const r = await callApi('/autopilot/hold', { draftId });
    return r.ok ? { ok: true, item: r.value.item } : { ok: false, message: r.message };
  }
  const m = await db.outbound.get(draftId);
  if (!m || m.userId !== user.id) return { ok: false, message: 'That draft is gone.' };
  if (m.status === 'sent' || m.status === 'sending') return { ok: false, message: 'It already went out.' };
  const { cancelScheduled } = await import('./autopilot');
  const undone = (await cancelScheduled(user.id, draftId)) || (await undoQueuedSafe(user, draftId));
  if (!undone) return { ok: false, message: 'It could not be held.' };
  await db.outbound.update(draftId, { error: 'held', autoSent: undefined });
  return { ok: true };
}

async function undoQueuedSafe(user: Pick<User, 'id'>, id: string): Promise<boolean> {
  const { undoQueued } = await import('./send');
  return undoQueued(user as User, id);
}

/**
 * Pause what Orbit sends on its own: everything until `until` (null lifts it), or one goal (the breaker's key, with
 * the student as the reason). An account pauses on the server and mirrors it here; local mode pauses here and puts
 * the queued autopilot sends back as drafts.
 */
export async function pauseAutopilot(
  user: Pick<User, 'id'>,
  req: { until: string | null; goalId?: string },
  now = new Date(),
): Promise<{ ok: true; pausedUntil: string | null; cancelled: number } | Fail> {
  const settings = await db.settings.get(user.id);
  if (req.goalId) {
    const goals = { ...(settings?.autopilotPausedGoals ?? {}) };
    if (req.until === null) delete goals[req.goalId];
    else
      goals[req.goalId] = {
        reason: 'student',
        text: 'You paused it',
        until: req.until,
        at: now.toISOString(),
      };
    await db.settings.update(user.id, { autopilotPausedGoals: goals });
    if (isServerUser(user.id)) {
      const r = await callApi('/autopilot/pause', { until: req.until, goalId: req.goalId });
      if (!r.ok) return { ok: false, message: r.message };
    }
    return { ok: true, pausedUntil: req.until, cancelled: 0 };
  }
  await db.settings.update(user.id, { autopilotPausedUntil: req.until ?? undefined });
  let cancelled = 0;
  if (req.until) {
    const { cancelScheduled } = await import('./autopilot');
    const queued = await db.outbound
      .where('userId')
      .equals(user.id)
      .filter((o) => o.status === 'queued' && !!o.autopilot)
      .toArray();
    for (const q of queued) if (await cancelScheduled(user.id, q.id)) cancelled++;
  }
  if (isServerUser(user.id)) {
    const r = await callApi('/autopilot/pause', { until: req.until });
    if (!r.ok) return { ok: false, message: r.message };
    cancelled += r.value.cancelled;
  }
  return { ok: true, pausedUntil: req.until, cancelled };
}

/** The mode, for the account or one goal: the server's and this browser's settings together. */
export async function setMode(
  user: Pick<User, 'id'>,
  mode: AutopilotMode,
  goalId?: string,
): Promise<{ ok: true; mode: AutopilotMode; goalId: string | null } | Fail> {
  if (goalId) {
    const goal = await db.userGoals.get(goalId);
    if (!goal || goal.userId !== user.id || goal.deletedAt)
      return { ok: false, message: 'Orbit has no goal with that id. List the goals first.' };
    if (isServerUser(user.id)) {
      const r = await callApi('/autopilot/mode', { mode, goalId });
      if (!r.ok) return { ok: false, message: r.message };
    }
    await db.userGoals.update(goalId, {
      autonomyLevel: AUTOPILOT_MODE_LEVEL[mode],
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, mode, goalId };
  }
  if (isServerUser(user.id)) {
    const r = await callApi('/autopilot/mode', { mode });
    if (!r.ok) return { ok: false, message: r.message };
  }
  await db.settings.update(user.id, { autopilotMode: mode });
  return { ok: true, mode, goalId: null };
}

export type AnswerResult =
  | { ok: true; draft: ServerDraft; local: false }
  | { ok: true; draft: OutboundMessage; local: true }
  | Fail;

/**
 * The student's one line answers what a reply asked (plan 29 §B2.3). An account sends it to the server, which drafts
 * the reply around it; local mode writes the reply itself from the answer, as a draft in the chat's thread. The
 * Needs you card is done either way. Nothing is sent: the draft waits for approval.
 */
export async function answerReply(
  user: User,
  req: { draftId?: string; messageId?: string; suggestionId?: string; answer: string },
  now = new Date(),
): Promise<AnswerResult> {
  const answer = req.answer.replace(/\s+/g, ' ').trim();
  if (!answer) return { ok: false, message: 'Say what the answer is, in a line.' };
  const card = req.suggestionId
    ? await db.suggestions.get(req.suggestionId)
    : await db.suggestions
        .where('userId')
        .equals(user.id)
        .filter(
          (s) =>
            s.kind === 'needs_you' &&
            s.status === 'pending' &&
            ((!!req.messageId && s.payload.messageId === req.messageId) ||
              (!!req.draftId && (s.payload.draftId === req.draftId || s.outboundMessageId === req.draftId))),
        )
        .first();
  const messageId = req.messageId ?? (card?.payload.messageId as string | undefined);
  const draftId = req.draftId ?? (card?.payload.draftId as string | undefined);
  if (isServerUser(user.id)) {
    if (!draftId && !messageId)
      return { ok: false, message: 'Orbit does not know which reply this answers.' };
    const r = await callApi('/replies/answer', {
      ...(draftId && !messageId ? { draftId } : {}),
      ...(messageId ? { messageId } : {}),
      answer,
    });
    if (!r.ok) return { ok: false, message: r.message };
    if (card) await db.suggestions.update(card.id, { status: 'done', decidedAt: now.toISOString() });
    await keepServerDraft(r.value.draft, user.id);
    return { ok: true, draft: r.value.draft, local: false };
  }
  if (!card?.personId) return { ok: false, message: 'Orbit does not know which reply this answers.' };
  const person = await db.people.get(card.personId);
  if (!person) return { ok: false, message: 'Orbit no longer has that person.' };
  const chat = card.chatId ? await db.chats.get(card.chatId) : undefined;
  const body = [
    `Hi ${person.firstName || person.displayName.split(' ')[0]},`,
    `Thanks for asking. ${answer.replace(/[.!?]*$/, '')}. Happy to say more whenever works for you.`,
    `Best,\n${user.firstName ?? ''}`.trim(),
  ].join('\n\n');
  const draft: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId: person.id,
    chatId: chat?.id,
    suggestionId: card.id,
    goalId: chat?.goalId,
    channel: 'gmail',
    kind: 'reply',
    externalThreadId: chat?.threadId ? (await db.threads.get(chat.threadId))?.externalThreadId : undefined,
    toEmail: person.primaryEmail,
    bodyDraft: body,
    status: 'draft',
    generatedBy: 'template',
    draftedAt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  await db.outbound.add(draft);
  await db.suggestions.update(card.id, {
    status: 'done',
    decidedAt: now.toISOString(),
    outboundMessageId: draft.id,
    payload: { ...card.payload, answer },
  });
  return { ok: true, draft, local: true };
}

// ---- the words Settings, the chat and the review share (plan 29 §B1) -------------------------------------------------

/** What each mode means, in the student's words, exactly as Settings prints it (plan 29 §B1). */
export const AUTOPILOT_MODE_TEXT: Record<AutopilotMode, { title: string; body: string }> = {
  off: { title: 'Off', body: 'Orbit writes, you send.' },
  assist: {
    title: 'Assist',
    body: "You approve each message with one tap and it goes at the right time: the recipient's Tuesday to Thursday morning, spaced like a person. Bumps, thank-yous and scheduling replies go on their own once you have approved ten of a kind unchanged, each shown after with a minute to undo.",
  },
  autopilot: {
    title: 'Autopilot',
    body: "Everything in Assist, and: Orbit plans your week to your target, writes the first messages, shows them to you the evening before as Tomorrow's batch, and sends them in the morning unless you hold one. When someone replies, Orbit answers scheduling and thank-you replies itself, offers three times from your calendar when they say yes, books the call when they pick one, and asks you in chat only when a reply needs something only you know.",
  },
};

/** The rules under Autopilot, each a sentence, never hidden (plan 29 §B1), with the caps from the one rulebook. */
export const AUTOPILOT_RULES: readonly string[] = [
  'Email only, never LinkedIn.',
  "Only to alumni, people you know (closeness 40 or more) or a friend's contact.",
  `At most ${SEND_CAPS.autoPerDay} sends a day on its own, ${SEND_CAPS.autoFirstTouchesPerWeek} first messages a week.`,
  'Only companies on your goals.',
  'Stops and tells you at the first decline, unsubscribe or pushback.',
  'Every message appears under Sent for you with a minute to undo, and in your morning brief.',
  'Pause is one tap, here and in the chat.',
];

/** The last rung, said once under the rules (plan 29 §B1, §B2.2). */
export const FIRST_TOUCH_RUNG_RULE = `First messages are the last rung: until ${AUTO_FIRST_TOUCH_RUNG} first messages have gone out unchanged, the batch asks for a tap in the evening instead of sending in the morning.`;

/** "On autopilot: 9 sent, 4 replies, 2 calls, 1 pushback (paused Stripe)", or undefined for a quiet week. */
export function autopilotWeekLine(w: AutopilotWeek | undefined): string | undefined {
  if (!w || (!w.sent && !w.pushbacks)) return undefined;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const paused = w.paused.length ? ` (paused ${w.paused.join(' and ')})` : '';
  return `On autopilot: ${w.sent} sent, ${n(w.replies, 'reply', 'replies')}, ${n(w.calls, 'call')}, ${n(w.pushbacks, 'pushback')}${paused}`;
}

/**
 * A goal's "Run on autopilot" switch (plan 29 §B1): on writes the goal's level 2; off puts it back to the level the
 * account runs at, held at assist at most, so the rest of the account is untouched.
 */
export async function setGoalAutopilot(
  user: Pick<User, 'id'>,
  goalId: string,
  on: boolean,
): Promise<{ ok: true; mode: AutopilotMode; goalId: string | null } | Fail> {
  const account = (await db.settings.get(user.id))?.autopilotMode ?? 'off';
  return setMode(user, on ? 'autopilot' : account === 'off' ? 'off' : 'assist', goalId);
}

/** "Autopilot: sent 3, answered 2 replies, booked 1 call, 2 need you" for the brief, or undefined when nothing. */
export function autopilotLine(status: Pick<AutopilotStatus, 'sentToday' | 'needsYou'>): string | undefined {
  const sent = status.sentToday.length;
  const answered = status.sentToday.filter(
    (i) => i.kind === 'reply' || i.kind === 'schedule' || !!i.replyClass,
  ).length;
  const booked = status.sentToday.filter((i) => i.outcome === 'booked').length;
  const need = status.needsYou.length;
  if (!sent && !need) return undefined;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  return `Autopilot: sent ${sent}, answered ${n(answered, 'reply', 'replies')}, booked ${n(booked, 'call')}, ${need} need${need === 1 ? 's' : ''} you`;
}

/** The brief's autopilot line for this student: the local status, or the account's last status. */
export async function autopilotBriefLine(userId: string, now = new Date()): Promise<string | undefined> {
  const status = isServerUser(userId)
    ? await cachedStatus(userId)
    : await localAutopilotStatus({ id: userId }, now);
  return status ? autopilotLine(status) : undefined;
}
