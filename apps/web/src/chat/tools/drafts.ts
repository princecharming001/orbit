/** Drafts: create, edit, redraft, discard, send (through the same approval as the editor), undo, confirm. */
import type { MessageKind, OutboundMessage } from '@orbit/core';
import { CHANNEL_LABELS, MESSAGE_KIND_LABELS, relTime, WHY_THEM_GAP } from '@orbit/core';
import { runApproval } from '../../components/approve';
import { db } from '../../db/schema';
import { type DraftInputs, regenerateDraft } from '../../engine/brief';
import {
  composeDraft,
  discardDraft,
  nextMessageKind,
  requestIntro,
  resetDraftToSuggested,
  restoreDraft,
  setDraftText,
} from '../../engine/drafts';
import {
  approveAndSend,
  checkSendAllowed,
  confirmHandoff,
  draftEnvelope,
  googleSendActive,
  handoffLink,
  type PersonSnapshot,
  restorePerson,
  revertHandoff,
  reviewDraft,
  snapshotPerson,
  undoQueued,
} from '../../engine/send';
import { z } from '../../zod';
import type { ToolContext } from '../types';
import {
  type AnyTool,
  autoOpen,
  defineTool,
  draftRef,
  firstLine,
  fmtDay,
  fmtWhen,
  ok,
  personRef,
  requireDraft,
  requirePerson,
  toModel,
  wrapped,
} from './_shared';

const KINDS = Object.keys(MESSAGE_KIND_LABELS) as [MessageKind, ...MessageKind[]];

const inputsSchema = {
  connection: z
    .string()
    .optional()
    .describe(
      'The "why them" line: one thing only true of the recipient (how the student found them, what they share, what of theirs they read).',
    ),
  update: z.string().optional().describe('One real update since the last conversation (check-in).'),
  news: z.string().optional().describe('What the student is congratulating them on.'),
  target: z
    .string()
    .optional()
    .describe('Who the student wants an intro to: "Lucas Fischer, Engineering Manager at Ramp".'),
  answer: z.string().optional().describe("The student's answer to a question in the thread (reply)."),
  role: z.string().optional().describe('The role and company for a referral ask: "PM Intern at Notion".'),
  takeaway: z.string().optional().describe('One thing they said that stuck with the student (thank-you).'),
  posting: z.string().optional().describe('The link to the posting, for a referral ask.'),
  mutual: z.string().optional().describe('The name of the mutual tie a connection line mentions.'),
};

function pickInputs(input: Record<string, unknown>): DraftInputs {
  const out: DraftInputs = {};
  for (const k of Object.keys(inputsSchema) as (keyof DraftInputs)[]) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

async function draftOut(ctx: ToolContext, d: OutboundMessage) {
  const person = await db.people.get(d.personId);
  const body = d.bodyFinal ?? d.bodyDraft;
  return {
    ...draftRef(d, person ?? undefined),
    body,
    to: d.toEmail,
    needsInput: d.needsInput,
    holdUntil: fmtDay(d.holdUntil, ctx),
    generatedBy: d.generatedBy,
  };
}

export const createDraft = defineTool({
  name: 'create_draft',
  kind: 'write',
  description:
    'Call this when the student asks to write to someone, draft a message, follow up, send a thank-you, ask for a referral or an intro, or start a first message (also from Discover or the Map). Leave kind out and Orbit picks it from where the chat stands (and says when a message should wait). A draft already started for that kind is reopened, never duplicated. For a cold LinkedIn-only stranger the answer is a warm-up choice: call again with warmUp start or skip. For an intro request give targetPersonId (the person to be introduced to) and the connector as personId. Pass the lines only the student can supply (connection, update, role, target) when they gave them. When the result says the draft still needs a line, ask the student for it and call redraft_with_inputs. Nothing is sent: that is send_draft.',
  input: z.object({
    personId: z
      .string()
      .describe(
        'The recipient (from search_people). For an intro request, the person who would make the introduction.',
      ),
    kind: z
      .enum(KINDS)
      .optional()
      .describe(
        'The kind of message; leave out to let Orbit pick from the chat stage (outreach, bump, schedule, thank_you, nurture, congratulate, referral_ask, intro_request, reply, report_back).',
      ),
    targetPersonId: z
      .string()
      .optional()
      .describe('For intro_request: the person the student wants to be introduced to.'),
    warmUp: z
      .enum(['start', 'skip'])
      .optional()
      .describe(
        'For a cold LinkedIn-only contact, after the student chose: start the warm-up first, or skip it and write now.',
      ),
    ...inputsSchema,
  }),
  capabilities: [
    'person_write_to',
    'person_compose',
    'person_compose_kind_switch',
    'draft_start_message',
    'card_new_outreach_write',
    'map_write_directly',
    'discover_start',
    'map_ask_intro',
    'draft_map_ask_intro',
    'card_start_warmup',
    'today_write_to_added_person',
  ],
  progress: 'Writing the draft',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    if (person.hiddenAt)
      throw new Error(`${person.displayName} is hidden. Show them again before writing to them.`);
    const inputs = pickInputs(input);
    if (input.kind === 'intro_request' && input.targetPersonId) {
      const target = await requirePerson(ctx, input.targetPersonId);
      const r = await requestIntro(ctx.user, person.id, target.id, { now: ctx.now });
      if (!r?.draft) throw new Error(`Orbit could not draft an intro request to ${person.firstName}.`);
      const out = {
        ...(await draftOut(ctx, r.draft)),
        cardId: r.suggestion.id,
        reopened: r.existed,
        target: personRef(target),
      };
      return autoOpen(
        ok(
          'draft',
          out,
          out,
          `${r.existed ? 'You already asked' : 'Drafted an intro request to'} ${person.firstName} for an introduction to ${target.displayName}. Read it, then send it when you are happy.`,
          `/inbox?draft=${r.draft.id}`,
        ),
      );
    }
    let kind = input.kind;
    if (!kind) {
      const next = await nextMessageKind(ctx.user, person.id, ctx.now);
      if ('wait' in next) {
        const until = next.wait.until ? fmtDay(next.wait.until, ctx) : undefined;
        const text =
          next.wait.reason === 'away' && until
            ? `${person.firstName} is away. A follow-up fits from ${until}, once they have had a couple of days back, and Orbit will suggest it then.`
            : next.wait.reason === 'too_soon' && until
              ? `You wrote to ${person.firstName} ${relTime(next.wait.since, ctx.now)}. A follow-up fits from ${until}, and Orbit will suggest it then.`
              : `You wrote to ${person.firstName} ${relTime(next.wait.since, ctx.now)}. A check-in fits in a few weeks, and Orbit will suggest one.`;
        const out = { wait: { ...next.wait, until }, person: personRef(person) };
        return ok('text', out, out, `${text} Pass a kind to write anyway.`, `/people/${person.id}`);
      }
      kind = next.kind;
    }
    const r = await composeDraft(ctx.user, person.id, kind, {
      confirmed: !!input.warmUp,
      skipWarmUp: input.warmUp === 'skip',
    });
    if (r.kind === 'no_person') throw new Error('Orbit has no such person.');
    if (r.kind === 'warmup_choice') {
      const out = { choice: 'warmup' as const, person: personRef(person) };
      return ok(
        'text',
        out,
        out,
        `You only have ${person.firstName} on LinkedIn and have not talked yet. Cold messages get far more replies when your name is already familiar, so Orbit suggests a short warm-up first (a few LinkedIn steps over a few days, then the message). Ask the student: warm up first, or message now? Then call again with warmUp start or skip.`,
        `/people/${person.id}`,
      );
    }
    if (r.kind === 'warmup_started') {
      const out = {
        warmUpStarted: true,
        chatId: r.chat.id,
        person: personRef(person),
        steps: r.chat.warmUp?.actions.map((a) => ({
          actionId: a.id,
          label: a.label,
          url: a.url,
          dueAt: fmtDay(a.dueAt, ctx),
        })),
      };
      return ok(
        'text',
        out,
        out,
        `Warm-up started for ${person.firstName}. The first step is in Drafts; the first message is drafted when the warm-up is done.`,
        `/inbox?person=${person.id}`,
      );
    }
    let draft = r.draft;
    if (Object.keys(inputs).length && draft.status === 'draft') {
      const re = await regenerateDraft(ctx.user, draft.id, inputs, ctx.now);
      if (re) draft = re;
    }
    const out = {
      ...(await draftOut(ctx, draft)),
      reopened: r.reopened,
      askedKind: kind,
      pickedByOrbit: !input.kind,
    };
    const kindNote =
      draft.kind !== kind
        ? ` Orbit wrote a ${MESSAGE_KIND_LABELS[draft.kind].toLowerCase()} instead: that is what the thread calls for.`
        : '';
    const needs = draft.needsInput?.length
      ? ` It still needs a line only you can give: ${draft.needsInput.join(', ')}.`
      : '';
    return autoOpen(
      ok(
        'draft',
        out,
        out,
        `${r.reopened ? 'Reopened the' : 'Drafted a'} ${MESSAGE_KIND_LABELS[draft.kind].toLowerCase()} to ${person.firstName} (${CHANNEL_LABELS[draft.channel]}).${kindNote}${needs} Nothing is sent until approved.`,
        `/people/${person.id}?open=${draft.id}`,
      ),
    );
  },
  toModel,
});

export const updateDraftBody = defineTool({
  name: 'update_draft_body',
  kind: 'write',
  description:
    'Call this when the student asks to change a draft\'s wording or subject ("shorten it", "change the second sentence", "make the subject Quick question about Evercore"). Pass the full new body (the whole message as it should read) and/or the subject. Only a draft that has not been sent can change.',
  input: z.object({
    draftId: z.string().describe('The draft id.'),
    body: z.string().optional().describe('The whole message text as it should now read.'),
    subject: z.string().optional().describe('The subject line (new emails only).'),
  }),
  capabilities: ['draft_edit_text', 'draft_close_keep'],
  progress: 'Saving your edits',
  async execute(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    if (draft.status !== 'draft')
      throw new Error('This message is no longer a draft, so its text cannot change.');
    if (input.body === undefined && input.subject === undefined)
      throw new Error('Give the new body or subject.');
    if (input.body !== undefined && !input.body.trim()) throw new Error('The message cannot be empty.');
    const fresh = await setDraftText(draft.id, { body: input.body, subject: input.subject });
    if (!fresh) throw new Error('The draft could not be updated.');
    const issues = await reviewDraft(ctx.user, fresh, fresh.bodyFinal ?? fresh.bodyDraft, fresh.subject);
    const out = {
      ...(await draftOut(ctx, fresh)),
      issues: issues.map((i) => ({ code: i.code, text: i.text, blocking: i.blocking })),
    };
    const blocking = issues.filter((i) => i.blocking);
    return ok(
      'draft',
      out,
      out,
      `Saved your edits.${blocking.length ? ` Before sending, fix: ${blocking.map((i) => i.text).join(' ')}` : ''}`,
      `/inbox?draft=${fresh.id}`,
    );
  },
  toModel,
});

export const manageDraft = defineTool({
  name: 'manage_draft',
  kind: 'write',
  description:
    'Call this only when the student asks to reset a draft to Orbit\'s suggested text (dropping their edits), to restore a discarded draft, to bring a handed-off message back for editing ("the mail app did not open, let me edit it"), or to undo an "I sent it" that was wrong.',
  input: z.object({
    draftId: z.string().describe('The draft id.'),
    action: z
      .enum(['reset_to_suggested', 'restore', 'revert_handoff', 'undo_confirm_sent'])
      .describe(
        'reset_to_suggested: back to Orbit\'s text. restore: a discarded draft comes back. revert_handoff: a handed-off message becomes a draft again. undo_confirm_sent: take back "I sent it" (puts the person\'s chat and cards back as they were).',
      ),
  }),
  capabilities: [
    'draft_reset_to_suggested',
    'draft_undo_changes',
    'draft_revert_handoff',
    'draft_undo_confirm_sent',
  ],
  progress: 'Updating the draft',
  async execute(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    const person = await db.people.get(draft.personId);
    const name = person?.firstName ?? 'them';
    let summary: string;
    switch (input.action) {
      case 'reset_to_suggested':
        if (!(await resetDraftToSuggested(draft.id)))
          throw new Error('Only a draft that has not been sent can be reset.');
        summary = "Back to Orbit's text.";
        break;
      case 'restore':
        if (!(await restoreDraft(draft.id))) throw new Error('That draft is not discarded.');
        summary = 'The draft is back.';
        break;
      case 'revert_handoff':
        if (!(await revertHandoff(ctx.user, draft.id)))
          throw new Error('That message is not waiting for an I sent it.');
        summary = `The message to ${name} is a draft again; edit it and send it when ready.`;
        break;
      case 'undo_confirm_sent': {
        const rows = await db.chatActions
          .where('conversationId')
          .equals(ctx.conversationId)
          .filter(
            (a) =>
              a.toolName === 'confirm_handoff' &&
              a.status === 'done' &&
              (a.input as { draftId?: string })?.draftId === draft.id,
          )
          .toArray();
        const last = rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const snap = (last?.envelope?.data as { ui?: { snapshot?: PersonSnapshot } } | undefined)?.ui
          ?.snapshot;
        if (!snap)
          throw new Error(
            'Orbit has no record of that I sent it in this conversation, so it cannot take it back here.',
          );
        await restorePerson(ctx.user.id, snap);
        summary = `Not sent after all. The message to ${name} is waiting again.`;
        break;
      }
    }
    const fresh = (await db.outbound.get(draft.id)) ?? draft;
    const out = await draftOut(ctx, fresh);
    return ok('draft', out, out, summary, `/inbox?draft=${fresh.id}`);
  },
  toModel,
});

export const redraftWithInputs = defineTool({
  name: 'redraft_with_inputs',
  kind: 'write',
  description:
    'Call this when the student supplies the line a draft was missing (the "why them" connection, an update, the role for a referral ask, the person for an intro, their answer, a takeaway) and wants the draft rewritten with it. If the student edited the draft and it still holds the [Why them: ...] gap, only the gap is filled and their words stay. The connection line is kept as a fact for later drafts.',
  input: z.object({
    draftId: z.string().describe('The draft id.'),
    ...inputsSchema,
  }),
  capabilities: ['draft_redraft_with_inputs'],
  progress: 'Redrafting with your line',
  async execute(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    if (draft.status !== 'draft') throw new Error('Only a draft that has not been sent can be redrafted.');
    const inputs = pickInputs(input);
    if (!Object.keys(inputs).length)
      throw new Error(
        'Give at least one line: connection, update, news, target, answer, role, takeaway, posting or mutual.',
      );
    const mine =
      draft.bodyFinal && inputs.connection && WHY_THEM_GAP.test(draft.bodyFinal)
        ? draft.bodyFinal
        : undefined;
    const done = await regenerateDraft(ctx.user, draft.id, inputs, ctx.now, { mine });
    if (!done) throw new Error('Orbit could not redraft this message. The text is unchanged.');
    const fresh = (await db.outbound.get(draft.id)) ?? done;
    const out = { ...(await draftOut(ctx, fresh)), keptYourWords: !!mine };
    return autoOpen(
      ok(
        'draft',
        out,
        out,
        `${mine ? 'Added your line to your message.' : 'Redrafted with your line.'}${fresh.needsInput?.length ? ` It still needs: ${fresh.needsInput.join(', ')}.` : ''}`,
        `/inbox?draft=${fresh.id}`,
      ),
    );
  },
  toModel,
});

export const discardDraftTool = defineTool({
  name: 'discard_draft',
  kind: 'risky',
  description:
    "Call this only when the student asks to discard, throw away or delete a draft they started or a card's draft. The draft is cancelled (manage_draft restore brings it back). Needs the student's approval.",
  input: z.object({
    draftId: z.string().describe('The draft id.'),
  }),
  capabilities: ['person_discard_draft', 'draft_discard_started'],
  progress: 'Discarding the draft',
  async summarizeIntent(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    const p = await db.people.get(d.personId);
    return {
      text: `Discard the ${MESSAGE_KIND_LABELS[d.kind].toLowerCase()} to ${p?.displayName ?? 'them'}${d.bodyFinal ? ', including your edits' : ''}. It can be restored.`,
      blockedReason:
        d.status !== 'draft' ? 'Only a draft that has not been sent can be discarded.' : undefined,
    };
  },
  async execute(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    if (!(await discardDraft(d.id))) throw new Error('Only a draft that has not been sent can be discarded.');
    const out = {
      ...(await draftOut(ctx, (await db.outbound.get(d.id)) ?? d)),
      undo: { tool: 'manage_draft', input: { draftId: d.id, action: 'restore' } },
    };
    return ok('draft', out, out, 'Draft discarded. Ask me to restore it if that was wrong.', '/inbox');
  },
  toModel,
});

/** The approval card's words: recipient, channel, how it goes out, subject and first line. */
async function sendIntent(
  ctx: ToolContext,
  draft: OutboundMessage,
  body: string,
  subject: string | undefined,
  copy: boolean,
) {
  const person = await requirePerson(ctx, draft.personId);
  const [env, direct] = await Promise.all([draftEnvelope(draft), googleSendActive(ctx.user.id)]);
  const how =
    draft.channel === 'gmail'
      ? copy
        ? 'copied for you to paste into Gmail, then marked as waiting for your I sent it'
        : direct
          ? 'sent by Gmail after a 60 second undo window'
          : `opened in your mail app addressed to ${draft.toEmail ?? person.firstName}, then marked as waiting for your I sent it`
      : 'copied and opened on LinkedIn, then marked as waiting for your I sent it';
  const subj =
    draft.channel === 'gmail'
      ? env.threaded
        ? ` as a reply in your thread${env.subject ? ` "${env.subject}"` : ''}`
        : ` with the subject "${(subject ?? draft.subject ?? '').trim() || 'none yet'}"`
      : '';
  const text = `Send the ${MESSAGE_KIND_LABELS[draft.kind].toLowerCase()} to ${person.displayName}: ${how}${subj}. It starts: "${firstLine(body) ?? ''}"`;
  return { person, env, direct, text };
}

export const sendDraft = defineTool({
  name: 'send_draft',
  kind: 'risky',
  description:
    'Call this only when the student says to send, approve or hand off a specific draft ("send the follow-up to Priya", "ok send it"), to retry a failed send, or asks for the text to paste into Gmail themselves (via copy). It never sends on its own: it returns a confirmation the student approves in the card, and the approved text is bound by the engine. Email goes through Gmail (60 second undo) or opens in the mail app; LinkedIn messages are copied and opened on LinkedIn; both then wait for the student\'s "I sent it". A blocked send explains the engine\'s reason instead.',
  input: z.object({
    draftId: z.string().describe('The draft id.'),
    body: z
      .string()
      .optional()
      .describe(
        'The final text, when the student changed it in this conversation; default the draft as stored.',
      ),
    subject: z.string().optional().describe('The subject for a new email, when the student set one.'),
    via: z
      .enum(['copy'])
      .optional()
      .describe('copy: do not open anything, just hand the text to the student to paste into Gmail.'),
  }),
  capabilities: ['draft_approve_send', 'card_approve_send', 'draft_copy_text', 'draft_retry_failed'],
  progress: 'Preparing to send',
  async summarizeIntent(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    const body = ctx.edited?.body ?? input.body ?? draft.bodyFinal ?? draft.bodyDraft;
    const subject = ctx.edited?.subject ?? input.subject ?? draft.subject;
    const { text } = await sendIntent(ctx, draft, body, subject, input.via === 'copy');
    let blockedReason: string | undefined;
    if (!['draft', 'failed', 'cancelled'].includes(draft.status))
      blockedReason =
        draft.status === 'sent'
          ? 'This message was already sent.'
          : draft.status === 'handed_off'
            ? 'This message is waiting for you to confirm you sent it.'
            : 'This message is already being sent.';
    else if (!body.trim()) blockedReason = 'The message is empty.';
    else {
      const issues = await reviewDraft(ctx.user, draft, body, subject);
      const blocking = issues.find((i) => i.blocking);
      if (blocking) blockedReason = blocking.text;
      else {
        const allowed = await checkSendAllowed(
          ctx.user.id,
          draft.personId,
          draft.channel,
          draft.kind,
          ctx.now,
          { chatId: draft.chatId, excludeMessageId: draft.id },
        );
        if (!allowed.allowed) blockedReason = allowed.reason;
        else if (WHY_THEM_GAP.test(body))
          blockedReason = `The "Why them" line is still missing. Add it and redraft first.`;
      }
    }
    return { text, blockedReason };
  },
  async execute(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    const person = await requirePerson(ctx, draft.personId);
    const body = ctx.edited?.body ?? input.body ?? draft.bodyFinal ?? draft.bodyDraft;
    const subject = ctx.edited?.subject ?? input.subject ?? draft.subject;
    if (WHY_THEM_GAP.test(body))
      throw new Error('The "Why them" line is still missing. Redraft with it first.');
    const notes: string[] = [];
    let error: string | undefined;
    if (input.via === 'copy') {
      const r = await approveAndSend(ctx.user, draft.id, body, subject, ctx.now, { via: 'copy' });
      if (!r.ok) error = r.error;
    } else {
      // the same path as the editor: the engine re-validates, binds the approved text and queues or hands off
      error = await runApproval(
        ctx.user,
        draft,
        body,
        subject,
        {
          push: (t) => {
            notes.push(t.text);
            return notes.length;
          },
          dismiss: () => undefined,
        },
        person.firstName,
      );
    }
    if (error) throw new Error(error);
    const fresh = (await db.outbound.get(draft.id)) ?? draft;
    const link = fresh.status === 'handed_off' ? await handoffLink(ctx.user, fresh.id) : undefined;
    const out = {
      ...(await draftOut(ctx, fresh)),
      status: fresh.status,
      sendAt: fresh.sendAt,
      sendsAt: fmtWhen(fresh.sendAt, ctx),
      handoffVia: fresh.handoffVia,
      handoffUrl: link?.url,
      textToPaste: fresh.status === 'handed_off' ? body : undefined,
      subjectToPaste: fresh.status === 'handed_off' && fresh.channel === 'gmail' ? fresh.subject : undefined,
      notes,
      next:
        fresh.status === 'queued'
          ? { tool: 'undo_send', input: { draftId: fresh.id } }
          : fresh.status === 'handed_off'
            ? { tool: 'confirm_handoff', input: { draftId: fresh.id } }
            : undefined,
    };
    // The mailto summary already says it opened in the mail app, so drop the toast that only repeats that
    // (keep any other toast, e.g. the "browser blocked the tab" fallback).
    const extraNotes = notes.filter((n) => !/^opened in your mail app\.?$/i.test(n.trim())).join(' ');
    const summary =
      fresh.status === 'queued'
        ? `Sending to ${person.firstName} in 60 seconds through Gmail. Say undo to stop it; after that it is sent.`
        : fresh.status === 'sent'
          ? `Sent to ${person.firstName}.`
          : fresh.status === 'handed_off'
            ? fresh.handoffVia === 'copy'
              ? `The text is ready to paste into Gmail${fresh.subject ? ` with the subject "${fresh.subject}"` : ''}. Once it is sent, say so and Orbit logs it.`
              : fresh.channel === 'gmail'
                ? `Opened in the mail app addressed to ${person.firstName}. Once it is sent, say so and Orbit logs it.${extraNotes ? ` ${extraNotes}` : ''}`
                : `${notes.join(' ') || 'Copied and opened on LinkedIn.'} Once it is sent, say so and Orbit logs it.`
            : `The message is ${fresh.status}.`;
    return ok('draft', out, out, summary, `/inbox?draft=${fresh.id}`);
  },
  toModel,
});

export const undoSend = defineTool({
  name: 'undo_send',
  kind: 'risky',
  description:
    'Call this only when the student asks to stop or undo a Gmail send that is still inside its 60 second window ("undo, don\'t send that"). The message becomes a draft again. Too late once it went out. Needs the student\'s approval.',
  input: z.object({
    draftId: z.string().describe('The queued message id.'),
  }),
  capabilities: ['draft_undo_queued'],
  progress: 'Stopping the send',
  async summarizeIntent(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    const p = await db.people.get(d.personId);
    return {
      text: `Stop the email to ${p?.displayName ?? 'them'} before Gmail sends it. It goes back to a draft.`,
      blockedReason:
        d.status !== 'queued'
          ? d.status === 'sent'
            ? 'Too late, it already went out.'
            : 'This message is not waiting to be sent.'
          : undefined,
    };
  },
  async execute(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    const undone = await undoQueued(ctx.user, d.id);
    const fresh = (await db.outbound.get(d.id)) ?? d;
    const out = { ...(await draftOut(ctx, fresh)), undone };
    return ok(
      'draft',
      out,
      out,
      undone ? 'Not sent. The draft is back.' : 'Too late, it already went out.',
      `/inbox?draft=${d.id}`,
    );
  },
  toModel,
});

export const confirmHandoffTool = defineTool({
  name: 'confirm_handoff',
  kind: 'risky',
  description:
    'Call this only when the student says a message they opened in the mail app, copied for Gmail or pasted into LinkedIn really went out ("I sent it to Priya"). Orbit records it as sent: the touchpoint, the stage move, a booked time if it confirmed one, and the next cards. Needs the student\'s approval; manage_draft undo_confirm_sent takes it back.',
  input: z.object({
    draftId: z.string().describe('The handed-off message id.'),
  }),
  capabilities: ['draft_confirm_sent'],
  progress: 'Logging it as sent',
  async summarizeIntent(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    const p = await db.people.get(d.personId);
    return {
      text: `Record the ${MESSAGE_KIND_LABELS[d.kind].toLowerCase()} to ${p?.displayName ?? 'them'} as sent. Orbit logs the message, moves the chat on and plans the follow-up.`,
      blockedReason: d.status !== 'handed_off' ? 'This message is not waiting for confirmation.' : undefined,
    };
  },
  async execute(input, ctx) {
    const d = await requireDraft(ctx, input.draftId);
    const person = await requirePerson(ctx, d.personId);
    const snapshot = await snapshotPerson(ctx.user.id, d.personId);
    const r = await confirmHandoff(ctx.user, d.id, ctx.now);
    if (!r.ok) throw new Error(r.error);
    const fresh = (await db.outbound.get(d.id)) ?? d;
    const chat = fresh.chatId ? await db.chats.get(fresh.chatId) : undefined;
    const base = await draftOut(ctx, fresh);
    const model = {
      ...base,
      scheduledAt: fmtWhen(r.scheduledAt, ctx),
      chatStage: chat?.stage,
      undo: { tool: 'manage_draft', input: { draftId: d.id, action: 'undo_confirm_sent' } },
    };
    const ui = { ...model, snapshot };
    const summary = r.scheduledAt
      ? `Logged as sent. Your chat with ${person.firstName} is booked for ${fmtWhen(r.scheduledAt, ctx)}, under Coming up in Drafts.`
      : `Logged as sent to ${person.firstName}.`;
    return { kind: 'draft' as const, data: { ui, forModel: model }, summary, href: `/people/${person.id}` };
  },
  toModel,
});

export const draftTools: AnyTool[] = [
  createDraft,
  updateDraftBody,
  manageDraft,
  redraftWithInputs,
  discardDraftTool,
  sendDraft,
  undoSend,
  confirmHandoffTool,
];

export { wrapped };
