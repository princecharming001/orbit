/**
 * The user's data rights (§10.3, §14):
 *   POST /account/export                → every row Orbit holds for the user, as JSON (secrets and hashes left out)
 *   POST /account/delete {confirm:'DELETE'} → best-effort provider cleanup (Gmail watch stop, Google token revoke,
 *                                           Unipile account delete), then orbit.delete_user
 */
import type { Db, Row } from '../_shared/db.ts';
import { type GoogleConfig, refreshAccessToken, revokeToken } from '../_shared/google.ts';
import { badRequest, json, readJson } from '../_shared/http.ts';
import { sqlVault } from '../_shared/vault.ts';
import type { Ctx } from './api.ts';

/** Never exported: auth plumbing whose only content is hashes or verifiers. */
const SKIP_TABLES = new Set(['login_codes', 'oauth_states']);
/** Never exported columns, per table ('*' = every table). */
const SKIP_COLUMNS: Record<string, string[]> = {
  '*': ['embedding'],
  sessions: ['refresh_hash'],
  integration_accounts: ['token_secret_id'],
};

export async function exportUser(db: Db, userId: string) {
  const tables = await db.sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
      join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
     where c.table_schema = 'orbit' and c.column_name = 'user_id' and b.table_type = 'BASE TABLE'
     order by c.table_name`;
  const data: Record<string, Row[]> = {};
  const [user] = await db.sql<{
    row: Row;
  }>`select to_jsonb(u) as row from orbit.users u where u.id = ${userId}::uuid`;
  data.users = user ? [user.row] : [];
  for (const { table_name } of tables) {
    if (SKIP_TABLES.has(table_name) || !/^[a-z_]+$/.test(table_name)) continue;
    const drop = [...SKIP_COLUMNS['*']!, ...(SKIP_COLUMNS[table_name] ?? [])]
      .map((c) => ` - '${c}'`)
      .join('');
    const rows = await db.query<{ row: Row }>(
      `select to_jsonb(t)${drop} as row from orbit.${table_name} t where t.user_id = $1::uuid`,
      [userId],
    );
    data[table_name] = rows.map((r) => r.row);
  }
  return data;
}

export async function accountExport(ctx: Ctx): Promise<Response> {
  const data = await exportUser(ctx.db, ctx.userId!);
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id)
    values (${ctx.userId!}::uuid, 'user', 'account.export', 'users', ${ctx.userId!})`;
  return json(
    200,
    { exportedAt: ctx.now().toISOString(), format: 'orbit-export-v1', data },
    { 'content-disposition': 'attachment; filename="orbit-export.json"' },
  );
}

export type Cleanup = 'done' | 'skipped' | 'failed';

export interface CleanupDeps {
  db: Db;
  google: GoogleConfig | undefined;
  fetch: typeof fetch;
  unipileKey?: string;
  unipileBase?: string;
}

/** Provider-side cleanup before the rows go. Every step is best-effort and reported, never fatal. */
export async function providerCleanup(deps: CleanupDeps, userId: string) {
  const out: { gmailStop: Cleanup; googleRevoke: Cleanup; unipile: Cleanup } = {
    gmailStop: 'skipped',
    googleRevoke: 'skipped',
    unipile: 'skipped',
  };
  const accounts = await deps.db.sql<{
    provider: string;
    token_secret_id: string | null;
    external_account_id: string | null;
  }>`
    select provider, token_secret_id, external_account_id from orbit.integration_accounts where user_id = ${userId}::uuid`;
  const google = accounts.find((a) => a.provider === 'google');
  const linkedin = accounts.find((a) => a.provider === 'linkedin');

  if (google?.token_secret_id) {
    let refresh: string | null = null;
    try {
      refresh = await sqlVault(deps.db).get(google.token_secret_id);
    } catch {
      refresh = null;
    }
    if (refresh && deps.google) {
      try {
        const t = await refreshAccessToken(deps.google, refresh);
        const r = await deps.fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
          method: 'POST',
          headers: { authorization: `Bearer ${t.access_token}` },
        });
        await r.body?.cancel();
        out.gmailStop = r.ok ? 'done' : 'failed';
      } catch {
        out.gmailStop = 'failed';
      }
    }
    if (refresh) {
      try {
        out.googleRevoke = (await revokeToken({ fetch: deps.fetch }, refresh)) ? 'done' : 'failed';
      } catch {
        out.googleRevoke = 'failed';
      }
    }
  }

  if (linkedin?.external_account_id && deps.unipileKey && deps.unipileBase) {
    try {
      const r = await deps.fetch(
        `${deps.unipileBase}/api/v1/accounts/${encodeURIComponent(linkedin.external_account_id)}`,
        { method: 'DELETE', headers: { 'X-API-KEY': deps.unipileKey, accept: 'application/json' } },
      );
      await r.body?.cancel();
      out.unipile = r.ok || r.status === 404 ? 'done' : 'failed';
    } catch {
      out.unipile = 'failed';
    }
  }
  return out;
}

export async function accountDelete(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  if (body.confirm !== 'DELETE') throw badRequest("send {confirm: 'DELETE'} to delete the account");
  const cleanup = await providerCleanup(
    {
      db: ctx.db,
      google: ctx.google,
      fetch: ctx.fetch,
      unipileKey: ctx.env.unipileKey,
      unipileBase: ctx.env.unipileBase,
    },
    ctx.userId!,
  );
  await ctx.db.sql`select orbit.delete_user(${ctx.userId!}::uuid)`;
  return json(200, { deleted: true, cleanup });
}
