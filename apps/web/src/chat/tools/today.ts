/** Writes on Today's cards: the brief, drafts for cards, snooze, dismiss, the yes/no cards, warm-up steps. */
import type { CoffeeChat, OutboundStatus, Suggestion } from '@orbit/core';
import { STAGE_LABELS, STAGE_ORDER, warmUpProgress } from '@orbit/core';
import { z } from 'zod/v4';
import { db } from '../../db/schema';
import { ensureDrafts, generateBrief, markWarmUpAction, revalidatePending } from '../../engine/brief';
import { markPrepOpened, unsnoozeSuggestion } from '../../engine/drafts';
import { markActionItemDone } from '../../engine/facts';
import { answerIntroductionQuestion } from '../../engine/introductions';
import { decideMerge, mergeEvidence } from '../../engine/people';
import { dismissSuggestion, restoreSuggestion, sendDueQueued, snoozeSuggestion } from '../../engine/send';
import { decideProposedStage } from '../../engine/stages';
import { dailyMaintenance } from '../../engine/sync';
import { SUGGESTION_KIND_LABELS, todayCards } from '../../engine/today';
import {
  type AnyTool,
  cardRef,
  defineTool,
  draftRef,
  fmtDay,
  ok,
  personRef,
  plural,
  requirePerson,
  requireSuggestion,
  toModel,
} from './_shared';

const STAGES = STAGE_ORDER as [CoffeeChat['stage'], ...CoffeeChat['stage'][]];

async function cardOut(s: Suggestion) {
  const person = s.personId ? await db.people.get(s.personId) : undefined;
  const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
  return {
    card: { ...cardRef(s, person), kindLabel: SUGGESTION_KIND_LABELS[s.kind].label },
    draft: draft ? draftRef(draft, person ?? undefined) : undefined,
  };
}

export const refreshBrief = defineTool({
  name: 'refresh_brief',
  kind: 'write',
  description:
    "Call this only when the student asks to refresh, rebuild or re-check today's brief or their day, or when today's brief has not been built yet. It runs the day's maintenance (timed stage rules, closeness, the daily brief, new drafts for the cards) and sends any Gmail message whose undo window has ended. Do not call it just to read the brief; use get_today_brief for that.",
  input: z.object({
    kind: z.enum(['daily', 'welcome', 'recap']).optional().describe('Which brief to build (default daily).'),
  }),
  capabilities: ['today_refresh_brief', 'daily_maintenance_auto'],
  progress: 'Rebuilding your brief',
  async execute(input, ctx) {
    await dailyMaintenance(ctx.user).catch(() => undefined);
    const brief = await generateBrief(ctx.user, input.kind ?? 'daily', ctx.now);
    await revalidatePending(ctx.user.id, ctx.now).catch(() => undefined);
    const due = await sendDueQueued(ctx.user, ctx.now);
    const pending = await db.suggestions
      .where('userId')
      .equals(ctx.user.id)
      .filter((s) => s.status === 'pending')
      .toArray();
    const { cards } = todayCards(pending, brief, ctx.now);
    const out = await Promise.all(cards.map(cardOut));
    const view = {
      briefDate: brief.briefDate,
      summary: brief.summaryText,
      cards: out,
      sentNow: due.filter((d) => d.ok).length,
    };
    return ok(
      'brief',
      view,
      view,
      `Updated from your latest email, calendar and notes. ${brief.summaryText}`,
      '/today',
    );
  },
  toModel,
});

export const ensureCardDrafts = defineTool({
  name: 'ensure_card_drafts',
  kind: 'write',
  description:
    'Call this when the student wants to see the cards that can wait, asks for a draft for a card that has none ("write the check-in for Sam"), or wants every pending card drafted. Pass card ids, or scope today_more (the deferred cards) or drafts_later (the drafts that can wait). Returns the cards with their drafts.',
  input: z.object({
    cardIds: z.array(z.string()).optional().describe('Specific card ids to draft.'),
    scope: z
      .enum(['today_more', 'drafts_later'])
      .optional()
      .describe(
        'Draft every deferred card (today_more) or every pending message card without a draft (drafts_later).',
      ),
  }),
  capabilities: ['today_show_more', 'drafts_show_later', 'card_draft_now'],
  progress: 'Writing the drafts',
  async execute(input, ctx) {
    let ids = input.cardIds ?? [];
    if (!ids.length) {
      const pending = await db.suggestions
        .where('userId')
        .equals(ctx.user.id)
        .filter((s) => s.status === 'pending' && !s.outboundMessageId)
        .toArray();
      ids = (input.scope === 'today_more' ? pending.filter((s) => s.deferred) : pending).map((s) => s.id);
    }
    await ensureDrafts(ctx.user, ids, ctx.now);
    const rows = (await Promise.all(ids.map((id) => db.suggestions.get(id)))).filter(
      (s): s is Suggestion => !!s,
    );
    const out = await Promise.all(rows.map(cardOut));
    const drafted = out.filter((o) => o.draft).length;
    return ok(
      'drafts',
      { cards: out },
      { cards: out },
      rows.length
        ? `${plural(drafted, 'card')} of ${rows.length} now ${drafted === 1 ? 'has' : 'have'} a draft.`
        : 'No cards needed a draft.',
      '/inbox',
    );
  },
  toModel,
});

export const manageSuggestion = defineTool({
  name: 'manage_suggestion',
  kind: 'write',
  description:
    'Call this only when the student asks to snooze a card (1, 3 or 7 days), undo a snooze or dismiss (restore), unsnooze a card now, or mark a prep card as opened (done). Not for dismissing: that is dismiss_suggestion. Confirm cards (did this change, duplicate, introduction) cannot be snoozed.',
  input: z.object({
    suggestionId: z.string().describe('The card id.'),
    action: z
      .enum(['snooze', 'restore', 'unsnooze', 'done'])
      .describe(
        'snooze: hide it for a few days. restore: undo a snooze or a dismiss. unsnooze: bring a snoozed card back now. done: close a prep card after opening the prep.',
      ),
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('For snooze: how many days (1, 3 or 7; default 1).'),
    draftWas: z
      .enum(['draft', 'failed'])
      .optional()
      .describe('For restore after a dismiss: the status the attached draft had, so it comes back too.'),
  }),
  capabilities: ['card_snooze', 'card_restore', 'draft_unsnooze', 'card_prep_open'],
  progress: 'Updating the card',
  async execute(input, ctx) {
    const s = await requireSuggestion(ctx, input.suggestionId);
    const label = SUGGESTION_KIND_LABELS[s.kind].label;
    let summary: string;
    switch (input.action) {
      case 'snooze': {
        if (['confirm_stage', 'confirm_merge', 'confirm_intro'].includes(s.kind))
          throw new Error('A question card cannot be snoozed. Answer it instead.');
        if (s.status !== 'pending') throw new Error('Only a pending card can be snoozed.');
        const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
        if (draft && ['queued', 'sending', 'handed_off'].includes(draft.status))
          throw new Error("That card's message is on its way; it cannot be snoozed now.");
        const days = input.days ?? 1;
        await snoozeSuggestion(ctx.user.id, s, days);
        summary = `Snoozed the ${label} card. It comes back in ${days === 7 ? 'a week' : plural(days, 'day')}.`;
        break;
      }
      case 'restore': {
        if (s.status !== 'snoozed' && s.status !== 'dismissed')
          throw new Error('Only a snoozed or dismissed card can be restored.');
        await restoreSuggestion(s, input.draftWas as OutboundStatus | undefined);
        summary = `The ${label} card is back on Today.`;
        break;
      }
      case 'unsnooze': {
        if (!(await unsnoozeSuggestion(s.id))) throw new Error('That card is not snoozed.');
        summary = `The ${label} card is back on Today now.`;
        break;
      }
      case 'done': {
        if (s.kind !== 'prep_brief')
          throw new Error(
            'Only a prep card is closed this way; other cards are sent, answered, snoozed or dismissed.',
          );
        if (!(await markPrepOpened(s.id, ctx.now))) throw new Error('That prep card is already closed.');
        summary = 'Prep card closed.';
        break;
      }
    }
    const fresh = (await db.suggestions.get(s.id))!;
    const out = await cardOut(fresh);
    return ok('suggestion', out, out, summary, s.personId ? `/people/${s.personId}` : '/today');
  },
  toModel,
});

const DISMISS_REASONS = ['already_did', 'not_now', 'wrong_person', 'bad_draft'] as const;

export const dismissSuggestionTool = defineTool({
  name: 'dismiss_suggestion',
  kind: 'risky',
  description:
    "Call this only when the student explicitly asks to dismiss, remove or drop a card, with a reason: already_did (they did it outside Orbit, which also moves the pipeline), not_now, wrong_person, or bad_draft (only when the card has a draft). The attached draft is cancelled. Needs the student's approval; manage_suggestion restore undoes it.",
  input: z.object({
    suggestionId: z.string().describe('The card id.'),
    reason: z.enum(DISMISS_REASONS).describe('Why: already_did, not_now, wrong_person or bad_draft.'),
  }),
  capabilities: ['card_dismiss'],
  progress: 'Removing the card',
  async summarizeIntent(input, ctx) {
    const s = await requireSuggestion(ctx, input.suggestionId);
    const person = s.personId ? await db.people.get(s.personId) : undefined;
    const label = SUGGESTION_KIND_LABELS[s.kind].label;
    const effect =
      input.reason === 'already_did' && s.chatId
        ? ' Orbit also records that you did it, so the chat moves on.'
        : s.outboundMessageId
          ? ' Its draft is cancelled.'
          : '';
    return {
      text: `Dismiss the ${label} card${person ? ` for ${person.displayName}` : ''} (${input.reason.replace(/_/g, ' ')}).${effect}`,
      blockedReason:
        s.status !== 'pending' && s.status !== 'snoozed'
          ? 'This card is no longer open.'
          : input.reason === 'bad_draft' && !s.outboundMessageId
            ? 'This card has no draft to call bad.'
            : undefined,
    };
  },
  async execute(input, ctx) {
    const s = await requireSuggestion(ctx, input.suggestionId);
    if (s.status !== 'pending' && s.status !== 'snoozed') throw new Error('This card is no longer open.');
    if (input.reason === 'bad_draft' && !s.outboundMessageId)
      throw new Error('This card has no draft to call bad.');
    const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
    const draftWas = draft?.status;
    await dismissSuggestion(ctx.user.id, s, input.reason);
    const fresh = (await db.suggestions.get(s.id))!;
    const out = {
      ...(await cardOut(fresh)),
      draftWas,
      undo: {
        tool: 'manage_suggestion',
        input: {
          suggestionId: s.id,
          action: 'restore',
          draftWas: draftWas === 'draft' || draftWas === 'failed' ? draftWas : undefined,
        },
      },
    };
    const summary =
      input.reason === 'already_did'
        ? 'Marked as done. Orbit will not offer it back.'
        : 'Card removed. Restore it with manage_suggestion if that was wrong.';
    return ok('suggestion', out, out, summary, '/today');
  },
  toModel,
});

export const answerStageQuestion = defineTool({
  name: 'answer_stage_question',
  kind: 'write',
  description:
    'Call this only when the student answers a "Did this change?" card: yes (the stage Orbit read from an email is right) or no, optionally with the stage it should be instead. Pass the card id from get_today_brief.',
  input: z.object({
    suggestionId: z.string().describe('The confirm_stage card id.'),
    accept: z.boolean().describe('true: the chat did move to the proposed stage. false: it did not.'),
    correction: z
      .enum(STAGES)
      .optional()
      .describe('With accept false: the stage the chat should be in instead.'),
  }),
  capabilities: ['card_confirm_stage_yes', 'card_confirm_stage_no'],
  progress: 'Updating the chat',
  async execute(input, ctx) {
    const s = await requireSuggestion(ctx, input.suggestionId);
    if (s.kind !== 'confirm_stage') throw new Error('That card is not a stage question.');
    const r = await decideProposedStage(s.payload.stageEventId as string, input.accept, input.correction);
    const chat = s.chatId ? await db.chats.get(s.chatId) : undefined;
    const person = s.personId ? await db.people.get(s.personId) : undefined;
    const first = person?.firstName ?? 'the chat';
    const to = s.payload.toStage as CoffeeChat['stage'] | undefined;
    const summary =
      r === 'none'
        ? 'That question was already answered.'
        : r === 'moved_on'
          ? `${first}'s chat had already moved on to ${chat ? STAGE_LABELS[chat.stage] : 'another stage'}, so nothing changed.`
          : input.accept
            ? `Moved ${first} to ${to ? STAGE_LABELS[to] : 'the new stage'}.`
            : `Kept ${first} in ${chat ? STAGE_LABELS[chat.stage] : 'the same stage'}.`;
    const out = {
      result: r,
      chat: chat ? { id: chat.id, stage: chat.stage, stageLabel: STAGE_LABELS[chat.stage] } : undefined,
      person: person ? personRef(person) : undefined,
    };
    return ok('suggestion', out, out, summary, person ? `/people/${person.id}` : '/today');
  },
  toModel,
});

export const mergePeopleTool = defineTool({
  name: 'merge_people',
  kind: 'risky',
  description:
    'Call this only when the student says two records are the same person and wants them merged. Takes the merge id from a "Possible duplicate" card (get_today_brief with the cardId shows both records and what they share). The older record survives; the other is deleted for good, so this needs the student\'s approval. To keep them as two people use reject_merge.',
  input: z.object({
    mergeId: z.string().describe('The merge id from the duplicate card.'),
    suggestionId: z.string().optional().describe('The card id, so it is closed too.'),
  }),
  capabilities: ['card_confirm_merge_accept'],
  progress: 'Merging the records',
  async summarizeIntent(input, ctx) {
    const m = await db.merges.get(input.mergeId);
    if (!m || m.userId !== ctx.user.id)
      return { text: 'Merge two records.', blockedReason: 'Orbit has no such possible duplicate.' };
    const [a, b] = await Promise.all([db.people.get(m.personAId), db.people.get(m.personBId)]);
    if (!a || !b)
      return { text: 'Merge two records.', blockedReason: 'One of the two records is gone already.' };
    const ev = mergeEvidence(a, b);
    return {
      text: `Merge ${b.displayName} into ${a.displayName}. They share ${ev.same.join(', ') || 'little'}${ev.differ.length ? ` but have ${ev.differ.join(' and ')}` : ''}. ${b.displayName}'s record is deleted and cannot be brought back.`,
      blockedReason: m.status !== 'pending' ? 'This duplicate was already decided.' : undefined,
    };
  },
  async execute(input, ctx) {
    const m = await db.merges.get(input.mergeId);
    if (!m || m.userId !== ctx.user.id) throw new Error('Orbit has no such possible duplicate.');
    if (m.status !== 'pending') throw new Error('This duplicate was already decided.');
    const a = await db.people.get(m.personAId);
    const r = await decideMerge(ctx.user.id, input.mergeId, true, {
      suggestionId: input.suggestionId,
      now: ctx.now,
    });
    if (r !== 'merged') throw new Error('The merge did not go through.');
    const survivor = await db.people.get(m.personAId);
    const out = { survivor: survivor ? personRef(survivor) : undefined, mergedId: m.personBId };
    return ok(
      'person',
      out,
      out,
      `Merged into ${survivor?.displayName ?? a?.displayName ?? 'one record'}.`,
      survivor ? `/people/${survivor.id}` : '/people',
    );
  },
  toModel,
});

export const rejectMerge = defineTool({
  name: 'reject_merge',
  kind: 'write',
  description:
    'Call this only when the student says two records Orbit flagged as a possible duplicate are different people. Orbit keeps both and never asks about the pair again.',
  input: z.object({
    mergeId: z.string().describe('The merge id from the duplicate card.'),
    suggestionId: z.string().optional().describe('The card id, so it is closed too.'),
  }),
  capabilities: ['card_confirm_merge_reject'],
  progress: 'Keeping both records',
  async execute(input, ctx) {
    const r = await decideMerge(ctx.user.id, input.mergeId, false, {
      suggestionId: input.suggestionId,
      now: ctx.now,
    });
    if (r === 'missing') throw new Error('Orbit has no such possible duplicate.');
    const out = { kept: true };
    return ok('suggestion', out, out, 'Kept as two people. Orbit will not ask again.', '/today');
  },
  toModel,
});

export const answerIntroQuestion = defineTool({
  name: 'answer_intro_question',
  kind: 'write',
  description:
    'Call this only when the student answers "Did X introduce you to Y?": yes records the introduction (a chat opens with X as the referrer, and a reply card appears), no is remembered for that email thread. Pass the card id, or the thread id from the card detail.',
  input: z.object({
    suggestionId: z.string().optional().describe('The confirm_intro card id.'),
    threadId: z.string().optional().describe('The email thread id, when there is no card.'),
    yes: z.boolean().describe('true: it was an introduction. false: it was not.'),
  }),
  capabilities: ['card_confirm_intro_yes', 'card_confirm_intro_no'],
  progress: 'Recording your answer',
  async execute(input, ctx) {
    let threadId = input.threadId;
    let introducer: string | undefined;
    if (input.suggestionId) {
      const s = await requireSuggestion(ctx, input.suggestionId);
      if (s.kind !== 'confirm_intro') throw new Error('That card is not an introduction question.');
      threadId = s.payload.threadId as string;
      introducer =
        typeof s.payload.introducerId === 'string'
          ? (await db.people.get(s.payload.introducerId))?.firstName
          : undefined;
    }
    if (!threadId) throw new Error('Say which card or thread this answers.');
    const opened = await answerIntroductionQuestion(ctx.user, threadId, input.yes, ctx.now);
    const out = { threadId, yes: input.yes, chatsOpened: opened };
    const summary = input.yes
      ? `Added to your pipeline, noting that ${introducer ?? 'they'} introduced you.`
      : 'Got it. Orbit will not ask about this thread again.';
    return ok('suggestion', out, out, summary, '/today');
  },
  toModel,
});

export const markWarmupStep = defineTool({
  name: 'mark_warmup_step',
  kind: 'write',
  description:
    'Call this only when the student says they did (or will skip) a LinkedIn warm-up step: viewed the profile, reacted to or commented on a post, followed them. Pass the chat and action ids from get_today_brief or get_person; with done, an optional note of what the post was about becomes the hook in the first message.',
  input: z.object({
    chatId: z.string().describe('The warm-up chat id.'),
    actionId: z.string().describe('The warm-up step id.'),
    done: z.boolean().describe('true: done. false: skipped.'),
    note: z
      .string()
      .optional()
      .describe('With done: what the post was about, in a few words (used in the first message).'),
  }),
  capabilities: ['card_warmup_done', 'card_warmup_skip'],
  progress: 'Logging the warm-up step',
  async execute(input, ctx) {
    const chat = await db.chats.get(input.chatId);
    if (!chat || chat.userId !== ctx.user.id || !chat.warmUp) throw new Error('That chat has no warm-up.');
    if (!chat.warmUp.actions.some((a) => a.id === input.actionId))
      throw new Error('That warm-up step is not on this chat.');
    await markWarmUpAction(
      ctx.user.id,
      input.chatId,
      input.actionId,
      input.done,
      input.done ? input.note : undefined,
    );
    const after = (await db.chats.get(input.chatId))!;
    const prog = warmUpProgress(after.warmUp!, ctx.now, ctx.user.timezone);
    const next = after.warmUp!.actions.find((a) => !a.doneAt && !a.skippedAt);
    const when = next
      ? new Date(next.dueAt) > ctx.now
        ? ` The next step is on Today on ${fmtDay(next.dueAt, ctx)}.`
        : ' The next step is on Today.'
      : prog.ready
        ? ' Your first message is ready on Today.'
        : ` Orbit suggests your first message from ${fmtDay(prog.readyFrom, ctx)}.`;
    const out = {
      chatId: after.id,
      done: prog.done,
      total: prog.total,
      ready: prog.ready,
      readyFrom: fmtDay(prog.readyFrom, ctx),
      nextStep: next
        ? { actionId: next.id, label: next.label, url: next.url, dueAt: fmtDay(next.dueAt, ctx) }
        : undefined,
    };
    const summary = `${input.done ? (input.note?.trim() ? 'Logged. Your first message will mention the post.' : 'Logged the warm-up step.') : 'Skipped.'}${when}`;
    return ok('suggestion', out, out, summary, `/people/${after.personId}`);
  },
  toModel,
});

export const completeActionItem = defineTool({
  name: 'complete_action_item',
  kind: 'write',
  description:
    'Call this only when the student says they kept a promise (sent the resume, made the intro they owed). Pass the action item id from get_person promises or a "Promise to keep" card; the card, if any, is closed too.',
  input: z.object({
    actionItemId: z.string().describe('The promise (action item) id.'),
    suggestionId: z.string().optional().describe('The reminder card id, if the student is answering a card.'),
  }),
  capabilities: ['card_action_item_done', 'person_promise_done'],
  progress: 'Ticking the promise',
  async execute(input, ctx) {
    const item = await db.actionItems.get(input.actionItemId);
    if (!item || item.userId !== ctx.user.id) throw new Error('Orbit has no promise with that id.');
    await markActionItemDone(item.id, input.suggestionId, ctx.now);
    const person = item.personId ? await requirePerson(ctx, item.personId).catch(() => undefined) : undefined;
    const out = { actionItemId: item.id, person: person ? personRef(person) : undefined };
    return ok('text', out, out, 'Marked done.', person ? `/people/${person.id}` : '/today');
  },
  toModel,
});

export const processOutbox = defineTool({
  name: 'process_outbox',
  kind: 'write',
  description:
    'Call this after a Gmail send was queued and its 60 second undo window has ended, or when the student asks whether a queued email went out. It sends every queued message whose window ended (the app does this itself every few seconds while open) and reports what was sent or failed.',
  input: z.object({}),
  capabilities: ['daily_maintenance_auto'],
  progress: 'Sending what is due',
  async execute(_input, ctx) {
    const results = await sendDueQueued(ctx.user, ctx.now);
    const sent = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const out = { sent, failed: failed.map((f) => ({ draftId: f.id, error: f.error })) };
    const summary = results.length
      ? `${plural(sent, 'message')} sent${failed.length ? `, ${plural(failed.length, 'failure')}: ${failed.map((f) => f.error).join(' ')}` : '.'}`
      : 'Nothing was due to send.';
    return ok('drafts', out, out, summary, '/inbox');
  },
  toModel,
});

export const todayTools: AnyTool[] = [
  refreshBrief,
  ensureCardDrafts,
  manageSuggestion,
  dismissSuggestionTool,
  answerStageQuestion,
  mergePeopleTool,
  rejectMerge,
  answerIntroQuestion,
  markWarmupStep,
  completeActionItem,
  processOutbox,
];
