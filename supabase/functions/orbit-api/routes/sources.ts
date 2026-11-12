/**
 * The student's optional sources (plan 43 §3.1):
 *   GET /sources                      → {offered, states}: the sources the owner offers (ORBIT_EXTRA_SOURCES) and,
 *                                       for each, the student's state, when it went off and whether friends may
 *                                       find paths through who they follow
 *   PUT /sources/:source {state: 'on'|'off'|'removed', shareFollows?}
 *                                     → {ok: true, state}: a source not offered is 404; shareFollows is refused for X
 *                                       (X's rules limit passing its data on). Off pauses drafts on that channel,
 *                                       removed deletes what the source brought (sources/switch.ts), and every change
 *                                       queues the switch job and is in the audit log.
 */

import type { SourceStateView, SourcesResponse } from '@orbit/core/server/api';
import { OPTIONAL_SOURCES, type OptionalSource } from '@orbit/core/sources';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { iso } from '../../_shared/rows.ts';
import { type SwitchState, switchSource } from '../../_shared/sources/switch.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

async function list(ctx: Ctx): Promise<Response> {
  const rows = ctx.offered.length
    ? await ctx.db.sql<{ source: string; state: string; off_since: Date | null; share_follows: boolean }>`
        select source, state, off_since, share_follows from orbit.source_states
         where user_id = ${ctx.userId!}::uuid and source = any(${ctx.offered}::text[])`
    : [];
  const states: SourcesResponse['states'] = {};
  for (const s of ctx.offered) {
    const r = rows.find((x) => x.source === s);
    states[s] = {
      state: (r?.state ?? 'not_connected') as SourceStateView['state'],
      ...(r?.off_since ? { offSince: iso(r.off_since)! } : {}),
      shareFollows: !!r?.share_follows,
    };
  }
  const out: SourcesResponse = { offered: [...ctx.offered], states };
  return json(200, out);
}

const STATES: readonly SwitchState[] = ['on', 'off', 'removed'];

async function put(ctx: Ctx, raw: string): Promise<Response> {
  const source = raw.toLowerCase() as OptionalSource;
  if (!(OPTIONAL_SOURCES as readonly string[]).includes(source) || !ctx.offered.includes(source))
    throw new HttpError(404, 'not_found', 'no such source');
  const b = await body(ctx);
  if (typeof b.state !== 'string' || !STATES.includes(b.state as SwitchState))
    throw badRequest('state is on, off or removed');
  if (b.shareFollows !== undefined && typeof b.shareFollows !== 'boolean')
    throw badRequest('shareFollows is true or false');
  if (source === 'x' && b.shareFollows === true)
    throw badRequest("who you follow on X cannot be shared with friends: X's rules do not allow it");
  if (source === 'imessage' && b.shareFollows === true)
    throw badRequest('texts have no follow list to share');
  const r = await switchSource(
    ctx.db,
    sqlQueue(ctx.db),
    ctx.userId!,
    source,
    { state: b.state as SwitchState, shareFollows: b.shareFollows as boolean | undefined },
    ctx.now(),
  );
  return json(200, { ok: true, state: r.state });
}

export const sourcesRoutes: Record<string, Route> = {
  '/sources': { method: 'GET', auth: true, run: list },
};

/** PUT /sources/:source, matched by pattern like the friend routes with an id in the path. */
export function sourcesPatternRoute(path: string): Route | undefined {
  const m = /^\/sources\/([a-z]{1,20})$/i.exec(path);
  if (!m) return undefined;
  return { method: 'PUT', auth: true, run: (ctx) => put(ctx, m[1]!) };
}
