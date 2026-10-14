/**
 * Drafts (§7, §8.5):
 *   POST /drafts/compose {personId, kind, goalId?, channel, replyToMessageId?}  → {draft}
 *   POST /drafts/approve {draftId, sendAt?, confirm?}  → {draft}; no sendAt = the next send window; LinkedIn needs
 *                                                       confirm: true and goes at once; due now = sent now
 *   POST /drafts/cancel {draftId}                      → {draft} (an approved send that has not gone out)
 *   POST /drafts/discard {draftId}                     → {draft}
 */
import type { DraftComposeRequest } from '@orbit/core/server/api';
import type { MessageKind } from '@orbit/core/types';
import { composeDraft } from '../../_shared/compose/compose.ts';
import { toServerDraft } from '../../_shared/compose/drafts.ts';
import { badRequest, json } from '../../_shared/http.ts';
import { approveDraft, cancelDraft, discardDraft } from '../../_shared/sending/send.ts';
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
  if (b.channel !== 'gmail' && b.channel !== 'linkedin') throw badRequest('channel is gmail or linkedin');
  const r = await composeDraft(ctx.services(), {
    userId: ctx.userId!,
    personId: uuid(b, 'personId'),
    kind,
    channel: b.channel,
    goalId: optUuid(b, 'goalId') ?? null,
    replyToMessageId: optUuid(b, 'replyToMessageId'),
  });
  return json(200, { draft: toServerDraft(r.draft) });
}

async function approve(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const draft = await approveDraft(ctx.services(), ctx.userId!, {
    draftId: uuid(b, 'draftId'),
    sendAt: typeof b.sendAt === 'string' ? b.sendAt : undefined,
    confirm: b.confirm === true,
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
