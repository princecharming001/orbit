/**
 * Which orbit tables /sync/pull returns and how rows are shaped for the SPA's Dexie cache (§11.4).
 *
 * Rows are converted by a generic snake_case → camelCase converter plus the small per-table overrides below. At the
 * merge with P2 the core mappers in @orbit/core (packages/core/src/server/mappers.ts) replace these overrides, so
 * the function and the browser share one mapping.
 */

export interface PullTable {
  /** orbit table name */
  table: string;
  /** primary key column used as the cursor tie-break and as the id in `deleted` */
  key: 'id' | 'person_id';
  /** the column changes are read by */
  cursor: 'updated_at' | 'created_at';
  /** SQL (over alias t) true for rows the client should drop rather than store */
  deletedWhen?: string;
  /** extra SQL filter (over alias t) on what is synced at all */
  filter?: string;
  /** columns never sent to the browser */
  omit?: string[];
  map?: (row: Record<string, unknown>) => Record<string, unknown>;
}

export const PULL_TABLES: PullTable[] = [
  { table: 'organizations', key: 'id', cursor: 'updated_at' },
  {
    table: 'people',
    key: 'id',
    cursor: 'updated_at',
    deletedWhen: 't.deleted_at is not null or t.merged_into is not null',
  },
  { table: 'person_identities', key: 'id', cursor: 'created_at' },
  { table: 'affiliations', key: 'id', cursor: 'updated_at' },
  { table: 'merge_suggestions', key: 'id', cursor: 'updated_at' },
  { table: 'goals', key: 'id', cursor: 'updated_at', deletedWhen: 't.deleted_at is not null' },
  // the Dexie cache keeps the last 180 days of networking threads only (§11.1)
  {
    table: 'threads',
    key: 'id',
    cursor: 'updated_at',
    filter: "t.is_networking and coalesce(t.last_at, t.created_at) > now() - interval '180 days'",
  },
  {
    table: 'messages',
    key: 'id',
    cursor: 'updated_at',
    filter:
      "t.sent_at > now() - interval '180 days' and exists (select 1 from orbit.threads th where th.id = t.thread_id and th.is_networking)",
    omit: ['embedding'],
    map: (r) => ({
      ...r,
      direction: r.direction === 'out' ? 'outbound' : 'inbound',
      externalMessageId: r.externalId,
      fromEmail: r.fromAddr ?? '',
      toEmails: r.toAddrs ?? [],
      ccEmails: r.ccAddrs ?? [],
      bodyText: r.bodyText ?? '',
    }),
  },
  { table: 'calendar_events', key: 'id', cursor: 'updated_at' },
  {
    table: 'ties',
    key: 'id',
    cursor: 'updated_at',
    // an Edge: type = kind, weight = w · c
    map: (r) => ({
      ...r,
      personAId: r.aPersonId,
      personBId: r.bPersonId,
      type: r.kind,
      rawWeight: r.weight,
      weight: Number(r.weight) * Number(r.confidence),
    }),
  },
  { table: 'tie_scores', key: 'person_id', cursor: 'updated_at' },
  { table: 'tie_labels', key: 'person_id', cursor: 'updated_at' },
  {
    table: 'chats',
    key: 'id',
    cursor: 'updated_at',
    // a CoffeeChat: the stored camelCase fields spread under the columns
    map: ({ data, ...rest }) => ({ ...((data as Record<string, unknown>) ?? {}), ...rest }),
  },
  { table: 'stage_events', key: 'id', cursor: 'updated_at' },
  { table: 'drafts', key: 'id', cursor: 'updated_at' },
  { table: 'notes', key: 'id', cursor: 'updated_at' },
  { table: 'facts', key: 'id', cursor: 'updated_at', deletedWhen: 't.deleted_at is not null' },
  { table: 'dossiers', key: 'id', cursor: 'updated_at' },
  { table: 'recommendations', key: 'id', cursor: 'updated_at' },
  { table: 'intro_requests', key: 'id', cursor: 'updated_at' },
];

export const PULL_BY_NAME = new Map(PULL_TABLES.map((t) => [t.table, t]));

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Top-level keys to camelCase; nested json (already camelCase where it came from core) is left as stored. */
export function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out;
}

export function shapeRow(t: PullTable, row: Record<string, unknown>): Record<string, unknown> {
  const r = { ...row };
  for (const c of t.omit ?? []) delete r[c];
  const c = toCamel(r);
  return t.map ? t.map(c) : c;
}
