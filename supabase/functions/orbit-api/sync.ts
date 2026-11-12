/**
 * The sync endpoints (§11.1, §11.4, §18):
 *
 *   POST /sync/status                      counts, integration states, backfill progress, pending jobs (during setup),
 *                                          and the marks: when pulled data, LinkedIn and autopilot last changed
 *   POST /sync/pull {cursor?, tables?, limit?}
 *        → {changes: {table: rows[]}, deleted: {table: ids[]}, cursor, hasMore}
 *        cursor = base64url JSON {table: {t: last cursor time, k: last key}, _audit: last audit_log id}
 *   POST /sync/push {changes: [{table, op: 'upsert'|'delete', id, row?}]}
 *        → {results: [{table, id, ok, row?, error?}]}; user-authored tables only, every change audited
 *
 * People made in the browser are inserted with what the student typed (name, email, title, organization, LinkedIn,
 * location); the server derives name_norm and sources and adds the email and LinkedIn identities, so imports later
 * resolve to the same person. After that only the hand-edited fields change from the app.
 */
import { phoneRegionFor, toE164 } from '@orbit/core/entity/phone';
import { normalizeEmailForMatch } from '@orbit/core/entity/resolve';
import { linkedInSlug, normalizeEmail, parseName } from '@orbit/core/text/normalize';
import { z } from 'zod/v4';
import { base64url, fromBase64url, isUuid } from '../_shared/crypto.ts';
import type { Db, Row } from '../_shared/db.ts';
import { badRequest, json, readJson } from '../_shared/http.ts';
import { QUEUES } from '../_shared/queue.ts';
import { NO_SOURCES, type SourcesInUse, sourcesFor } from '../_shared/sources/states.ts';
import { pushDraftEdit, recordDraftEdit } from '../_shared/voice/voice.ts';
import type { Ctx } from './api.ts';
import { PULL_BY_NAME, PULL_TABLES, type PullTable, shapeRow } from './tables.ts';

// ---- status -------------------------------------------------------------------------------------------------------

export async function syncStatus(ctx: Ctx): Promise<Response> {
  return json(200, await statusFor(ctx.db, ctx.userId!, await sourcesFor(ctx.db, ctx.userId!, ctx.offered)));
}

/** A mark as the browser compares it: ISO time with microseconds, so two moves in one millisecond still differ. */
const MARK_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export interface StatusMarks {
  /** anything /sync/pull returns last changed (plan 35 B3); the browser pulls only when this moved */
  changed: string | null;
  /** what /linkedin/status answers last changed */
  linkedin: string | null;
  /** what /autopilot/status answers last changed */
  autopilot: string | null;
  /**
   * Plan 43 §3.2: the graph version, moved by the switch job when an optional source goes on, off or is removed. When
   * it differs from the one the browser last saw, the browser drops its cached graph (people, ties, scores, messages)
   * and pulls again from the start, so rows a source out of use left behind in its cache go. 0 until the first switch.
   */
  graph: number;
}

/**
 * Plan 35 B3: one row (orbit.user_marks) instead of nine counts and a scan of every queue. The counts older browsers
 * pull by are kept on that row and counted again only after something changed since; the queue depth is read only
 * while setup runs (onboarding unfinished, Google's import or LinkedIn's first pass still going), the only time a
 * screen shows it.
 */
export async function statusFor(db: Db, userId: string, src: SourcesInUse = NO_SOURCES) {
  const [marks, accounts, users] = await Promise.all([
    db.sql<{
      changed_at: string;
      linkedin_at: string;
      autopilot_at: string;
      graph_version: number;
      counts: Record<string, number> | null;
      fresh: boolean;
    }>`
    select to_char(changed_at at time zone 'utc', ${MARK_ISO}) as changed_at,
           to_char(linkedin_at at time zone 'utc', ${MARK_ISO}) as linkedin_at,
           to_char(autopilot_at at time zone 'utc', ${MARK_ISO}) as autopilot_at, graph_version,
           counts, (counts is not null and counts_at >= changed_at) as fresh
      from orbit.user_marks where user_id = ${userId}::uuid`,
    db.sql<{
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
      from orbit.integration_accounts where user_id = ${userId}::uuid order by provider`,
    db.sql<{ onboarded: boolean }>`
    select coalesce(onboarding->>'completed_at', '') <> '' as onboarded from orbit.users where id = ${userId}::uuid`,
  ]);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const integrations = accounts.map((a) => {
    const bf = a.sync_state?.gmail?.backfill as Record<string, unknown> | undefined;
    const li = a.sync_state?.linkedin as Record<string, unknown> | undefined;
    return {
      // LinkedIn's first full pass is still bringing connections in (a later refresh walks known people again)
      ...(a.provider === 'linkedin'
        ? { importing: !!li && !li.syncedAt && typeof li.stage === 'string' && li.stage !== 'done' }
        : {}),
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
  });
  const setup =
    users[0]?.onboarded === false ||
    integrations.some(
      (i) =>
        i.importing === true ||
        (i.provider === 'google' &&
          i.status === 'active' &&
          (i.backfill?.phase === 'recent' || i.backfill?.phase === 'deep')),
    );
  let mark = marks[0];
  let counts = mark?.fresh ? (mark.counts ?? {}) : undefined;
  const [pending] = await Promise.all([
    setup
      ? db.query<{ n: number }>(
          `select (${QUEUES.map((q) => `(select count(*) from pgmq.q_${q} where message->>'userId' = $1)`).join(' + ')})::int as n`,
          [userId],
        )
      : Promise.resolve([{ n: 0 }]),
    (async () => {
      if (counts) return;
      counts = await countsFor(db, userId, src);
      // kept as of the mark just read: a change after it moves changed_at past counts_at and counts again
      const [m] = await db.sql<{ changed_at: string; linkedin_at: string; autopilot_at: string }>`
        insert into orbit.user_marks as m (user_id, counts, counts_at)
        values (${userId}::uuid, ${counts}::jsonb, coalesce(${mark?.changed_at ?? null}::timestamptz, now()))
        on conflict (user_id) do update set counts = excluded.counts, counts_at = excluded.counts_at
        returning to_char(m.changed_at at time zone 'utc', ${MARK_ISO}) as changed_at,
                  to_char(m.linkedin_at at time zone 'utc', ${MARK_ISO}) as linkedin_at,
                  to_char(m.autopilot_at at time zone 'utc', ${MARK_ISO}) as autopilot_at`;
      if (m) mark = { ...m, graph_version: mark?.graph_version ?? 0, counts, fresh: true };
    })(),
  ]);
  const out: {
    counts: Record<string, number>;
    integrations: typeof integrations;
    jobs: { pending: number };
    marks: StatusMarks;
    setup: boolean;
  } = {
    counts: counts ?? {},
    integrations,
    jobs: { pending: pending[0]?.n ?? 0 },
    marks: {
      changed: mark?.changed_at ?? null,
      linkedin: mark?.linkedin_at ?? null,
      autopilot: mark?.autopilot_at ?? null,
      graph: Number(mark?.graph_version ?? 0),
    },
    setup,
  };
  return out;
}

/**
 * The counts the setup screen and older browsers read; run only after something changed. Plan 43 §3.2: rows of the
 * optional sources out of use, and people only they know or not listed yet, are not counted.
 */
async function countsFor(db: Db, userId: string, src: SourcesInUse): Promise<Record<string, number>> {
  const [counts] = await db.sql<Record<string, number>>`
    select
      (select count(*) from orbit.people p where p.user_id = ${userId}::uuid and not p.is_self
         and p.deleted_at is null and p.merged_into is null and p.listed
         and orbit.person_in_use(p.sources, p.source_account, ${src.hidden}::text[]))::int as people,
      (select count(*) from orbit.organizations where user_id = ${userId}::uuid)::int as organizations,
      (select count(*) from orbit.threads where user_id = ${userId}::uuid
         and provider <> all(${src.excluded.providers}::text[]))::int as threads,
      (select count(*) from orbit.messages where user_id = ${userId}::uuid
         and provider <> all(${src.excluded.providers}::text[]))::int as messages,
      (select count(*) from orbit.calendar_events where user_id = ${userId}::uuid)::int as events,
      (select count(*) from orbit.ties where user_id = ${userId}::uuid
         and kind <> all(${src.excluded.tieKinds}::text[]))::int as ties,
      (select count(*) from orbit.goals where user_id = ${userId}::uuid and deleted_at is null and status = 'active')::int as goals,
      (select count(*) from orbit.chats where user_id = ${userId}::uuid and archived_at is null)::int as chats,
      (select count(*) from orbit.drafts where user_id = ${userId}::uuid and status = 'draft')::int as drafts`;
  return counts ?? {};
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
/** Where a table's first pull starts: before any row Orbit can hold. */
export const PULL_FROM = '1970-01-01T00:00:00.000Z';
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
  const sources = await sourcesFor(ctx.db, ctx.userId!, ctx.offered);
  const out = await pull(ctx.db, ctx.userId!, { cursor, tables, limit, upTo, sources });
  return json(200, out);
}

/** Binds a table's off-rule filter (plan 43 §3.2): each named parameter it uses becomes the next positional one. */
function sourceFilter(t: PullTable, src: SourcesInUse, params: unknown[]): string {
  if (!t.sources) return '';
  const values: Record<string, unknown> = {
    hidden: src.hidden,
    providers: src.excluded.providers,
    tieKinds: src.excluded.tieKinds,
    identityKinds: src.excluded.identityKinds,
  };
  const at = new Map<string, number>();
  const sql = t.sources.replace(/\$(hidden|providers|tieKinds|identityKinds)\b/g, (_, name: string) => {
    if (!at.has(name)) {
      params.push(values[name]);
      at.set(name, params.length);
    }
    return `$${at.get(name)}`;
  });
  return `and ${sql}`;
}

export async function pull(
  db: Db,
  userId: string,
  o: { cursor: Cursor; tables: PullTable[]; limit: number; upTo: Date; sources?: SourcesInUse },
) {
  const src = o.sources ?? NO_SOURCES;
  const changes: Record<string, Row[]> = {};
  const deleted: Record<string, string[]> = {};
  const next: Cursor = { ...o.cursor };
  let hasMore = false;

  // every table's page and the audit log go out together (the pool runs a few at a time), not one after another
  const names = o.tables.map((t) => t.table);
  const [pages, audits] = await Promise.all([
    Promise.all(
      o.tables.map((t) => {
        const pos = o.cursor[t.table] as CursorPos | undefined;
        const del = t.deletedWhen ? `(${t.deletedWhen})` : 'false';
        // columns the browser never gets are dropped here, so they never cross the wire
        const row = ['to_jsonb(t)', ...(t.omit ?? []).map((c) => `'${c}'`)].join(' - ');
        const key = t.keySql ?? `t.${t.key}::text`;
        // The cursor time goes over as text and is cast in SQL: a timestamptz parameter is turned into a JS Date
        // by postgres.js first, which keeps milliseconds only, so a page of rows sharing one microsecond (a score
        // run writes thousands in one statement) came back again and again and the pull never got past it. A
        // table never pulled starts from a real date ('-infinity' is not one; every pull failed on it once).
        const params: unknown[] = [userId, pos?.t ?? PULL_FROM, pos?.k ?? '', o.upTo, o.limit];
        const off = sourceFilter(t, src, params);
        return db.query<{ row: Row; _ts: string; _k: string; _del: boolean }>(
          `select ${row} as row,
                  to_char(t.${t.cursor} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _ts,
                  ${key} as _k, ${del} as _del
             from orbit.${t.table} t
            where t.user_id = $1::uuid
              and (t.${t.cursor}, ${key}) > (($2::text)::timestamptz, $3::text)
              and t.${t.cursor} <= $4::timestamptz
              ${t.filter ? `and ${t.filter}` : ''}
              ${off}
            order by t.${t.cursor}, ${key}
            limit $5`,
          params,
        );
      }),
    ),
    // hard deletes made through /sync/push (and later by jobs) are recorded in the audit log
    db.sql<{ id: number | string; target_table: string; target_id: string }>`
      select id, target_table, target_id from orbit.audit_log
       where user_id = ${userId}::uuid and action = 'sync.delete' and id > ${o.cursor._audit ?? 0}::bigint
         and target_table = any(${names}::text[])
       order by id limit 5000`,
  ]);
  o.tables.forEach((t, i) => {
    const rows = pages[i]!;
    if (rows.length === o.limit) hasMore = true;
    const live = rows.filter((r) => !r._del).map((r) => shapeRow(t, r.row));
    const gone = rows.filter((r) => r._del).map((r) => r._k);
    if (live.length) changes[t.table] = live;
    if (gone.length) deleted[t.table] = gone;
    const last = rows.at(-1);
    if (last) next[t.table] = { t: last._ts, k: last._k };
  });
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

/** A column the server computes from the validated values instead of taking it from the app. */
interface Derived {
  col: string;
  type: ColType;
  value: unknown;
}

interface PushSpec {
  table: string;
  /** upsert: insert or update; update: existing rows only */
  write: 'upsert' | 'update' | 'none';
  /** soft: sets deleted_at; hard: deletes and records it for pull */
  del?: 'soft' | 'hard';
  key: 'id' | 'person_id';
  fields: Record<string, Field>;
  /** accepted when the row is created; ignored (never an error) on later updates */
  insertOnly?: Record<string, Field>;
  required?: string[];
  /** columns computed from the validated values, by field name: on insert, and on update from what changed */
  derive?: (v: Record<string, unknown>, op: 'insert' | 'update') => Derived[];
  /** runs in the same transaction right after an insert */
  afterInsert?: (db: Db, userId: string, id: string, v: Record<string, unknown>) => Promise<void>;
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
    write: 'upsert',
    key: 'id',
    required: ['displayName'],
    // what the user edits by hand; everything else is derived on the server
    fields: {
      displayName: f('display_name', 'text', z.string().trim().min(1).max(200)),
      notes: f('notes', 'text', z.string().max(20_000).nullable()),
      tags: f('tags', 'text[]', z.array(z.string().max(60)).max(50)),
      relationshipType: f('relationship_type', 'text', z.string().max(40).nullable()),
      hiddenAt: f('hidden_at', 'timestamptz', tsS.nullable()),
      doNotContact: f('do_not_contact', 'boolean', z.boolean()),
      // plan 29 §A1: hidden from friends; the people_unshare trigger drops the projection row at once
      private: f('private', 'boolean', z.boolean()),
      // a fresh LinkedIn photo (or a Gravatar) the browser fetched for someone whose link had expired or was missing:
      // only those hosts, so a person's picture is never an arbitrary address
      photoUrl: f(
        'photo_url',
        'text',
        z
          .string()
          .max(2000)
          .regex(
            /^https:\/\/([a-z0-9-]+\.)*(licdn\.com|gravatar\.com)\//,
            'must be a LinkedIn or Gravatar image',
          )
          .nullable(),
      ),
    },
    // a person added in the app: what the student typed, once; imports keep these up to date afterwards
    insertOnly: {
      firstName: f('first_name', 'text', z.string().trim().max(100).nullable()),
      lastName: f('last_name', 'text', z.string().trim().max(100).nullable()),
      primaryEmail: f(
        'primary_email',
        'text',
        z
          .string()
          .trim()
          .max(320)
          .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address')
          .transform((e) => normalizeEmail(e))
          .nullable(),
      ),
      title: f('title', 'text', z.string().trim().max(300).nullable()),
      orgRaw: f('org_raw', 'text', z.string().trim().max(300).nullable()),
      linkedinUrl: f('linkedin_url', 'text', z.string().trim().max(500).nullable()),
      location: f('location', 'text', z.string().trim().max(200).nullable()),
    },
    derive: (v, op) => {
      const out: Derived[] = [];
      const name = typeof v.displayName === 'string' ? v.displayName : undefined;
      if (name !== undefined) {
        const n = parseName(name);
        out.push({ col: 'name_norm', type: 'text', value: n.normalized || name.toLowerCase() });
        if (op === 'insert') {
          if (!('firstName' in v)) out.push({ col: 'first_name', type: 'text', value: n.first || null });
          if (!('lastName' in v)) out.push({ col: 'last_name', type: 'text', value: n.last || null });
        }
      }
      if (op === 'insert') {
        out.push({ col: 'sources', type: 'text[]', value: ['manual'] });
        const slug = typeof v.linkedinUrl === 'string' ? linkedInSlug(v.linkedinUrl) : undefined;
        if (slug) out.push({ col: 'linkedin_slug', type: 'text', value: slug });
      }
      return out;
    },
    afterInsert: async (db, userId, id, v) => {
      const add = (kind: string, norm: string, raw: string) => db.sql`
        insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
        values (${userId}::uuid, ${id}::uuid, ${kind}, ${norm}, ${raw}, 'manual')
        on conflict (user_id, kind, value_norm) do nothing`;
      if (typeof v.primaryEmail === 'string' && v.primaryEmail)
        await add('email', normalizeEmailForMatch(v.primaryEmail), v.primaryEmail);
      const slug = typeof v.linkedinUrl === 'string' ? linkedInSlug(v.linkedinUrl) : undefined;
      if (slug) await add('linkedin_slug', slug, v.linkedinUrl as string);
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
  uploads: {
    table: 'uploads',
    write: 'upsert',
    del: 'hard',
    key: 'id',
    required: ['kind', 'text'],
    fields: {
      kind: f('kind', 'text', z.enum(['resume', 'note', 'transcript', 'linkedin_export'])),
      filename: f('filename', 'text', z.string().max(300).nullable()),
      text: f('text', 'text', z.string().max(500_000)),
      parsed: f('parsed', 'jsonb', obj(200_000).nullable()),
      isCurrent: f('is_current', 'boolean', z.boolean()),
    },
  },
  // drafts: handled by pushDraft (status transitions and edits while still a draft)
  drafts: { table: 'drafts', write: 'update', key: 'id', fields: {} },
  // an edit the browser recorded as it sent (plan 29 §B2.4): handled by pushDraftEdit, one row per draft
  draft_edits: { table: 'draft_edits', write: 'upsert', key: 'id', fields: {} },
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
    // plan 43 §6: a person may carry phone numbers (a friend known from texts); they become phone identities
    const phones = spec.table === 'people' && c.op === 'upsert' ? phonesOf(c.row ?? {}) : undefined;
    const row = await db.begin(async (tx) => {
      if (c.op === 'delete') return remove(tx, userId, spec, c.id);
      if (spec.table === 'drafts') return pushDraft(tx, userId, c.id, c.row ?? {});
      if (spec.table === 'draft_edits') return pushEdit(tx, userId, c.id, c.row ?? {});
      if (spec.write === 'none')
        throw new ChangeError('not_allowed', `${c.table} can only be deleted from the app`);
      const out = await write(tx, userId, spec, c.id, c.row ?? {});
      if (phones?.length) await addPhoneIdentities(tx, userId, c.id, phones, 'manual');
      return out;
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

const PhonesS = z.array(z.string().trim().min(3).max(40)).max(20);

/** The `phones` a pushed person carries, checked; undefined when there are none. */
function phonesOf(row: Record<string, unknown>): string[] | undefined {
  if (!('phones' in row) || row.phones == null) return undefined;
  const r = PhonesS.safeParse(row.phones);
  if (!r.success) throw new ChangeError('invalid', `phones: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

/**
 * Phone numbers as identities of one person (kind `phone`, E.164 read in the country of the student's time zone, the
 * same key the browser uses). A number another of the student's people already has stays theirs. Returns the numbers
 * written.
 */
export async function addPhoneIdentities(
  db: Db,
  userId: string,
  personId: string,
  raw: readonly string[],
  source: string,
): Promise<string[]> {
  const [u] = await db.sql<{ timezone: string | null; current_city: string | null }>`
    select timezone, current_city from orbit.users where id = ${userId}::uuid`;
  const region = phoneRegionFor({
    timezone: u?.timezone ?? undefined,
    currentCity: u?.current_city ?? undefined,
  });
  const out: string[] = [];
  for (const p of raw) {
    const e164 = toE164(p, region);
    if (!e164 || out.includes(e164)) continue;
    await db.sql`
      insert into orbit.person_identities (user_id, person_id, kind, value_norm, value_raw, source)
      values (${userId}::uuid, ${personId}::uuid, 'phone', ${e164}, ${p}, ${source})
      on conflict (user_id, kind, value_norm) do nothing`;
    out.push(e164);
  }
  return out;
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

/** Validates the provided fields of a row against the spec (unknown keys, and insert-only ones on update, are ignored). */
async function validFields(
  db: Db,
  userId: string,
  spec: PushSpec,
  row: Record<string, unknown>,
  insert: boolean,
) {
  const out: { field: Field; name: string; value: unknown }[] = [];
  const all = insert ? { ...spec.fields, ...spec.insertOnly } : spec.fields;
  for (const [name, field] of Object.entries(all)) {
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
  const [existing] = await db.query<{ user_id: string }>(
    `select user_id from orbit.${spec.table} where ${keyCol} = $1::uuid ${keyCol === 'person_id' ? 'and user_id = $2::uuid' : ''}`,
    keyCol === 'person_id' ? [id, userId] : [id],
  );
  if (existing && existing.user_id !== userId)
    throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
  const insert = !existing && spec.write !== 'update';
  const fields = await validFields(db, userId, spec, row, insert);
  const values = Object.fromEntries(fields.map((x) => [x.name, x.value]));
  const derived = spec.derive?.(values, insert ? 'insert' : 'update') ?? [];
  const cols = [...fields.map((x) => ({ col: x.field.col, type: x.field.type })), ...derived];
  const params = [...fields.map((x) => x.value), ...derived.map((d) => d.value)];
  const softDeleted = spec.del === 'soft' ? ' and t.deleted_at is null' : '';

  if (!insert) {
    if (!existing) throw new ChangeError('not_found', `${spec.table} ${id} was not found`);
    if (!fields.length) {
      const [cur] = await db.query<{ row: Row }>(
        `select to_jsonb(t) as row from orbit.${spec.table} t where t.${keyCol} = $1::uuid and t.user_id = $2::uuid`,
        [id, userId],
      );
      return shape(spec.table, cur?.row);
    }
    const sets = cols.map((c, i) => `${c.col} = $${i + 3}::${c.type}`).join(', ');
    const [r] = await db.query<{ row: Row }>(
      `update orbit.${spec.table} t set ${sets}
        where t.${keyCol} = $1::uuid and t.user_id = $2::uuid${softDeleted} returning to_jsonb(t) as row`,
      [id, userId, ...params],
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
  const names = [keyCol, 'user_id', ...cols.map((c) => c.col)];
  const vals = ['$1::uuid', '$2::uuid', ...cols.map((c, i) => `$${i + 3}::${c.type}`)];
  const [r] = await db.query<{ row: Row }>(
    `insert into orbit.${spec.table} as t (${names.join(', ')}) values (${vals.join(', ')}) returning to_jsonb(t) as row`,
    [id, userId, ...params],
  );
  await spec.afterInsert?.(db, userId, id, values);
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
  // plan 43 §6: a draft moved to Messages ("Open in Messages"), or back to where it was. A Messages draft is a
  // handoff the student completes: the server keeps it and never sends it (sending/send.ts)
  channel: z.enum(['gmail', 'linkedin', 'instagram', 'x', 'imessage']).optional(),
});

/**
 * Drafts move only out of `draft` (to approved, discarded or cancelled), and are edited only while still drafts. A
 * draft's channel may change while it is a draft.
 */
async function pushDraft(db: Db, userId: string, id: string, row: Record<string, unknown>) {
  const p = DraftPatchS.safeParse({
    status: row.status,
    subject: row.subject,
    body: row.body,
    channel: row.channel,
  });
  if (!p.success) throw new ChangeError('invalid', p.error.issues[0]?.message ?? 'invalid draft change');
  const { status, subject, body, channel } = p.data;
  const hasSubject = 'subject' in row;
  if (!status && !hasSubject && body === undefined && !channel)
    throw new ChangeError('invalid', 'nothing to change');
  const [r] = await db.sql<{ row: Row }>`
    update orbit.drafts t set
      subject = case when ${hasSubject}::boolean then ${subject ?? null}::text else t.subject end,
      body = coalesce(${body ?? null}::text, t.body),
      channel = coalesce(${channel ?? null}::text, t.channel),
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
  const changed = ['status', 'subject', 'body', 'channel'].filter((k) => k in row);
  await audit(db, userId, 'sync.update', 'drafts', id, changed);
  // an edit to Orbit's words is the student's voice (plan 29 §B2.4): one draft_edits row per draft
  if (body !== undefined)
    await recordDraftEdit(db, r.row as unknown as Parameters<typeof recordDraftEdit>[1]);
  return shape('drafts', r.row);
}

const DraftEditS = z.object({
  draftId: uuidS.nullable().optional(),
  kind: z.string().trim().min(1).max(40),
  replyClass: z.string().max(40).nullable().optional(),
  before: z.string().min(1).max(20_000),
  after: z.string().min(1).max(20_000),
  distance: z.number().int().min(0).max(100_000),
  createdAt: tsS.nullable().optional(),
});

/** An edit the browser recorded: a new row, or the server's own row for the same draft brought up to date. */
async function pushEdit(db: Db, userId: string, id: string, row: Record<string, unknown>) {
  const p = DraftEditS.safeParse(row);
  if (!p.success) throw new ChangeError('invalid', p.error.issues[0]?.message ?? 'invalid edit');
  const r = await pushDraftEdit(db, userId, id, p.data);
  if (!r) throw new ChangeError('not_found', `draft_edits ${id} was not found`);
  await audit(db, userId, 'sync.insert', 'draft_edits', id, ['before', 'after']);
  return r;
}
