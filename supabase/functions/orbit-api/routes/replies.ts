/**
 * Replies (§8, plan 29 §B2.3):
 *   POST /replies/list                            → inbound replies to the user's outreach, newest first, last 30 days
 *   POST /replies/draft {messageId}               → {draft}: the answer in the user's voice (never for an unsubscribe)
 *   POST /replies/answer {draftId | messageId, answer} → {draft}: the student's one line answers what the reply asked
 *                                                   and the reply is drafted around it (never sent on its own)
 */
import { toServerDraft } from '../../_shared/compose/drafts.ts';
import { badRequest, json } from '../../_shared/http.ts';
import { answerReply, draftReply, listReplies } from '../../_shared/replies/replies.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, uuid } from './body.ts';

async function list(ctx: Ctx): Promise<Response> {
  return json(200, { replies: await listReplies(ctx.db, ctx.userId!, ctx.now()) });
}

async function draft(ctx: Ctx): Promise<Response> {
  const messageId = uuid(await body(ctx), 'messageId');
  const r = await draftReply(ctx.services(), ctx.userId!, messageId);
  return json(200, { draft: toServerDraft(r.draft) });
}

async function answer(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.answer !== 'string') throw badRequest('answer is required');
  const draftId = optUuid(b, 'draftId');
  const messageId = optUuid(b, 'messageId');
  if (!draftId && !messageId) throw badRequest('draftId or messageId is required');
  const r = await answerReply(ctx.services(), ctx.userId!, { draftId, messageId, answer: b.answer });
  return json(200, { draft: toServerDraft(r.draft) });
}

export const replyRoutes: Record<string, Route> = {
  '/replies/list': { method: 'POST', auth: true, run: list },
  '/replies/draft': { method: 'POST', auth: true, run: draft },
  '/replies/answer': { method: 'POST', auth: true, run: answer },
};
