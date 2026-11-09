/**
 * The whole inbox (§8):
 *   POST /inbox/list {channel?, days?, limit?, unreadOnly?, query?, includeAutomated?} → InboxListResponse
 * Email is read live from Gmail when Google is connected with gmail.readonly; LinkedIn from what the sync stored.
 */
import type { InboxListRequest } from '@orbit/core/server/api';
import { gmailApi } from '../../_shared/gmail.ts';
import { googleClient } from '../../_shared/googleApi.ts';
import { json } from '../../_shared/http.ts';
import { listInbox } from '../../_shared/inbox/inbox.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

async function list(ctx: Ctx): Promise<Response> {
  const b = (await body(ctx, true)) as InboxListRequest;
  const userId = ctx.userId!;
  const [g] = await ctx.db.sql<{ status: string; scopes: string[] | null }>`
    select status, scopes from orbit.integration_accounts where user_id = ${userId}::uuid and provider = 'google'`;
  const canRead = g?.status === 'active' && (g.scopes ?? []).some((s) => s.endsWith('gmail.readonly'));
  let gmail: ReturnType<typeof gmailApi> | undefined;
  if (canRead) {
    const s = ctx.services();
    if (s.tokens) gmail = gmailApi(googleClient({ tokens: s.tokens, db: ctx.db, fetch: s.fetch }), userId);
  }
  const out = await listInbox({ db: ctx.db, gmail, now: ctx.now() }, userId, b);
  // Google wants a new sign-in: say so, the same as the sync does
  if (g?.status === 'needs_reauth') out.email = 'needs_reauth';
  return json(200, out);
}

export const inboxRoutes: Record<string, Route> = {
  '/inbox/list': { method: 'POST', auth: true, run: list },
};
