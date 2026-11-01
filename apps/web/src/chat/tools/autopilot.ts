/**
 * Autopilot in the chat (plan 29 §B5): the mode (three words, confirmed), the status (what went out today, what goes
 * tomorrow, what needs the student, why something was held), a hold, the student's answer to a question a reply
 * asked, and the pause. One engine call each (engine/autopilotMode.ts), which reads the server for an account and this
 * browser otherwise. What Orbit learned about how the student writes has its own tools (tools/voice.ts).
 */
import type { AutopilotItem, AutopilotMode, AutopilotStatus, ReplyItem } from '@orbit/core';
import {
  AUTOPILOT_MODE_LEVEL,
  firstTouchRungLine,
  MESSAGE_KIND_LABELS,
  REPLY_NEXT_ACTION,
  SEND_CAPS,
} from '@orbit/core';
import { db } from '../../db/schema';
import {
  answerReply,
  autopilotStatus,
  autopilotWeekLine,
  holdSend,
  LOCAL_AUTOPILOT_NOTE,
  pauseAutopilot,
  setMode,
} from '../../engine/autopilotMode';
import { whyNotFirstTouch } from '../../engine/autopilotPlan';
import { listReplies, REPLY_CLASS_LABELS } from '../../engine/replies';
import { isServerUser } from '../../integrations/orbitApi';
import { z } from '../../zod';
import type { ToolContext } from '../types';
import { type AnyTool, clip, defineTool, err, ok, plural, toModel, wrapped } from './_shared';

/** What each mode means, in the student's words (plan 29 §B1). */
export const MODE_TEXT: Record<AutopilotMode, { title: string; body: string }> = {
  off: { title: 'Off', body: 'Orbit writes, you send.' },
  assist: {
    title: 'Assist',
    body: "You approve each message with one tap and it goes at the right time, the recipient's Tuesday to Thursday morning. Bumps, thank-yous and scheduling replies go on their own once you have approved ten of a kind unchanged, each shown after with a minute to undo.",
  },
  autopilot: {
    title: 'Autopilot',
    body: "Everything in Assist, and Orbit plans your week to your target, writes the first messages, shows them to you the evening before as Tomorrow's batch and sends them in the morning unless you hold one. It answers scheduling and thank-you replies itself, books the call when someone picks one of three times from your calendar, and asks you only when a reply needs something only you know; email only, never LinkedIn, at most 5 sends a day on its own.",
  },
};

const MODES = ['off', 'assist', 'autopilot'] as const;

const when = (iso: string | null | undefined, ctx: ToolContext) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: ctx.user.timezone || undefined,
      })
    : undefined;

/** The same moment in the recipient's zone, when it differs from the student's: first messages go in their morning. */
const theirTime = (i: Pick<AutopilotItem, 'sendAt' | 'sentAt' | 'recipientTimeZone'>, ctx: ToolContext) => {
  const at = i.sentAt ?? i.sendAt;
  const tz = i.recipientTimeZone;
  if (!at || !tz || tz === ctx.user.timezone) return undefined;
  const fmt = (zone?: string) =>
    new Date(at).toLocaleString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    });
  const theirs = fmt(tz);
  return theirs === fmt(ctx.user.timezone || undefined) ? undefined : theirs;
};

/**
 * "Wed 8:40 AM their time (5:40 AM your time)": the recipient's clock first, since their morning is the rule a send
 * keeps and the time a reply quotes, and the student's beside it when it differs.
 */
const whenBoth = (i: Pick<AutopilotItem, 'sendAt' | 'sentAt' | 'recipientTimeZone'>, ctx: ToolContext) => {
  const mine = when(i.sentAt ?? i.sendAt, ctx);
  const theirs = theirTime(i, ctx);
  if (!mine || !theirs) return mine;
  // the weekday only when the student's day differs from theirs
  const sameDay = mine.split(' ')[0] === theirs.split(' ')[0];
  return `${theirs} their time (${sameDay ? mine.slice(mine.indexOf(' ') + 1) : mine} your time)`;
};

function itemLine(i: AutopilotItem, ctx: ToolContext) {
  return {
    draftId: i.draftId,
    person: i.personName,
    company: i.company ?? undefined,
    kind: MESSAGE_KIND_LABELS[i.kind] ?? i.kind,
    replyClass: i.replyClass ? REPLY_CLASS_LABELS[i.replyClass] : undefined,
    status: i.status,
    when: whenBoth(i, ctx),
    reason: i.reason ? wrapped(ctx, 'reason', i.reason, 300) : undefined,
    question: i.question ? wrapped(ctx, 'question', i.question, 300) : undefined,
    outcome: i.outcome ?? undefined,
    rung: i.autoRung,
  };
}

/**
 * Where the first-message rung stands, in one sentence (plan 29 §B2.2), for the confirm before autopilot is turned
 * on: "14 of 20 first messages approved unchanged. Until 6 more go out as Orbit wrote them, ..." Read from the status;
 * nothing when it cannot be read.
 */
async function rungSentence(ctx: ToolContext): Promise<string> {
  const r = await autopilotStatus(ctx.user, ctx.now).catch(() => undefined);
  const first = r?.ok ? r.status.rungs.find((x) => x.kind === 'first_touch') : undefined;
  return first
    ? firstTouchRungLine({ unchanged: first.unchanged, needed: first.needed, earned: first.unlocked })
    : '';
}

/** "Dan" names Daniel: a word of the name that starts with the word said, or the other way round. */
function namedBy(said: string | undefined): (name: string) => boolean {
  const want = (said ?? '').toLowerCase().trim();
  return (name: string) =>
    !!want &&
    name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => want.split(/\s+/).some((v) => v.length >= 3 && (w.startsWith(v) || v.startsWith(w))));
}

/**
 * "Why didn't you send to Priya" (plan 29 §B6), answered with the one rule: held with its reason, waiting in the
 * batch, already sent, left out by the last plan with its rule, or, for someone the plan never weighed, the first
 * condition they fail against the goals.
 */
async function whyNot(
  personName: string,
  s: AutopilotStatus,
  ctx: ToolContext,
  seen: { replies: ReplyItem[]; calls: { with: string[]; startAt: string; timeZone?: string }[] } = {
    replies: [],
    calls: [],
  },
): Promise<{ person: string; answer: string } | undefined> {
  const named = namedBy(personName);
  const first = (n: string) => n.split(' ')[0];
  // what they did comes first: a booked call, a reply that closed the door, a question waiting on the student. "Did
  // the call with Lena get booked" is answered here, never from the stage of a chat or the send lists
  const call = seen.calls.find((c) => c.with.some(named));
  const reply = seen.replies.find((x) => named(x.personName));
  const confirmation = s.sentToday.find((i) => named(i.personName) && i.replyClass === 'scheduling');
  const confirmed = confirmation?.sentAt ? ` The confirmation went ${when(confirmation.sentAt, ctx)}.` : '';
  if (call) {
    const who = call.with.find(named)!;
    return {
      person: who,
      answer: `The call with ${first(who)} is booked for ${whenBoth({ sendAt: call.startAt, sentAt: null, recipientTimeZone: call.timeZone }, ctx)}.${confirmed}`,
    };
  }
  if (reply?.outcome === 'booked' || confirmation?.outcome === 'booked')
    return {
      person: reply?.personName ?? confirmation!.personName,
      answer: `${first(reply?.personName ?? confirmation!.personName)} picked one of the times Orbit offered and the call is booked.${confirmed}`,
    };
  if (reply && (reply.replyClass === 'decline' || reply.replyClass === 'unsubscribe'))
    return {
      person: reply.personName,
      answer: `${first(reply.personName)} ${reply.replyClass === 'unsubscribe' ? 'asked not to be contacted' : 'said no'} ${when(reply.receivedAt, ctx)}, so Orbit will not write to them again.`,
    };
  if (reply?.replyClass === 'question' && !reply.answer)
    return {
      person: reply.personName,
      answer: `${first(reply.personName)} asked you something ${when(reply.receivedAt, ctx)}; the reply waits for your answer in Needs you.`,
    };
  if (reply?.replyClass === 'scheduling' && confirmation)
    return {
      person: reply.personName,
      answer: `${first(reply.personName)} wrote back about a time ${when(reply.receivedAt, ctx)} and Orbit answered ${when(confirmation.sentAt ?? confirmation.sendAt, ctx)}; nothing is on the calendar yet.`,
    };
  const held = s.held.find((i) => named(i.personName));
  if (held)
    return {
      person: held.personName,
      answer: `${first(held.personName)} was held: ${held.reason ?? 'it waits for you'}`,
    };
  const queued = s.queued.find((i) => named(i.personName));
  if (queued)
    return {
      person: queued.personName,
      answer:
        queued.status === 'needs_tap'
          ? `${first(queued.personName)} is in tomorrow's batch for ${whenBoth(queued, ctx)}, waiting for your tap: until twenty first messages go out unchanged, each one needs one.`
          : `${first(queued.personName)} is in tomorrow's batch and goes ${whenBoth(queued, ctx)} unless you hold it.`,
    };
  const sent = s.sentToday.find((i) => named(i.personName));
  if (sent)
    return {
      person: sent.personName,
      answer: `Orbit did write to ${first(sent.personName)}, ${when(sent.sentAt, ctx)}.`,
    };
  const skipped = (s.skipped ?? []).find((i) => named(i.personName));
  if (skipped) return { person: skipped.personName, answer: skipped.reason };
  const people = await db.people.where('userId').equals(ctx.user.id).toArray();
  const p = people.find((x) => named(x.displayName));
  if (!p) return undefined;
  const why = await whyNotFirstTouch(ctx.user, p.id, ctx.now);
  return {
    person: p.displayName,
    answer:
      why ??
      `Nothing rules ${first(p.displayName)} out; the plan writes to at most ${SEND_CAPS.autoFirstTouchesPerDay} a morning, the closest first, so ${first(p.displayName)} comes up on a later morning.`,
  };
}

export const setAutopilotModeTool = defineTool({
  name: 'set_autopilot_mode',
  kind: 'risky',
  description:
    "Call this when the student asks to put their outreach (or one goal) on autopilot, on assist, or to turn it off. Off: Orbit writes, they send. Assist: one tap approves and it goes in the recipient's morning; the kinds they handed over (bumps, thank-yous, scheduling replies) go on their own. Autopilot: Assist plus first messages after an evening review, replies finished by class, calls booked from a confirmed slot; email only, never LinkedIn, at most 5 sends a day on its own. Explain the mode in two sentences first; the student confirms. Works for the account or one goal (goalId from list_goals).",
  input: z.object({
    mode: z.enum(MODES).describe('off, assist or autopilot.'),
    goalId: z.string().optional().describe('Only this goal (from list_goals).'),
  }),
  capabilities: ['autopilot_mode', 'autonomy_set'],
  progress: 'Changing what Orbit may do',
  async summarizeIntent(input, ctx) {
    const goal = input.goalId ? await db.userGoals.get(input.goalId) : undefined;
    const m = MODE_TEXT[input.mode];
    const rung = input.mode === 'autopilot' ? await rungSentence(ctx) : '';
    return {
      text: `${goal ? `For "${goal.title}": ` : ''}${m.title}. ${m.body}${rung ? ` ${rung}` : ''}${isServerUser(ctx.user.id) ? '' : ` ${LOCAL_AUTOPILOT_NOTE}`}`,
      blockedReason:
        input.goalId && !goal ? 'Orbit has no goal with that id. List the goals first.' : undefined,
    };
  },
  async execute(input, ctx) {
    const r = await setMode(ctx.user, input.mode, input.goalId);
    if (!r.ok) throw new Error(r.message);
    const goal = input.goalId ? await db.userGoals.get(input.goalId) : undefined;
    const m = MODE_TEXT[input.mode];
    return ok(
      'settings',
      { changes: [{ label: goal ? `Autopilot for ${goal.title}` : 'Autopilot', to: m.title }] },
      {
        mode: input.mode,
        level: AUTOPILOT_MODE_LEVEL[input.mode],
        goalId: input.goalId ?? null,
        local: !isServerUser(ctx.user.id),
      },
      // the student read the rules on the Approve card a moment ago: the result says only what changed, so the reply
      // after it is one line, never the card again
      `${goal ? `${goal.title} is` : 'Orbit is'} on ${m.title} now. Pause is one tap, here or in the chat.${isServerUser(ctx.user.id) ? '' : ` ${LOCAL_AUTOPILOT_NOTE}`}`,
      '/settings/autopilot',
    );
  },
  toModel,
});

export const autopilotStatusTool = defineTool({
  name: 'autopilot_status',
  kind: 'read',
  description:
    'Call this when the student asks what Orbit sent today or on its own, what goes out tomorrow (tomorrow\'s batch, and which first messages wait for their tap), what is held and why, why someone was not written to ("why didn\'t you send to Priya": give personName, and the answer names the one rule), which replies need them, whether a call got booked and when, what happened with someone who replied (an unsubscribe or a decline means never write to them again), whether autopilot is paused, how the week went on autopilot, or where the rungs and caps stand. It returns the replies of the last week with their class and outcome and the upcoming calls with their times: answer from those, never from the stage of a chat or an old note. Read only.',
  input: z.object({
    personName: z
      .string()
      .max(120)
      .optional()
      .describe('Someone the student asks about ("why didn\'t you send to Priya"), as they say the name.'),
  }),
  capabilities: ['autopilot_status'],
  progress: 'Reading what autopilot did',
  async execute(input, ctx) {
    const [r, rep] = await Promise.all([
      autopilotStatus(ctx.user, ctx.now),
      listReplies(ctx.user).catch(() => ({ ok: false as const })),
    ]);
    if (!r.ok) throw new Error(r.message);
    const s = r.status;
    const booked = s.sentToday.filter((i) => i.outcome === 'booked').length;
    // the replies of the last week, each with what it was and what came of it, and every booked call with its time:
    // the answer to "did Lena book", "what happened with Chloe" is read here, never guessed from a chat's stage
    const replies = rep.ok ? (rep as { replies: ReplyItem[] }).replies : [];
    const weekAgo = ctx.now.getTime() - 7 * 86_400_000;
    const recent = replies.filter((x) => Date.parse(x.receivedAt) >= weekAgo).slice(0, 12);
    const now = ctx.now.toISOString();
    const calls = (
      await db.events
        .where('userId')
        .equals(ctx.user.id)
        .filter((e) => e.startAt >= now && /coffee chat|call|chat with/i.test(e.title ?? ''))
        .toArray()
    )
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 8);
    const attendees = (await db.people.bulkGet(calls.flatMap((e) => e.attendeePersonIds ?? []))).flatMap(
      (p) => (p ? [p] : []),
    );
    const names = new Map(attendees.map((p) => [p.id, p.displayName] as const));
    // a call says the other person's clock too, as a send does: "Thu 11:00 AM their time (8:00 AM your time)"
    const zoneOf = (e: (typeof calls)[number]) =>
      attendees.find((p) => (e.attendeePersonIds ?? []).includes(p.id) && p.timezone)?.timezone;
    const taps = s.queued.filter((i) => i.status === 'needs_tap').length;
    const why = input.personName
      ? await whyNot(input.personName, s, ctx, {
          replies: recent,
          calls: calls.map((e) => ({
            with: (e.attendeePersonIds ?? []).flatMap((id) => names.get(id) ?? []),
            startAt: e.startAt,
            timeZone: zoneOf(e),
          })),
        })
      : undefined;
    const week = autopilotWeekLine(s.week);
    const summary = [
      input.personName
        ? why
          ? why.answer
          : `Orbit has no one called ${input.personName} in your people, so it never weighed them.`
        : '',
      `${{ off: 'Orbit sends nothing on its own (Off)', assist: 'Assist is on', autopilot: 'Autopilot is on' }[s.mode] ?? `Mode: ${s.mode}`}${s.pausedUntil ? `, paused until ${when(s.pausedUntil, ctx)}` : ''}.`,
      `Sent ${s.sentToday.length} on its own today${booked ? `, ${plural(booked, 'call')} booked` : ''}; ${plural(s.queued.length, 'message')} queued for the morning${taps ? ` (${taps} waiting for your tap)` : ''}; ${plural(s.held.length, 'message')} held; ${plural(s.needsYou.length, 'reply', 'replies')} need you.`,
      s.friendAsks?.length
        ? `${plural(s.friendAsks.length, 'ask')} to a friend ready for your tap: ${s.friendAsks.map((a) => `${a.friendName} for ${a.targetName}`).join(', ')}.`
        : '',
      week ? `${week}.` : '',
      s.pausedGoals.length
        ? `Paused goals: ${s.pausedGoals.map((g) => `${g.title} (${g.reason})`).join('; ')}.`
        : // said outright, so a pushback in the week is never read as a pause still holding
          !s.pausedUntil && s.mode !== 'off'
          ? 'Nothing is paused now.'
          : '',
      r.note ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    const data = {
      mode: s.mode,
      pausedUntil: s.pausedUntil,
      pausedGoals: s.pausedGoals.map((g) => ({
        goalId: g.goalId,
        title: g.title,
        reason: wrapped(ctx, 'reason', g.reason, 300),
        until: g.until,
      })),
      sentToday: s.sentToday.map((i) => itemLine(i, ctx)),
      queued: s.queued.map((i) => itemLine(i, ctx)),
      held: s.held.map((i) => itemLine(i, ctx)),
      needsYou: s.needsYou.map((i) => itemLine(i, ctx)),
      rungs: s.rungs,
      caps: s.caps,
      reviewUntil: s.reviewUntil,
      firstTouchRung: s.rungs.find((x) => x.kind === 'first_touch'),
      skipped: (s.skipped ?? []).slice(0, 12).map((x) => ({
        person: x.personName,
        company: x.company ?? undefined,
        rule: x.rule,
        reason: wrapped(ctx, 'reason', x.reason, 300),
      })),
      repliesThisWeek: recent.map((x) => ({
        person: x.personName,
        company: x.company ?? undefined,
        replyClass: REPLY_CLASS_LABELS[x.replyClass] ?? x.replyClass,
        received: when(x.receivedAt, ctx),
        // what they wrote, wrapped like every other outside text: "Thu Oct 8 at 11 works for me"
        said: wrapped(ctx, 'reply', x.snippet, 300),
        outcome: x.outcome ?? undefined,
        question: x.question ? wrapped(ctx, 'question', x.question, 300) : undefined,
        closed:
          x.replyClass === 'decline' || x.replyClass === 'unsubscribe'
            ? 'do not write to them again'
            : undefined,
      })),
      upcomingCalls: calls.map((e) => ({
        with: (e.attendeePersonIds ?? []).map((id) => names.get(id)).filter(Boolean),
        title: e.title,
        at: whenBoth({ sendAt: e.startAt, sentAt: null, recipientTimeZone: zoneOf(e) }, ctx),
      })),
      friendAsks: (s.friendAsks ?? []).map((a) => ({
        friend: a.friendName,
        person: a.targetName,
        company: a.company ?? undefined,
        note: wrapped(ctx, 'note', a.note, 600),
      })),
      week: s.week,
      ...(input.personName
        ? { asked: { name: input.personName, person: why?.person, answer: why?.answer ?? null } }
        : {}),
      local: r.local,
      note: r.note,
    };
    return ok('text', data, data, summary, '/inbox');
  },
  toModel,
});

export const holdSendTool = defineTool({
  name: 'hold_send',
  kind: 'write',
  description:
    'Call this when the student wants to hold a message autopilot queued ("hold tomorrow\'s batch", "don\'t send the one to Grace"). Give the draftId from autopilot_status, or all: true to hold every queued message. A held message goes back to a draft; the rest of the batch still goes. Reversible: approving it sends it again.',
  input: z.object({
    draftId: z.string().optional().describe('The queued message to hold (from autopilot_status).'),
    personName: z.string().optional().describe('Who the queued message is to, as the student says it.'),
    all: z.boolean().optional().describe("Hold everything queued for tomorrow's batch."),
  }),
  capabilities: ['autopilot_hold'],
  progress: 'Holding the send',
  async execute(input, ctx) {
    if (!input.draftId && !input.all && !input.personName)
      return err('Say which message to hold, or hold them all.');
    const r = await autopilotStatus(ctx.user, ctx.now);
    if (!r.ok) throw new Error(r.message);
    const want = (input.personName ?? '').toLowerCase().trim();
    const named = (name: string) =>
      !!want &&
      name
        .toLowerCase()
        .split(/\s+/)
        .some((w) => want.split(/\s+/).some((v) => v.length >= 3 && (w.startsWith(v) || v.startsWith(w))));
    const targets = input.all
      ? r.status.queued
      : r.status.queued.filter((q) => q.draftId === input.draftId || named(q.personName));
    if (!targets.length && input.personName && !input.draftId) {
      const text = `Nothing is queued for ${input.personName}, so there is nothing to hold.`;
      return ok('text', { held: [] }, { held: [], count: 0 }, text, '/inbox');
    }
    if (!targets.length) {
      if (input.draftId) {
        const h = await holdSend(ctx.user, input.draftId);
        if (!h.ok) throw new Error(h.message);
        return ok(
          'text',
          { held: [input.draftId] },
          { held: [input.draftId] },
          'Held. It is a draft again.',
          '/inbox',
        );
      }
      return ok('text', { held: [] }, { held: [] }, 'Nothing is queued to hold.', '/inbox');
    }
    const held: string[] = [];
    for (const t of targets) {
      const h = await holdSend(ctx.user, t.draftId);
      if (h.ok) held.push(t.personName);
    }
    const summary = held.length
      ? `Held ${held.join(' and ')}. ${held.length === 1 ? 'It is a draft' : 'They are drafts'} again; nothing new goes out in the morning${r.status.queued.length > held.length ? ' for them' : ''}. Replies and bumps keep going unless you pause everything.`
      : 'Nothing could be held.';
    return ok('text', { held }, { held, count: held.length }, summary, '/inbox');
  },
  toModel,
});

export const answerReplyTool = defineTool({
  name: 'answer_reply',
  kind: 'write',
  description:
    'Call this when the student answers a question someone asked in a reply ("answer Dan: yes, applied Monday", "tell Priya I am a junior"). Give the person\'s name or the messageId from autopilot_status, and the answer in the student\'s words. Orbit drafts the reply around the answer; nothing is sent until they approve it. Only for replies under Needs you.',
  input: z.object({
    personName: z.string().optional().describe('Who asked (as the student says it).'),
    messageId: z.string().optional().describe('The reply (from autopilot_status or list_replies).'),
    answer: z.string().min(1).max(600).describe("The student's answer, in their words."),
  }),
  capabilities: ['reply_answer'],
  progress: 'Drafting the reply around your answer',
  async execute(input, ctx) {
    const cards = await db.suggestions
      .where('userId')
      .equals(ctx.user.id)
      .filter((s) => s.kind === 'needs_you' && s.status === 'pending' && !s.payload.closed)
      .toArray();
    const want = (input.personName ?? '').toLowerCase().trim();
    // "Dan" names Daniel: a word of the name that starts with the word said, or the other way round
    const named = (name: string) =>
      !!want &&
      name
        .toLowerCase()
        .split(/\s+/)
        .some((w) => want.split(/\s+/).some((v) => v.length >= 3 && (w.startsWith(v) || v.startsWith(w))));
    const card =
      cards.find((s) => input.messageId && s.payload.messageId === input.messageId) ??
      cards.find((s) => named(String(s.payload.personName ?? ''))) ??
      (cards.length === 1 && !want && !input.messageId ? cards[0] : undefined);
    let messageId = input.messageId;
    if (!card && !messageId && isServerUser(ctx.user.id)) {
      // the card may not have reached this browser yet: the server's replies know the question
      const known = await listReplies(ctx.user);
      const hit = known.ok
        ? known.replies.find(
            (x) =>
              x.replyClass === 'question' && !x.answer && (named(x.personName) || known.replies.length === 1),
          )
        : undefined;
      messageId = hit?.messageId;
    }
    if (!card && !messageId) {
      const waiting = cards.map((c) => String(c.payload.personName ?? 'someone'));
      const text = waiting.length
        ? `Which one? Waiting on you: ${waiting.join(', ')}.`
        : 'Nothing is waiting on an answer from you right now.';
      return ok('text', { waiting }, { waiting, answered: false }, text, '/inbox');
    }
    const r = await answerReply(
      ctx.user,
      { suggestionId: card?.id, messageId, answer: input.answer },
      ctx.now,
    );
    if (!r.ok) throw new Error(r.message);
    const name = String(card?.payload.personName ?? input.personName ?? 'them');
    const first = name.split(' ')[0];
    const body = r.local ? r.draft.bodyDraft : r.draft.body;
    const personId = r.local ? r.draft.personId : r.draft.personId;
    const data = {
      draftId: r.draft.id,
      person: name,
      body: wrapped(ctx, 'draft', body, 1500),
      textToPaste: body,
      answer: input.answer,
      sent: false,
      status: r.local ? r.draft.status : r.draft.status,
    };
    return ok(
      'text',
      data,
      { ...data, body: wrapped(ctx, 'draft', body, 1500) },
      `Drafted the reply to ${first} around your answer. Nothing is sent until you approve it${r.local ? ' in Drafts' : ' in Drafts, Replies'}.`,
      personId ? `/people/${personId}?tab=messages` : '/inbox?tab=replies',
    );
  },
  toModel,
});

export const pauseAutopilotTool = defineTool({
  name: 'pause_autopilot',
  kind: 'write',
  description:
    'Call this when the student asks to pause everything Orbit sends on its own ("pause everything", "stop autopilot", "pause Stripe"), or to resume. Until the date (or until they lift it) nothing Orbit chose a time for goes out; queued first messages go back to drafts. Optionally one goal (goalId from list_goals). Leave until out and resume: true to lift it.',
  input: z.object({
    until: z.string().optional().describe('ISO date-time or YYYY-MM-DD; leave out to pause until lifted.'),
    goalId: z.string().optional().describe('Only this goal (from list_goals).'),
    resume: z.boolean().optional().describe('Lift the pause.'),
  }),
  capabilities: ['autopilot_pause', 'outreach_pause'],
  progress: 'Pausing autopilot',
  async execute(input, ctx) {
    let until: string | null;
    if (input.resume) until = null;
    else if (input.until) {
      const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.until) ? `${input.until}T23:59:00` : input.until);
      if (Number.isNaN(t.getTime())) return err('Say the date as YYYY-MM-DD.');
      until = t.toISOString();
    } else until = new Date(ctx.now.getTime() + 365 * 86_400_000).toISOString();
    const r = await pauseAutopilot(ctx.user, { until, goalId: input.goalId }, ctx.now);
    if (!r.ok) throw new Error(r.message);
    const goal = input.goalId ? await db.userGoals.get(input.goalId) : undefined;
    const scope = goal ? `for "${goal.title}"` : 'everything Orbit sends on its own';
    const summary = until
      ? `Paused ${scope}${input.until ? ` until ${when(until, ctx)}` : ' until you lift it'}. ${r.cancelled ? `${plural(r.cancelled, 'queued message')} went back to drafts; ` : ''}queued replies wait. Say "resume autopilot" to start again.`
      : `Resumed ${scope}.`;
    return ok(
      'settings',
      {
        changes: [{ label: goal ? `Autopilot for ${goal.title}` : 'Autopilot', to: until ? 'Paused' : 'On' }],
      },
      { pausedUntil: until, goalId: input.goalId ?? null, cancelled: r.cancelled },
      summary,
      '/settings/autopilot',
    );
  },
  toModel,
});

/** What a class means for the next step, for draft_reply and the chat's explanations. */
export function nextStepText(cls: keyof typeof REPLY_NEXT_ACTION): string {
  return clip(REPLY_NEXT_ACTION[cls].summary, 300) ?? '';
}

export const autopilotTools: AnyTool[] = [
  setAutopilotModeTool,
  autopilotStatusTool,
  holdSendTool,
  answerReplyTool,
  pauseAutopilotTool,
];
