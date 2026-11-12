/**
 * Drafts (§7, §8.5):
 *   POST /drafts/compose {personId, kind, goalId?, channel, replyToMessageId?}  → {draft}; channel gmail, linkedin,
 *                                                       instagram or x (plan 43: a tap to send; Instagram's `note`
 *                                                       when it will land in their requests)
 *   POST /drafts/approve {draftId, sendAt?, confirm?, body?, subject?, attachments?}
 *                                                    → {draft}; no sendAt = the next send window; LinkedIn needs
 *                                                       confirm: true and goes at once; due now = sent now; a body or
 *                                                       subject approves the student's words and keeps the edit
 *   POST /drafts/cancel {draftId}                      → {draft} (an approved send that has not gone out)
 *   POST /drafts/discard {draftId}                     → {draft}
 */
import type { DraftComposeRequest } from '@orbit/core/server/api';
import type { MessageKind } from '@orbit/core/types';
import { composeDraft } from '../../_shared/compose/compose.ts';
import { type DraftRow, loadDraft, toServerDraft } from '../../_shared/compose/drafts.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { parseIncomingFiles, setDraftFiles } from '../../_shared/sending/files.ts';
import { approveDraft, cancelDraft, discardDraft, instagramRequestNote } from '../../_shared/sending/send.ts';
import { isOffered, sourceIsOn } from '../../_shared/sources/states.ts';
import { lookupPersonEmail } from '../../_shared/sourcing/ondemand.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

const KINDS: readonly MessageKind[] = [
  'outreach',
  'bump',
  'schedule',
  'thank_you',
  'nurture',
  'congratulate',
  'referral_ask',
  'intro_request',
  'reply',
  'report_back',
  'first_touch',
  'warm_first_touch',
  'forwardable_blurb',
  'reengage',
];

async function compose(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const kind = b.kind as DraftComposeRequest['kind'];
  if (!KINDS.includes(kind)) throw badRequest('kind is not a message kind');
  if (b.channel !== 'gmail' && b.channel !== 'linkedin' && b.channel !== 'instagram' && b.channel !== 'x')
    throw badRequest('channel is gmail, linkedin, instagram or x');
  const s = ctx.services();
  const personId = uuid(b, 'personId');
  if (b.channel === 'instagram' || b.channel === 'x') return composeSocial(ctx, b.channel, kind, personId, b);
  // an email to someone Orbit has no address for: the student asked to email them, so the address is looked up now
  // (plan 35 C3), the free sources first; without one the draft is written all the same, as before
  if (b.channel === 'gmail' && kind !== 'reply') {
    const [p] = await ctx.db.sql<{ primary_email: string | null }>`
      select primary_email from orbit.people where id = ${personId}::uuid and user_id = ${ctx.userId!}::uuid`;
    if (p && !p.primary_email) await lookupPersonEmail(s, ctx.userId!, personId).catch(() => undefined);
  }
  const r = await composeDraft(s, {
    userId: ctx.userId!,
    personId,
    kind,
    channel: b.channel,
    goalId: optUuid(b, 'goalId') ?? null,
    replyToMessageId: optUuid(b, 'replyToMessageId'),
  });
  return json(200, { draft: toServerDraft(r.draft) });
}

/**
 * An Instagram or X draft (plan 43 §4, §5 "Sending"): written as a short chat message, the way a LinkedIn one is, then
 * put on that channel, in the chat the student has with them when there is one. On Instagram, when they do not follow
 * the student, the draft carries the note that it lands in their requests. Sending it always takes the student's tap.
 * A source not offered or off for the student is 404 or 409.
 */
async function composeSocial(
  ctx: Ctx,
  channel: 'instagram' | 'x',
  kind: DraftComposeRequest['kind'],
  personId: string,
  b: Record<string, unknown>,
): Promise<Response> {
  const userId = ctx.userId!;
  const name = channel === 'x' ? 'X' : 'Instagram';
  const env = channel === 'x' && ctx.env.x?.offered ? [...ctx.offered, 'x' as const] : ctx.offered;
  if (!(await isOffered(ctx.db, channel, env))) throw new HttpError(404, 'not_found', 'not found');
  if (!(await sourceIsOn(ctx.db, userId, channel, env)))
    throw new HttpError(409, 'source_off', `${name} is off. Turn it on in Settings first.`);
  const [acct] = await ctx.db.sql<{ status: string }>`
    select status from orbit.integration_accounts where user_id = ${userId}::uuid and provider = ${channel}`;
  if (acct?.status !== 'active') throw new HttpError(409, 'not_connected', `${name} is not connected`);
  const r = await composeDraft(ctx.services(), {
    userId,
    personId,
    kind,
    channel: 'linkedin',
    goalId: optUuid(b, 'goalId') ?? null,
    replyToMessageId: optUuid(b, 'replyToMessageId'),
  });
  const [t] = await ctx.db.sql<{ external_id: string }>`
    select external_id from orbit.threads
     where user_id = ${userId}::uuid and provider = ${channel} and participant_count <= 1
       and ${personId}::uuid = any(participant_person_ids)
     order by last_at desc nulls last limit 1`;
  const note = channel === 'instagram' ? await instagramRequestNote(ctx.db, userId, personId) : null;
  const [row] = await ctx.db.sql<DraftRow>`
    update orbit.drafts
       set channel = ${channel}, subject = null, thread_external_id = ${t?.external_id ?? null},
           ask = coalesce(ask, '{}'::jsonb) || ${{ channel, ...(note ? { note } : {}) }}::jsonb
     where id = ${r.draft.id}::uuid
    returning *`;
  return json(200, { draft: toServerDraft(row ?? r.draft) });
}

async function approve(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const draftId = uuid(b, 'draftId');
  // files the student attached (a resume): kept and listed on the draft before it is approved, since approving a
  // draft that is due now sends it
  const files = parseIncomingFiles(b.attachments);
  if (files) {
    await loadDraft(ctx.db, ctx.userId!, draftId);
    await setDraftFiles(ctx.db, ctx.userId!, draftId, files);
  }
  const draft = await approveDraft(ctx.services(), ctx.userId!, {
    draftId,
    sendAt: typeof b.sendAt === 'string' ? b.sendAt : undefined,
    confirm: b.confirm === true,
    ...(typeof b.undoSec === 'number' ? { undoSec: b.undoSec } : {}),
    // the words as the student left them (plan 29 §B2.4)
    ...(b.body !== undefined ? { body: b.body as string } : {}),
    ...(b.subject !== undefined ? { subject: b.subject as string | null } : {}),
  });
  return json(200, { draft });
}

async function cancel(ctx: Ctx): Promise<Response> {
  return json(200, { draft: await cancelDraft(ctx.db, ctx.userId!, uuid(await body(ctx), 'draftId')) });
}

async function discard(ctx: Ctx): Promise<Response> {
  return json(200, { draft: await discardDraft(ctx.db, ctx.userId!, uuid(await body(ctx), 'draftId')) });
}

export const draftRoutes: Record<string, Route> = {
  '/drafts/compose': { method: 'POST', auth: true, run: compose },
  '/drafts/approve': { method: 'POST', auth: true, run: approve },
  '/drafts/cancel': { method: 'POST', auth: true, run: cancel },
  '/drafts/discard': { method: 'POST', auth: true, run: discard },
};
