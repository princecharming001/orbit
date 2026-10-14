/**
 * The sync endpoints (§11.1, §11.4, §18):
 *
 *   POST /sync/status                      counts, integration states, backfill progress, pending jobs
 *   POST /sync/pull {cursor?, tables?, limit?}
 *        → {changes: {table: rows[]}, deleted: {table: ids[]}, cursor, hasMore}
 *        cursor = base64url JSON {table: {t: last cursor time, k: last key}, _audit: last audit_log id}
 *   POST /sync/push {changes: [{table, op: 'upsert'|'delete', id, row?}]}
 *        → {results: [{table, id, ok, row?, error?}]}; user-authored tables only, every change audited
 */
import { z } from 'zod/v4';
import { base64url, fromBase64url, isUuid } from '../_shared/crypto.ts';
import type { Db, Row } from '../_shared/db.ts';
import { badRequest, json, readJson } from '../_shared/http.ts';
import { QUEUES } from '../_shared/queue.ts';
import type { Ctx } from './api.ts';
import { PULL_BY_NAME, PULL_TABLES, type PullTable, shapeRow } from './tables.ts';

// ---- status -------------------------------------------------------------------------------------------------------

export async function syncStatus(ctx: Ctx): Promise<Response> {
  return json(200, await statusFor(ctx.db, ctx.userId!));
}

export async function statusFor(db: Db, userId: string) {
  const [counts] = await db.sql<Record<string, number>>`
    select
      (select count(*) from orbit.people where user_id = ${userId}::uuid and not is_self
         and deleted_at is null and merged_into is null)::int as people,
      (select count(*) from orbit.organizations where user_id = ${userId}::uuid)::int as organizations,
      (select count(*) from orbit.threads where user_id = ${userId}::uuid)::int as threads,
      (select count(*) from orbit.messages where user_id = ${userId}::uuid)::int as messages,
      (select count(*) from orbit.calendar_events where user_id = ${userId}::uuid)::int as events,
      (select count(*) from orbit.ties where user_id = ${userId}::uuid)::int as ties,
      (select count(*) from orbit.goals where user_id = ${userId}::uuid and deleted_at is null and status = 'active')::int as goals,
      (select count(*) from orbit.chats where user_id = ${userId}::uuid and archived_at is null)::int as chats,
      (select count(*) from orbit.drafts where user_id = ${userId}::uuid and status = 'draft')::int as drafts`;
  const accounts = await db.sql<{
    provider: string;
    status: string;
    email: string | null;
    scopes: string[];
    linked: boolean;
    sync_state: Record<string, Record<string, unknown>>;
    last_synced_at: Date | null;
    last_error: string | null;
    watch_expires_at: Date | null;
  }>`
    select provider, status, email, scopes, external_account_id is not null as linked, sync_state,
           last_synced_at, last_error, watch_expires_at
      from orbit.integration_accounts where user_id = ${userId}::uuid order by provider`;
  const pending = await db.query<{ n: number }>(
    `select (${QUEUES.map((q) => `(select count(*) from pgmq.q_${q} where message->>'userId' = $1)`).join(' + ')})::int as n`,
    [userId],
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    counts: counts ?? {},
    integrations: accounts.map((a) => {
      const bf = a.sync_state?.gmail?.backfill as Record<string, unknown> | undefined;
      return {
        provider: a.provider,
        status: a.status,
        email: a.email,
        scopes: a.scopes,
        linked: a.linked,
        lastSyncedAt: iso(a.last_synced_at),
        lastError: a.last_error,
        watchExpiresAt: iso(a.watch_expires_at),
        backfill: bf
          ? {
              phase: bf.phase ?? null,
              done: Number(bf.done ?? 0),
              total: bf.total == null ? null : Number(bf.total),
            }
          : null,
      };
    }),
    jobs: { pending: pending[0]?.n ?? 0 },
  };
}

// ---- pull ---------------------------------------------------------------------------------------------------------

interface CursorPos {
  t: string;
  k: string;
}
type Cursor = Record<string, CursorPos | number> & { _audit?: number };

export function encodeCursor(c: Cursor): string {
  return base64url(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeCursor(raw: unknown): Cursor {
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string' || raw.length > 20_000) throw badRequest('cursor is not valid');
  try {
    const c = JSON.parse(new TextDecoder().decode(fromBase64url(raw))) as Cursor;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('shape');
    for (const [k, v] of Object.entries(c)) {
      if (k === '_audit') {
        if (typeof v !== 'number') throw new Error('audit');
        continue;
      }
      const p = v as CursorPos;
      if (
        !PULL_BY_NAME.has(k) ||
        typeof p?.t !== 'string' ||
        typeof p?.k !== 'string' ||
        Number.isNaN(Date.parse(p.t))
      )
        throw new Error('entry');
    }
    return c;
  } catch {
    throw badRequest('cursor is not valid');
  }
}

export const PULL_DEFAULT_LIMIT = 500;
export const PULL_MAX_LIMIT = 2000;

export async function syncPull(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, { optional: true });
  const cursor = decodeCursor(body.cursor);
  const limit = Math.min(
    PULL_MAX_LIMIT,
    Math.max(1, Math.floor(Number(body.limit ?? PULL_DEFAULT_LIMIT)) || 1),
  );
  let tables: PullTable[] = PULL_TABLES;
  if (body.tables !== undefined) {
    if (!Array.isArray(body.tables) || body.tables.some((t) => typeof t !== 'string' || !PULL_BY_NAME.has(t)))
      throw badRequest(`tables must be a list of: ${PULL_TABLES.map((t) => t.table).join(', ')}`);
    tables = PULL_TABLES.filter((t) => (body.tables as string[]).includes(t.table));
  }
  const upTo = new Date(ctx.now().getTime() - ctx.pullLagMs);
  const out = await pull(ctx.db, ctx.userId!, { cursor, tables, limit, upTo });
  return json(200, out);
}

export async function pull(
  db: Db,
  userId: string,
  o: { cursor: Cursor; tables: PullTable[]; limit: number; upTo: Date },
) {
  const changes: Record<string, Row[]> = {};
  const deleted: Record<string, string[]> = {};
  const next: Cursor = { ...o.cursor };
  let hasMore = false;

  for (const t of o.tables) {
    const pos = o.cursor[t.table] as CursorPos | undefined;
    const del = t.deletedWhen ? `(${t.deletedWhen})` : 'false';
    const rows = await db.query<{ row: Row; _ts: string; _k: string; _del: boolean }>(
      `select to_jsonb(t) as row,
              to_char(t.${t.cursor} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _ts,
              t.${t.key}::text as _k, ${del} as _del
         from orbit.${t.table} t
        where t.user_id = $1::uuid
          and (t.${t.cursor}, t.${t.key}::text) > ($2::timestamptz, $3::text)
          and t.${t.cursor} <= $4::timestamptz
          ${t.filter ? `and ${t.filter}` : ''}
        order by t.${t.cursor}, t.${t.key}::text
        limit $5`,
      [userId, pos?.t ?? '-infinity', pos?.k ?? '', o.upTo, o.limit],
    );
    if (rows.length === o.limit) hasMore = true;
    const live = rows.filter((r) => !r._del).map((r) => shapeRow(t, r.row));
    const gone = rows.filter((r) => r._del).map((r) => r._k);
    if (live.length) changes[t.table] = live;
    if (gone.length) deleted[t.table] = gone;
    const last = rows.at(-1);
    if (last) next[t.table] = { t: last._ts, k: last._k };
  }

  // hard deletes made through /sync/push (and later by jobs) are recorded in the audit log
  const names = o.tables.map((t) => t.table);
  const audits = await db.sql<{ id: number | string; target_table: string; target_id: string }>`
    select id, target_table, target_id from orbit.audit_log
     where user_id = ${userId}::uuid and action = 'sync.delete' and id > ${o.cursor._audit ?? 0}::bigint
       and target_table = any(${names}::text[])
     order by id limit 5000`;
  for (const a of audits) (deleted[a.target_table] ??= []).push(a.target_id);
  if (audits.length === 5000) hasMore = true;
  const lastAudit = audits.at(-1);
  if (lastAudit) next._audit = Number(lastAudit.id);

  return { changes, deleted, cursor: encodeCursor(next), hasMore };
}

// ---- push ---------------------------------------------------------------------------------------------------------

type ColType =
  | 'text'
  | 'int'
  | 'real'
  | 'boolean'
  | 'uuid'
  | 'timestamptz'
  | 'date'
  | 'jsonb'
  | 'text[]'
  | 'uuid[]';

interface Field {
  col: string;
  type: ColType;
  schema: z.ZodType;
  /** the orbit table the referenced id(s) must belong to the user in */
  owned?: 'people' | 'goals' | 'organizations' | 'chats';
}

interface PushSpec {
  table: string;
  /** upsert: insert or update; update: existing rows only */
  write: 'upsert' | 'update' | 'none';
  /** soft: sets deleted_at; hard: deletes and records it for pull */
  del?: 'soft' | 'hard';
  key: 'id' | 'person_id';
  fields: Record<string, Field>;
  required?: string[];
}

const uuidS = z.string().refine(isUuid, 'must be a uuid');
const tsS = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time');
const dateS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const obj = (maxBytes: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= maxBytes, `must be under ${maxBytes} bytes`);
const f = (col: string, type: ColType, schema: z.ZodType, owned?: Field['owned']): Field => ({
  col,
  type,
  schema,
  owned,
});

export const PUSH: Record<string, PushSpec> = {
  goals: {
    table: 'goals',
    write: 'upsert',
    del: 'soft',
    key: 'id',
    required: ['kind', 'title'],
    fields: {
      kind: f(
        'kind',
        'text',
        z.enum([
          'recruiting',
          'fundraising',
          'sales',
          'hiring',
          'advice',
          'cofounder',
          'community',
          'collaboration',
        ]),
      ),
      title: f('title', 'text', z.string().trim().min(1).max(200)),
      description: f('description', 'text', z.string().max(4000).nullable()),
      targets: f(
        'targets',
        'jsonb',
        z.object({
          organizations: z.array(z.string().max(200)).max(50).default([]),
          roles: z.array(z.string().max(200)).max(50).default([]),
          geographies: z.array(z.string().max(200)).max(50).default([]),
          people: z.array(z.string().max(200)).max(50).default([]),
        }),
      ),
      criteria: f('criteria', 'jsonb', obj(20_000)),
      successMetric: f('success_metric', 'text', z.string().max(500).nullable()),
      priority: f('priority', 'int', z.number().int().min(1).max(3)),
      status: f('status', 'text', z.enum(['active', 'paused', 'done'])),
      autonomyLevel: f('autonomy_level', 'int', z.number().int().min(0).max(2).nullable()),
      dueAt: f('due_at', 'date', dateS.nullable()),
      source: f('source', 'text', z.enum(['user', 'onboarding', 'inferred'])),
      evidence: f('evidence', 'text', z.string().max(2000).nullable()),
    },
  },
  chats: {
    table: 'chats',
    write: 'upsert',
    key: 'id',
    required: ['personId', 'stage'],
    fields: {
      personId: f('person_id', 'uuid', uuidS, 'people'),
      goalId: f('goal_id', 'uuid', uuidS.nullable(), 'goals'),
      orgId: f('org_id', 'uuid', uuidS.nullable(), 'organizations'),
      stage: f('stage', 'text', z.string().min(1).max(40)),
      stageEnteredAt: f('stage_entered_at', 'timestamptz', tsS),
      data: f('data', 'jsonb', obj(64_000)),
      archivedAt: f('archived_at', 'timestamptz', tsS.nullable()),
    },
  },
  stage_events: {
    table: 'stage_events',
    write: 'upsert',
    key: 'id',
    required: ['chatId', 'toStage', 'status', 'actor'],
    fields: {
      chatId: f('chat_id', 'uuid', uuidS, 'chats'),
      fromStage: f('from_stage', 'text', z.string().max(40).nullable()),
      toStage: f('to_stage', 'text', z.string().min(1).max(40)),
      status: f('status', 'text', z.string().min(1).max(40)),
      actor: f('actor', 'text', z.enum(['user', 'agent', 'system'])),
      reason: f('reason', 'text', z.string().max(2000).nullable()),
      evidence: f('evidence', 'jsonb', obj(20_000).nullable()),
      confidence: f('confidence', 'real', z.number().min(0).max(1).nullable()),
      decidedAt: f('decided_at', 'timestamptz', tsS.nullable()),
    },
  },
  notes: {
    table: 'notes',
    write: 'upsert',
    del: 'hard',
    key: 'id',
    required: ['source', 'occurredAt', 'rawText'],
    fields: {
      personIds: f('person_ids', 'uuid[]', z.array(uuidS).max(50), 'people'),
      chatId: f('chat_id', 'uuid', uuidS.nullable(), 'chats'),
      source: f('source', 'text', z.string().min(1).max(40)),
      title: f('title', 'text', z.string().max(300).nullable()),
      occurredAt: f('occurred_at', 'timestamptz', tsS),
      rawText: f('raw_text', 'text', z.string().max(100_000)),
      extraction: f('extraction', 'jsonb', obj(64_000).nullable()),
    },
  },
  people: {
    table: 'people',
    write: 'update',
    key: 'id',
    // only what the user edits by hand; everything else is derived on the server
    fields: {
      displayName: f('display_name', 'text', z.string().trim().min(1).max(200)),
      notes: f('notes', 'text', z.string().max(20_000).nullable()),
      tags: f('tags', 'text[]', z.array(z.string().max(60)).max(50)),
      relationshipType: f('relationship_type', 'text', z.string().max(40).nullable()),
      hiddenAt: f('hidden_at', 'timestamptz', tsS.nullable()),
      doNotContact: f('do_not_contact', 'boolean', z.boolean()),
    },
  },
  tie_labels: {
    table: 'tie_labels',
    write: 'upsert',
    del: 'hard',
    key: 'person_id',
    required: ['closeness'],
    fields: { closeness: f('closeness', 'int', z.number().int().min(1).max(5)) },
  },
  // drafts: handled by pushDraft (status transitions and edits while still a draft)
  drafts: { table: 'drafts', write: 'update', key: 'id', fields: {} },
  memories: { table: 'memories', write: 'none', del: 'hard', key: 'id', fields: {} },
};

class ChangeError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict' | 'not_allowed',
    message: string,
  ) {
    super(message);
  }
}

const ChangeS = z.object({
  table: z.string(),
  op: z.enum(['upsert', 'delete']),
  id: uuidS,
  row: z.record(z.string(), z.unknown()).optional(),
});

export const PUSH_MAX_CHANGES = 500;

export async function syncPush(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, { maxBytes: 5_000_000 });
  if (!Array.isArray(body.changes)) throw badRequest('changes must be a list');
  if (body.changes.length > PUSH_MAX_CHANGES)
    throw badRequest(`at most ${PUSH_MAX_CHANGES} changes per push`);
  const results = [];
  for (const raw of body.changes) results.push(await applyChange(ctx.db, ctx.userId!, raw));
  return json(200, { results });
}

export async function applyChange(db: Db, userId: string, raw: unknown) {
  const parsed = ChangeS.safeParse(raw);
  const table = (raw as { table?: unknown })?.table;
  const id = (raw as { id?: unknown })?.id;
  const ref = { table: typeof table === 'string' ? table : null, id: typeof id === 'string' ? id : null };
  try {
    if (!parsed.success)
      throw new ChangeError('invalid', 'each change needs table, op (upsert|delete) and a uuid id');
    const c = parsed.data;
    const spec = PUSH[c.table];
    if (!spec) throw new ChangeError('not_allowed', `${c.table} cannot be changed from the app`);
    const row = await db.begin(async (tx) => {
      if (c.op === 'delete') return remove(tx, userId, spec, c.id);
      if (spec.table === 'drafts') return pushDraft(tx, userId, c.id, c.row ?? {});
      if (spec.write === 'none')
        throw new ChangeError('not_allowed', `${c.table} can only be deleted from the app`);
      return write(tx, userId, spec, c.id, c.row ?? {});
    });
    return { ...ref, ok: true as const, ...(row ? { row } : {}) };
  } catch (e) {
    if (e instanceof ChangeError)
      return { ...ref, ok: false as const, error: { code: e.code, message: e.message } };
    // a database refusal (a constraint the checks above did not foresee) fails this change only
    return {
      ...ref,
      ok: false as const,
      error: { code: 'failed', message: 'this change could not be applied' },
    };
  }
}

const shape = (table: string, row: Row | undefined) => {
  const t = PULL_BY_NAME.get(table);
  return row && t ? shapeRow(t, row) : row;
};

async function audit(
  db: Db,
  userId: string,
  action: string,
  table: string,
  id: string,
  fields: string[] = [],
) {
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', ${action}, ${table}, ${id}, ${{ fields }}::jsonb)`;
}

async function checkOwned(db: Db, userId: string, table: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const [r] = await db.query<{ n: number }>(
    `select count(*)::int as n from orbit.${table} where user_id = $1::uuid and id = any($2::uuid[])`,
    [userId, unique],
  );
  if ((r?.n ?? 0) !== unique.length)
    throw new ChangeError('not_found', `a referenced ${table} row was not found`);
}

/** Validates the provided fields of a row against the spec (unknown keys are ignored). */
async function validFields(db: Db, userId: string, spec: PushSpec, row: Record<string, unknown>) {
  const out: { field: Field; name: string; value: unknown }[] = [];
  for (const [name, field] of Object.entries(spec.fields)) {
    if (!(name in row)) continue;
    const r = field.schema.safeParse(row[name]);
    if (!r.success) throw new ChangeError('invalid', `${name}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    if (field.owned && r.data != null)
      await checkOwned(
        db,
        userId,
        field.owned,
        Array.isArray(r.data) ? (r.data as string[]) : [r.data as string],
      );
    out.push({ field, name, value: r.data });
  }
  return out;
}

async function write(db: Db, userId: string, spec: PushSpec, id: string, row: Record<string, unknown>) {
  const keyCol = spec.key;
  // tie_labels are keyed by the person: the change id is the person's id
  if (keyCol === 'person_id') await checkOwned(db, userId, 'people', [id]);
  const fields = await validFields(db, userId, spec, row);
  const [existing] = await db.query<{ user_id: string }>(
    `select user_id from orbit.${spec.table} where ${keyCol} = $1::uuid ${keyCol === 'person_id' ? 'and user_id = $2::uuid' : ''}`,
    keyCol === 'person_id' ? [id, userId] : [id],
  );
  if (existing && existing.user_id !== userId)
    throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
  const softDeleted = spec.del === 'soft' ? ' and t.deleted_at is null' : '';

  if (existing || spec.write === 'update') {
    if (!existing) throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
    if (!fields.length) {
      const [cur] = await db.query<{ row: Row }>(
        `select to_jsonb(t) as row from orbit.${spec.table} t where t.${keyCol} = $1::uuid and t.user_id = $2::uuid`,
        [id, userId],
      );
      return shape(spec.table, cur?.row);
    }
    const sets = fields.map((x, i) => `${x.field.col} = $${i + 3}::${x.field.type}`).join(', ');
    const [r] = await db.query<{ row: Row }>(
      `update orbit.${spec.table} t set ${sets}
        where t.${keyCol} = $1::uuid and t.user_id = $2::uuid${softDeleted} returning to_jsonb(t) as row`,
      [id, userId, ...fields.map((x) => x.value)],
    );
    if (!r) throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
    await audit(
      db,
      userId,
      'sync.update',
      spec.table,
      id,
      fields.map((x) => x.name),
    );
    return shape(spec.table, r.row);
  }

  for (const name of spec.required ?? [])
    if (!fields.some((x) => x.name === name)) throw new ChangeError('invalid', `${name} is required`);
  const cols = [keyCol, 'user_id', ...fields.map((x) => x.field.col)];
  const vals = ['$1::uuid', '$2::uuid', ...fields.map((x, i) => `$${i + 3}::${x.field.type}`)];
  const [r] = await db.query<{ row: Row }>(
    `insert into orbit.${spec.table} as t (${cols.join(', ')}) values (${vals.join(', ')}) returning to_jsonb(t) as row`,
    [id, userId, ...fields.map((x) => x.value)],
  );
  await audit(
    db,
    userId,
    'sync.insert',
    spec.table,
    id,
    fields.map((x) => x.name),
  );
  return shape(spec.table, r?.row);
}

async function remove(db: Db, userId: string, spec: PushSpec, id: string) {
  if (!spec.del) throw new ChangeError('not_allowed', `${spec.table} cannot be deleted from the app`);
  const sql =
    spec.del === 'soft'
      ? `update orbit.${spec.table} set deleted_at = now() where ${spec.key} = $1::uuid and user_id = $2::uuid and deleted_at is null returning 1`
      : `delete from orbit.${spec.table} where ${spec.key} = $1::uuid and user_id = $2::uuid returning 1`;
  const rows = await db.query(sql, [id, userId]);
  if (!rows.length) throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
  // soft deletes reach other devices through deleted_at; hard deletes through this audit row
  await audit(db, userId, 'sync.delete', spec.table, id);
  return undefined;
}

const DraftPatchS = z.object({
  status: z.enum(['approved', 'discarded', 'cancelled']).optional(),
  subject: z.string().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
});

/** Drafts move only out of `draft` (to approved, discarded or cancelled), and are edited only while still drafts. */
async function pushDraft(db: Db, userId: string, id: string, row: Record<string, unknown>) {
  const p = DraftPatchS.safeParse({ status: row.status, subject: row.subject, body: row.body });
  if (!p.success) throw new ChangeError('invalid', p.error.issues[0]?.message ?? 'invalid draft change');
  const { status, subject, body } = p.data;
  const hasSubject = 'subject' in row;
  if (!status && !hasSubject && body === undefined) throw new ChangeError('invalid', 'nothing to change');
  const [r] = await db.sql<{ row: Row }>`
    update orbit.drafts t set
      subject = case when ${hasSubject}::boolean then ${subject ?? null}::text else t.subject end,
      body = coalesce(${body ?? null}::text, t.body),
      status = coalesce(${status ?? null}::text, t.status),
      cancel_reason = case when ${status ?? null}::text = 'cancelled' then 'user' else t.cancel_reason end
     where t.id = ${id}::uuid and t.user_id = ${userId}::uuid and t.status = 'draft'
    returning to_jsonb(t) as row`;
  if (!r) {
    const [cur] = await db.sql<{ status: string }>`
      select status from orbit.drafts where id = ${id}::uuid and user_id = ${userId}::uuid`;
    if (!cur) throw new ChangeError('not_found', `drafts ${id} was not found`);
    throw new ChangeError('conflict', `the draft is already ${cur.status}`);
  }
  const changed = ['status', 'subject', 'body'].filter((k) => k in row);
  await audit(db, userId, 'sync.update', 'drafts', id, changed);
  return shape('drafts', r.row);
}
