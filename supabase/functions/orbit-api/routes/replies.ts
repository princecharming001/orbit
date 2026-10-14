/**
 * Replies (§8):
 *   POST /replies/list                → inbound replies to the user's outreach, newest first, last 30 days
 *   POST /replies/draft {messageId}   → {draft}: the answer in the user's voice (never for an unsubscribe)
 */
import { toServerDraft } from '../../_shared/compose/drafts.ts';
import { json } from '../../_shared/http.ts';
import { draftReply, listReplies } from '../../_shared/replies/replies.ts';
import type { Ctx, Route } from '../api.ts';
import { body, uuid } from './body.ts';

async function list(ctx: Ctx): Promise<Response> {
  return json(200, { replies: await listReplies(ctx.db, ctx.userId!, ctx.now()) });
}

async function draft(ctx: Ctx): Promise<Response> {
  const messageId = uuid(await body(ctx), 'messageId');
  const r = await draftReply(ctx.services(), ctx.userId!, messageId);
  return json(200, { draft: toServerDraft(r.draft) });
}

export const replyRoutes: Record<string, Route> = {
  '/replies/list': { method: 'POST', auth: true, run: list },
  '/replies/draft': { method: 'POST', auth: true, run: draft },
};
