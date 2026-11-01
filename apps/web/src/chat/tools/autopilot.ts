/**
 * Autopilot in the chat (plan 29 §B5): the mode (three words, confirmed), the status (what went out today, what goes
 * tomorrow, what needs the student, why something was held), a hold, the student's answer to a question a reply
 * asked, and the pause. One engine call each (engine/autopilotMode.ts), which reads the server for an account and this
 * browser otherwise. What Orbit learned about how the student writes has its own tools (tools/voice.ts).
 */
import type { AutopilotItem, AutopilotMode } from '@orbit/core';
import { AUTOPILOT_MODE_LEVEL, MESSAGE_KIND_LABELS, REPLY_NEXT_ACTION } from '@orbit/core';
import { db } from '../../db/schema';
import {
  answerReply,
  autopilotStatus,
  holdSend,
  LOCAL_AUTOPILOT_NOTE,
  pauseAutopilot,
  setMode,
} from '../../engine/autopilotMode';
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
    body: "Everything in Assist, and Orbit plans your week to your target, writes the first messages, shows them to you the evening before as Tomorrow's batch and sends them in the morning unless you hold one. It answers scheduling and thank-you replies itself, offers three times from your calendar when someone says yes, books the call when they pick one, and asks you only when a reply needs something only you know. Email only, never LinkedIn, at most 5 sends a day on its own.",
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

function itemLine(i: AutopilotItem, ctx: ToolContext) {
  return {
    draftId: i.draftId,
    person: i.personName,
    company: i.company ?? undefined,
    kind: MESSAGE_KIND_LABELS[i.kind] ?? i.kind,
    replyClass: i.replyClass ? REPLY_CLASS_LABELS[i.replyClass] : undefined,
    status: i.status,
    when: when(i.sentAt ?? i.sendAt, ctx),
    reason: i.reason ? wrapped(ctx, 'reason', i.reason, 300) : undefined,
    question: i.question ? wrapped(ctx, 'question', i.question, 300) : undefined,
    outcome: i.outcome ?? undefined,
    rung: i.autoRung,
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
    return {
      text: `${goal ? `For "${goal.title}": ` : ''}${m.title}. ${m.body}${isServerUser(ctx.user.id) ? '' : ` ${LOCAL_AUTOPILOT_NOTE}`}`,
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
      `${goal ? `For "${goal.title}", ` : ''}Orbit is on ${m.title}. ${m.body}${isServerUser(ctx.user.id) ? '' : ` ${LOCAL_AUTOPILOT_NOTE}`}`,
      '/settings/autopilot',
    );
  },
  toModel,
});

export const autopilotStatusTool = defineTool({
  name: 'autopilot_status',
  kind: 'read',
  description:
    'Call this when the student asks what Orbit sent today or on its own, what goes out tomorrow (tomorrow\'s batch), what is held and why ("why didn\'t you send to Priya"), which replies need them, whether a call got booked, whether autopilot is paused, or where the rungs and caps stand. Read only.',
  input: z.object({}),
  capabilities: ['autopilot_status'],
  progress: 'Reading what autopilot did',
  async execute(_input, ctx) {
    const r = await autopilotStatus(ctx.user, ctx.now);
    if (!r.ok) throw new Error(r.message);
    const s = r.status;
    const booked = s.sentToday.filter((i) => i.outcome === 'booked').length;
    const summary = [
      `Autopilot is ${s.mode}${s.pausedUntil ? `, paused until ${when(s.pausedUntil, ctx)}` : ''}.`,
      `Sent ${s.sentToday.length} on its own today${booked ? `, ${plural(booked, 'call')} booked` : ''}; ${plural(s.queued.length, 'message')} queued for the morning; ${plural(s.held.length, 'message')} held; ${plural(s.needsYou.length, 'reply', 'replies')} need you.`,
      s.pausedGoals.length
        ? `Paused goals: ${s.pausedGoals.map((g) => `${g.title} (${g.reason})`).join('; ')}.`
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
