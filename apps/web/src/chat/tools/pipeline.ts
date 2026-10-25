/** Pipeline writes: stage moves with the board's guards, undo, and booking a chat's time. */
import type { CoffeeChat } from '@orbit/core';
import { STAGE_LABELS, STAGE_ORDER } from '@orbit/core';
import { db } from '../../db/schema';
import { scheduleChatAt } from '../../engine/move';
import { lastUserMove, moveChatGuarded, undoStageMove } from '../../engine/pipeline';
import { z } from '../../zod';
import {
  type AnyTool,
  chatFor,
  chatRef,
  defineTool,
  fmtWhen,
  ok,
  personRef,
  requirePerson,
  toModel,
} from './_shared';

const STAGES = STAGE_ORDER as [CoffeeChat['stage'], ...CoffeeChat['stage'][]];

export const movePipelineStage = defineTool({
  name: 'move_pipeline_stage',
  kind: 'write',
  description:
    'Call this only when the student explicitly says a chat moved: they replied, it is scheduled, it happened (completed), they declined, archive it, and so on. Give the person (or chat) and the stage. Guards: marking a chat Completed while its meeting is still ahead returns meeting_ahead and nothing changes until the student confirms with confirmEarly; a move to Scheduled with no meeting on record asks for the time (then call schedule_chat). The move can be undone with undo_stage_move.',
  input: z.object({
    personId: z.string().optional().describe('The person whose live chat moves (from search_people).'),
    chatId: z
      .string()
      .optional()
      .describe('The chat id, when the student has more than one chat with the person.'),
    stage: z.enum(STAGES).describe('The stage to move to.'),
    confirmEarly: z
      .boolean()
      .optional()
      .describe(
        'true only after the student confirmed they want it Completed although the meeting has not happened yet.',
      ),
  }),
  capabilities: [
    'pipeline_move_stage',
    'person_change_stage',
    'pipeline_confirm_early_done',
    'person_mark_done_after_past_event',
    'today_quiet_they_replied',
  ],
  progress: 'Moving the chat',
  async execute(input, ctx) {
    const chat = await chatFor(ctx, input);
    if (!chat)
      throw new Error('This person has no chat yet. A first message, a note or a warm-up starts one.');
    const person = await requirePerson(ctx, chat.personId);
    const reason = input.stage === 'replied' ? 'user:replied' : 'user:select';
    const r = await moveChatGuarded(ctx.user, chat, input.stage, reason, {
      force: input.confirmEarly,
      now: ctx.now,
    });
    const fresh = (await db.chats.get(chat.id)) ?? chat;
    const base = { chat: chatRef(fresh), person: personRef(person), outcome: r.outcome };
    if (r.outcome === 'meeting_ahead') {
      const out = { ...base, meetingAt: fmtWhen(r.meetingAt, ctx) };
      return ok(
        'pipeline',
        out,
        out,
        `${person.firstName}'s chat is on the calendar for ${out.meetingAt}, which has not come yet. Marking it done now drafts a thank-you for a chat that has not happened. Ask before calling again with confirmEarly.`,
        `/people/${person.id}`,
      );
    }
    if (r.outcome === 'unchanged') {
      return ok(
        'pipeline',
        base,
        base,
        `${person.firstName} is already in ${STAGE_LABELS[input.stage]}.`,
        `/people/${person.id}`,
      );
    }
    const thanks =
      input.stage === 'completed'
        ? await db.suggestions
            .where('chatId')
            .equals(chat.id)
            .filter((x) => x.kind === 'thank_you' && x.status === 'pending')
            .first()
        : undefined;
    const tail =
      input.stage === 'completed'
        ? thanks
          ? ' Your thank-you draft is in Drafts.'
          : ' Add a note about the chat and Orbit drafts your thank-you from it.'
        : input.stage === 'replied'
          ? ' Your reply is in Drafts.'
          : r.needsTime
            ? ' When is the chat? Say when, and Orbit puts it under Coming up.'
            : '';
    const out = {
      ...base,
      from: r.from,
      fromLabel: STAGE_LABELS[r.from],
      needsTime: r.needsTime,
      thankYouCardId: thanks?.id,
      undo: { tool: 'undo_stage_move', input: { chatId: chat.id } },
    };
    return ok(
      'pipeline',
      out,
      out,
      `Moved ${person.firstName} to ${STAGE_LABELS[input.stage]}.${tail}`,
      `/people/${person.id}`,
    );
  },
  toModel,
});

export const undoStageMoveTool = defineTool({
  name: 'undo_stage_move',
  kind: 'write',
  description:
    'Call this only when the student asks to undo or revert the last stage move on a chat ("put Priya back in Replied", "oops, revert that"). The chat returns to the stage it was in before the last move the student made.',
  input: z.object({
    personId: z.string().optional().describe('The person whose chat to put back.'),
    chatId: z.string().optional().describe('The chat id.'),
  }),
  capabilities: ['pipeline_undo_move'],
  progress: 'Putting the chat back',
  async execute(input, ctx) {
    const chat = await chatFor(ctx, input);
    if (!chat) throw new Error('This person has no chat to put back.');
    const person = await requirePerson(ctx, chat.personId);
    const last = await lastUserMove(chat.id);
    if (!last?.fromStage) throw new Error(`There is no move of yours to undo on ${person.firstName}'s chat.`);
    const stage = await undoStageMove(chat.id, last.fromStage);
    const fresh = (await db.chats.get(chat.id)) ?? chat;
    const out = { chat: chatRef(fresh), person: personRef(person), stage };
    return ok(
      'pipeline',
      out,
      out,
      `${person.firstName} is back in ${STAGE_LABELS[fresh.stage]}.`,
      `/people/${person.id}`,
    );
  },
  toModel,
});

export const scheduleChat = defineTool({
  name: 'schedule_chat',
  kind: 'write',
  description:
    'Call this only when the student says when a chat is booked ("my chat with Priya is Thursday at 2pm for 30 minutes") or changes its time. Give the start as ISO 8601 in the student\'s timezone; the time must not be in the past. The chat moves to Scheduled if it is not there, shows under Coming up, gets a prep card the day before and is marked Completed once it has passed.',
  input: z.object({
    personId: z.string().optional().describe('The person whose chat is booked.'),
    chatId: z.string().optional().describe('The chat id.'),
    startAt: z
      .string()
      .describe(
        'When the chat starts, ISO 8601 with an offset (resolve words like "Thursday 2pm" in the student\'s timezone first).',
      ),
    minutes: z.number().int().min(5).max(240).optional().describe('How long, in minutes (default 30).'),
  }),
  capabilities: ['pipeline_set_chat_time', 'person_set_time', 'person_change_time'],
  progress: 'Saving the time',
  async execute(input, ctx) {
    const chat = await chatFor(ctx, input);
    if (!chat)
      throw new Error('This person has no chat yet. Move them to Scheduled first, or write to them.');
    const person = await requirePerson(ctx, chat.personId);
    const at = new Date(input.startAt);
    if (Number.isNaN(at.getTime())) throw new Error('Orbit could not read that time. Give it as ISO 8601.');
    if (at.getTime() < ctx.now.getTime() - 60_000) throw new Error('Pick a time that has not passed yet.');
    const ev = await scheduleChatAt(ctx.user, chat, at, input.minutes ?? 30, ctx.now);
    const fresh = (await db.chats.get(chat.id)) ?? chat;
    const out = {
      chat: chatRef(fresh),
      person: personRef(person),
      eventId: ev.id,
      startAt: ev.startAt,
      when: fmtWhen(ev.startAt, ctx),
      minutes: input.minutes ?? 30,
    };
    return ok(
      'pipeline',
      out,
      out,
      `Saved. Your chat with ${person.firstName} is ${out.when}, under Coming up in Drafts, with prep the day before.`,
      `/people/${person.id}?tab=facts&prep=1`,
    );
  },
  toModel,
});

export const pipelineTools: AnyTool[] = [movePipelineStage, undoStageMoveTool, scheduleChat];
