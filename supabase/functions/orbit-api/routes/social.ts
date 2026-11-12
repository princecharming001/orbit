/**
 * Instagram and the social accounts layer (plan 43 §3.4, §3.6, §4):
 *
 *   POST   /instagram/connect/start {replace?}   → {url}: Unipile's hosted sign-in for Instagram (notify_url names the
 *                                                provider). With {replace: true} while a different account is held,
 *                                                the old account's rows are removed and the new one read: {replaced}
 *   GET    /instagram/status                    → {status, username?, steps: {profile, chats, following, followers}}
 *                                                status: not_connected | connecting | active | needs_reauth | parked |
 *                                                different_account | error; each step done | reading | waiting
 *   POST   /instagram/disconnect                → {ok}: the account is released at Unipile; what was read is kept
 *   POST   /social/links {platform, accountId, personId}   → {linkId}: the student says the account is this person;
 *                                                409 {error, people} when the account's own person has things of its
 *                                                own and the student must pick
 *   DELETE /social/links/:id                    → {ok, accountPersonId}: "Not their account"
 *   GET    /social/asks                         → {asks}: open "is this the same person" questions
 *   POST   /social/asks/:id {answer: yes | no}  → {status}
 *   POST   /social/lookups {platform, personId} → {lookupId, status}: who could introduce the student to them
 *   POST   /social/lookups {platform: 'x', personId}
 *                                               → {status: 'quote', quoteUsd, list, size, reason?}: on X the price
 *                                                comes first (plan 43 §5), nothing read but the target's profile
 *   POST   /social/lookups {platform: 'x', personId, confirm: true, quoteUsd?}
 *                                               → {lookupId, status, quoteUsd}: the check runs under that price and is
 *                                                never charged more; 409 quote_first without a quote in the last 15
 *                                                minutes, or with the quote's reason when nothing can be read
 *   GET    /social/lookups/:id                  → {status, result}
 *
 * A platform the owner does not offer (`offeredNow`: ORBIT_EXTRA_SOURCES with the launch switches) is not there:
 * its routes answer 404 (disconnect excepted, so a student can always let go of an account).
 */
import type { SocialPlatform } from '@orbit/core/entity/social';
import { HttpError, json, unconfigured } from '../../_shared/http.ts';
import { deleteUnipileAccount, getUnipileAccount } from '../../_shared/providers/unipileAccounts.ts';
import { createUnipileSync } from '../../_shared/providers/unipileSync.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { resolveSecret } from '../../_shared/secrets.ts';
import { patchSocialState, type SocialSyncState } from '../../_shared/social/firstDays.ts';
import { answerAsk, attachAccount, detachLink } from '../../_shared/social/links.ts';
import { startLookup } from '../../_shared/social/lookup.ts';
import { removeSocialRows } from '../../_shared/social/remove.ts';
import { xSetupMissing } from '../../_shared/social/x/client.ts';
import { X_NOT_SET_UP } from '../../_shared/social/x/config.ts';
import { confirmXLookup, quoteXLookup } from '../../_shared/social/x/lookup.ts';
import { isOffered, offeredNow, sourceIsOn } from '../../_shared/sources/states.ts';
import type { Ctx, Route } from '../api.ts';
import { body, uuid } from './body.ts';
import { functionsBase } from './integrations.ts';

const isPlatform = (v: unknown): v is SocialPlatform => v === 'instagram' || v === 'x';

/** The env list the owner's switch starts from: ORBIT_EXTRA_SOURCES, and X's own reading of it. */
const envList = (ctx: Ctx) =>
  ctx.env.x?.offered && !ctx.offered.includes('x') ? [...ctx.offered, 'x' as const] : ctx.offered;

/** A platform not offered right now is not there (plan 43 §3.1). */
async function mustBeOffered(ctx: Ctx, platform: SocialPlatform): Promise<void> {
  if (!(await isOffered(ctx.db, platform, envList(ctx)))) throw new HttpError(404, 'not_found', 'not found');
}

type IgRow = {
  status: string;
  external_account_id: string | null;
  social_account_id: string | null;
  last_error: string | null;
  sync_state: { instagram?: SocialSyncState } | null;
};

async function instagramRow(ctx: Ctx): Promise<IgRow | undefined> {
  const [r] = await ctx.db.sql<IgRow>`
    select status, external_account_id, social_account_id, last_error, sync_state from orbit.integration_accounts
     where user_id = ${ctx.userId!}::uuid and provider = 'instagram'`;
  return r;
}

const held = (r: IgRow | undefined) => r?.status === 'error' && r.last_error === 'different_account';

async function connectStart(ctx: Ctx): Promise<Response> {
  await mustBeOffered(ctx, 'instagram');
  const b = await body(ctx, true);
  const replace = b.replace === true;
  const userId = ctx.userId!;
  const row = await instagramRow(ctx);
  // a different account is waiting for the student's word: replace the old one now
  if (replace && held(row) && row?.external_account_id) {
    await removeSocialRows(ctx.db, userId, 'instagram', { ownAccountId: row.social_account_id });
    await ctx.db.sql`
      update orbit.integration_accounts set status = 'active', last_error = null, social_account_id = null
       where user_id = ${userId}::uuid and provider = 'instagram'`;
    await patchSocialState(ctx.db, userId, 'instagram', { stage: 'profile', replace: false, pending: null });
    await ctx.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table) values (${userId}::uuid, 'user', 'instagram.replaced', 'integration_accounts')`;
    await sqlQueue(ctx.db).enqueue({
      kind: 'sync.instagram',
      userId,
      payload: {},
      dedupeKey: `sync.instagram:${userId}:${row.external_account_id}:replaced:${ctx.now().toISOString()}`,
    });
    return json(200, { replaced: true });
  }
  const missing = [
    ...(ctx.env.unipileKey ? [] : ['UNIPILE_API_KEY']),
    ...(ctx.env.unipileBase ? [] : ['UNIPILE_BASE_URL']),
  ];
  const secret = await resolveSecret(
    (name) => (name === 'ORBIT_UNIPILE_WEBHOOK_SECRET' ? ctx.env.unipileWebhookSecret : undefined),
    ctx.db,
    'ORBIT_UNIPILE_WEBHOOK_SECRET',
    'orbit_unipile_webhook_secret',
  );
  if (!secret) missing.push('ORBIT_UNIPILE_WEBHOOK_SECRET');
  if (missing.length) return unconfigured({}, missing);
  const r = await createUnipileSync({
    fetch: ctx.fetch,
    apiKey: ctx.env.unipileKey,
    baseUrl: ctx.env.unipileBase,
  }).hostedLink({
    name: userId,
    provider: 'INSTAGRAM',
    notifyUrl: `${functionsBase(ctx)}/orbit-webhooks/unipile/account?token=${encodeURIComponent(secret!)}&provider=instagram`,
    successRedirectUrl: `${ctx.env.appUrl}/settings?instagram=connected`,
    failureRedirectUrl: `${ctx.env.appUrl}/settings?instagram=failed`,
    expiresOn: new Date(ctx.now().getTime() + 3_600_000).toISOString(),
  });
  if (!r.ok) throw new HttpError(502, 'upstream', 'Instagram sign-in is unavailable right now');
  await ctx.db.sql`
    insert into orbit.integration_accounts (user_id, provider, status)
    values (${userId}::uuid, 'instagram', 'connecting')
    on conflict (user_id, provider) do update set
      status = case when orbit.integration_accounts.status in ('active', 'parked', 'needs_reauth', 'error')
                    then orbit.integration_accounts.status else 'connecting' end`;
  await patchSocialState(ctx.db, userId, 'instagram', { replace });
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, details)
    values (${userId}::uuid, 'user', 'instagram.connect_start', 'integration_accounts', ${{ replace }}::jsonb)`;
  return json(200, { url: r.value.url });
}

type Step = 'done' | 'reading' | 'waiting';
const ORDER = ['profile', 'chats', 'following', 'followers', 'refresh'] as const;

async function status(ctx: Ctx): Promise<Response> {
  await mustBeOffered(ctx, 'instagram');
  const row = await instagramRow(ctx);
  const state = row?.sync_state?.instagram ?? {};
  const s = !row
    ? 'not_connected'
    : held(row)
      ? 'different_account'
      : row.status === 'revoked'
        ? 'not_connected'
        : ['active', 'connecting', 'needs_reauth', 'parked', 'error'].includes(row.status)
          ? row.status
          : 'error';
  let username: string | undefined;
  if (held(row)) username = state.pending?.username;
  else if (row?.social_account_id) {
    const [a] = await ctx.db.sql<{ username: string }>`
      select username from orbit.social_accounts where platform = 'instagram' and account_id = ${row.social_account_id}`;
    username = a?.username;
  }
  const at = row?.external_account_id
    ? ORDER.indexOf((state.stage ?? 'profile') as (typeof ORDER)[number])
    : -1;
  const step = (i: number): Step => (at < 0 ? 'waiting' : at > i ? 'done' : at === i ? 'reading' : 'waiting');
  return json(200, {
    status: s,
    ...(username ? { username } : {}),
    steps: { profile: step(0), chats: step(1), following: step(2), followers: step(3) },
  });
}

async function disconnect(ctx: Ctx): Promise<Response> {
  await body(ctx, true);
  const userId = ctx.userId!;
  const row = await instagramRow(ctx);
  if (!row) return json(200, { ok: true });
  const id = row.external_account_id;
  if (id && ctx.env.unipileKey && ctx.env.unipileBase) {
    const opts = { fetch: ctx.fetch, apiKey: ctx.env.unipileKey, baseUrl: ctx.env.unipileBase };
    // only an Instagram account Orbit named for this student is ever released
    const one = await getUnipileAccount(opts, id);
    if (
      one.ok &&
      one.value &&
      (one.value.type ?? '').toUpperCase() === 'INSTAGRAM' &&
      (one.value.name ?? '').toLowerCase() === userId.toLowerCase()
    )
      await deleteUnipileAccount(opts, id);
  }
  await ctx.db.sql`
    update orbit.integration_accounts set status = 'revoked', external_account_id = null, last_error = null
     where user_id = ${userId}::uuid and provider = 'instagram'`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table) values (${userId}::uuid, 'user', 'instagram.disconnect', 'integration_accounts')`;
  return json(200, { ok: true });
}

async function peopleOf(ctx: Ctx, ids: string[]) {
  return ctx.db.sql<{ id: string; name: string }>`
    select id, display_name as name from orbit.people where id = any(${ids}::uuid[]) and user_id = ${ctx.userId!}::uuid`;
}

async function attach(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (!isPlatform(b.platform)) throw new HttpError(400, 'bad_request', 'platform is instagram or x');
  await mustBeOffered(ctx, b.platform);
  if (typeof b.accountId !== 'string' || !/^[\w.:-]{1,64}$/.test(b.accountId))
    throw new HttpError(400, 'bad_request', 'accountId is the platform id of the account');
  const personId = uuid(b, 'personId');
  // X accounts are tied to a real person only from public proof (plan 43 §5)
  if (b.platform === 'x')
    throw new HttpError(403, 'public_proof_only', 'An X account is attached only from public proof');
  const r = await attachAccount(ctx.db, ctx.userId!, {
    platform: b.platform,
    accountId: b.accountId,
    personId,
    via: 'student',
    now: ctx.now(),
  });
  if (r.status === 'no_person') throw new HttpError(404, 'not_found', 'no such person');
  if (r.status === 'linked_elsewhere')
    throw new HttpError(
      409,
      'linked_elsewhere',
      'That account is attached to someone else. Detach it first.',
    );
  if (r.status === 'conflict')
    return json(409, {
      error: {
        code: 'pick_person',
        message: 'Both have things of their own. Pick which one stays. This cannot be undone.',
      },
      people: await peopleOf(ctx, [r.accountPersonId, r.personId]),
    });
  return json(200, { linkId: r.linkId });
}

async function detach(ctx: Ctx, id: string): Promise<Response> {
  const r = await detachLink(ctx.db, ctx.userId!, id, ctx.now());
  if (!r) throw new HttpError(404, 'not_found', 'no such link');
  return json(200, { ok: true, ...r });
}

async function asks(ctx: Ctx): Promise<Response> {
  const offered = await offeredNow(ctx.db, envList(ctx));
  const rows = await ctx.db.sql<{
    id: string;
    platform: string;
    account_id: string;
    username: string | null;
    name: string | null;
    person_id: string;
    person_name: string;
    score: number;
    signals: Record<string, unknown>;
  }>`
    select k.id, k.platform, k.account_id, a.username, a.name, k.person_id, p.display_name as person_name, k.score,
           k.signals
      from orbit.social_match_asks k
      join orbit.people p on p.id = k.person_id and p.deleted_at is null
      left join orbit.social_accounts a on a.platform = k.platform and a.account_id = k.account_id
     where k.user_id = ${ctx.userId!}::uuid and k.status = 'open' and k.platform = any(${offered}::text[])
     order by k.score desc, k.created_at limit 50`;
  return json(200, {
    asks: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      accountId: r.account_id,
      username: r.username,
      name: r.name,
      personId: r.person_id,
      personName: r.person_name,
      score: Number(r.score),
      signals: r.signals,
    })),
  });
}

async function answer(ctx: Ctx, id: string): Promise<Response> {
  const b = await body(ctx);
  if (b.answer !== 'yes' && b.answer !== 'no') throw new HttpError(400, 'bad_request', 'answer is yes or no');
  const r = await answerAsk(ctx.db, ctx.userId!, id, b.answer, ctx.now());
  if (r.status === 'not_found' || r.status === 'no_person')
    throw new HttpError(404, 'not_found', 'no such question');
  if (r.status === 'conflict')
    return json(409, {
      error: {
        code: 'pick_person',
        message: 'Both have things of their own. Pick which one stays. This cannot be undone.',
      },
      people: await peopleOf(ctx, [r.accountPersonId, r.personId]),
    });
  if (r.status === 'linked_elsewhere')
    throw new HttpError(409, 'linked_elsewhere', 'That account is attached to someone else.');
  return json(200, { status: r.status === 'no' ? 'no' : 'yes' });
}

async function lookupStart(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (!isPlatform(b.platform)) throw new HttpError(400, 'bad_request', 'platform is instagram or x');
  await mustBeOffered(ctx, b.platform);
  const personId = uuid(b, 'personId');
  if (b.platform === 'x') return xLookup(ctx, personId, b);
  const r = await startLookup(ctx.db, sqlQueue(ctx.db), ctx.userId!, b.platform, personId, envList(ctx));
  return json(200, r);
}

/** X: the price first; then, on the student's yes, the check under it (plan 43 §5). */
async function xLookup(ctx: Ctx, personId: string, b: Record<string, unknown>): Promise<Response> {
  const userId = ctx.userId!;
  const cfg = ctx.env.x;
  const missing = await xSetupMissing(ctx.db, cfg);
  if (missing.length || !cfg)
    return json(
      503,
      { error: { code: 'unconfigured', message: X_NOT_SET_UP, missing } },
      { 'x-orbit-connector': 'unconfigured' },
    );
  if (!(await sourceIsOn(ctx.db, userId, 'x', envList(ctx))))
    throw new HttpError(409, 'source_off', 'X is not on');
  const [p] = await ctx.db.sql`
    select 1 from orbit.people where id = ${personId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  if (b.confirm === true) {
    const r = await confirmXLookup(ctx.db, sqlQueue(ctx.db), userId, personId, {
      now: ctx.now(),
      ...(typeof b.quoteUsd === 'number' ? { quoteUsd: b.quoteUsd } : {}),
    });
    return json(200, r);
  }
  return json(200, await quoteXLookup(ctx.db, userId, personId, { cfg, fetch: ctx.fetch, now: ctx.now }));
}

async function lookupGet(ctx: Ctx, id: string): Promise<Response> {
  const [l] = await ctx.db.sql<{ status: string; result: unknown }>`
    select status, result from orbit.social_lookups where id = ${id}::uuid and user_id = ${ctx.userId!}::uuid`;
  if (!l) throw new HttpError(404, 'not_found', 'no such lookup');
  return json(200, { status: l.status, result: l.result ?? null });
}

export const socialRoutes: Record<string, Route> = {
  '/instagram/connect/start': { method: 'POST', auth: true, run: connectStart },
  '/instagram/status': { method: 'GET|POST', auth: true, run: status },
  '/instagram/disconnect': { method: 'POST', auth: true, run: disconnect },
  '/social/links': { method: 'POST', auth: true, run: attach },
  '/social/asks': { method: 'GET|POST', auth: true, run: asks },
  '/social/lookups': { method: 'POST', auth: true, run: lookupStart },
};

const ID = '([0-9a-f-]{36})';

/** The routes with an id in the path. */
export function socialPatternRoute(path: string): Route | undefined {
  const link = new RegExp(`^/social/links/${ID}$`, 'i').exec(path);
  if (link) return { method: 'DELETE', auth: true, run: (ctx) => detach(ctx, link[1]!.toLowerCase()) };
  const ask = new RegExp(`^/social/asks/${ID}$`, 'i').exec(path);
  if (ask) return { method: 'POST', auth: true, run: (ctx) => answer(ctx, ask[1]!.toLowerCase()) };
  const lookup = new RegExp(`^/social/lookups/${ID}$`, 'i').exec(path);
  if (lookup) return { method: 'GET', auth: true, run: (ctx) => lookupGet(ctx, lookup[1]!.toLowerCase()) };
  return undefined;
}
