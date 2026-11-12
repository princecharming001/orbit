/**
 * Which orbit tables /sync/pull returns and how rows are shaped for the SPA's Dexie cache (§11.4).
 *
 * Rows are converted by a generic snake_case → camelCase converter plus the small per-table overrides below. At the
 * merge with P2 the core mappers in @orbit/core (packages/core/src/server/mappers.ts) replace these overrides, so
 * the function and the browser share one mapping.
 *
 * Plan 43 §3.2: what the browser receives follows the off rule. Each table's `sources` filter reads the student's
 * optional sources out of use through named parameters, bound by the pull: $hidden their names (people known only from
 * them, their accounts' platforms), $providers their message providers, $tieKinds their tie kinds, $identityKinds their
 * identity kinds. People not listed (§3.3) are left out of the people table.
 */
import {
  type SourceRow,
  socialLinkFromRow,
  socialLookupFromRow,
  socialMatchAskFromRow,
  sourceStateFromRow,
  textDayFromRow,
} from '@orbit/core/server/mappers';

/** The off rule's people test over a person id column (plan 43 §3.2). */
const personInUse = (col: string) =>
  `not exists (select 1 from orbit.people q where q.id = ${col}
                and not orbit.person_in_use(q.sources, q.source_account, $hidden::text[]))`;

export interface PullTable {
  /** orbit table name */
  table: string;
  /** primary key column used as the cursor tie-break and as the id in `deleted` */
  key: 'id' | 'person_id' | 'source' | 'day_key';
  /** SQL (over alias t) for a key that is not one column */
  keySql?: string;
  /** the off rule (plan 43 §3.2): SQL over alias t and the named parameters above */
  sources?: string;
  /** maps the stored (snake_case) row itself, through a core mapper, instead of the generic camelCase */
  fromRow?: (row: Record<string, unknown>) => Record<string, unknown>;
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
  {
    table: 'organizations',
    key: 'id',
    cursor: 'updated_at',
    // an Organization under the browser's names: without nameNormalized a company's wedge key read "n:undefined",
    // so picking a company never turned the map to it
    map: (r) => ({ ...r, nameNormalized: r.nameNorm }),
  },
  {
    table: 'people',
    key: 'id',
    cursor: 'updated_at',
    deletedWhen: 't.deleted_at is not null or t.merged_into is not null',
    // plan 43: people only an optional source out of use knows, and people not listed yet, are not sent
    sources: 't.listed and orbit.person_in_use(t.sources, t.source_account, $hidden::text[])',
    // a Person: the columns under the names the browser's screens read
    map: (r) => ({
      ...r,
      nameNormalized: r.nameNorm,
      currentTitle: r.title,
      currentOrganizationId: r.orgId,
      currentOrganizationRaw: r.orgRaw,
    }),
  },
  {
    table: 'person_identities',
    key: 'id',
    cursor: 'created_at',
    sources: `t.kind <> all($identityKinds::text[]) and ${personInUse('t.person_id')}`,
  },
  {
    table: 'affiliations',
    key: 'id',
    cursor: 'updated_at',
    sources: personInUse('t.person_id'),
    // an Affiliation: the company as the browser names it, so a role shows where it was and the company's logo
    map: (r) => ({ ...r, nameRaw: r.orgRaw ?? '', organizationId: r.orgId }),
  },
  {
    table: 'merge_suggestions',
    key: 'id',
    cursor: 'updated_at',
    // a MergeSuggestion: the two people and the status under the browser's names (open is pending, merged accepted)
    map: (r) => ({
      ...r,
      personAId: r.personA,
      personBId: r.personB,
      status: r.status === 'open' ? 'pending' : r.status === 'merged' ? 'accepted' : r.status,
    }),
  },
  { table: 'goals', key: 'id', cursor: 'updated_at', deletedWhen: 't.deleted_at is not null' },
  // the Dexie cache keeps the last 180 days of networking threads only (§11.1)
  {
    table: 'threads',
    key: 'id',
    cursor: 'updated_at',
    filter: "t.is_networking and coalesce(t.last_at, t.created_at) > now() - interval '180 days'",
    sources: 't.provider <> all($providers::text[])',
    // LinkedIn threads carry their channel, as the browser's own LinkedIn reader writes them
    map: (r) => ({
      ...r,
      externalThreadId: r.externalId,
      firstMessageAt: r.firstAt,
      lastMessageAt: r.lastAt,
      ...(r.provider === 'linkedin' ? { channel: 'linkedin' } : {}),
    }),
  },
  {
    table: 'messages',
    key: 'id',
    cursor: 'updated_at',
    filter:
      "t.sent_at > now() - interval '180 days' and exists (select 1 from orbit.threads th where th.id = t.thread_id and th.is_networking)",
    sources: 't.provider <> all($providers::text[])',
    omit: ['embedding'],
    map: (r) => ({
      ...r,
      direction: r.direction === 'out' ? 'outbound' : 'inbound',
      externalMessageId: r.externalId,
      fromEmail: r.fromAddr ?? '',
      toEmails: r.toAddrs ?? [],
      ccEmails: r.ccAddrs ?? [],
      bodyText: r.bodyText ?? '',
      // what the browser reads for replies and to know a message is stored in full
      headers: {
        ...(r.rfcMessageId ? { 'message-id': r.rfcMessageId } : {}),
        ...(r.inReplyTo ? { 'in-reply-to': r.inReplyTo } : {}),
      },
      ...(r.provider === 'linkedin' ? { channel: 'linkedin' } : {}),
    }),
  },
  // a CalendarEvent: its Google id under the browser's name
  {
    table: 'calendar_events',
    key: 'id',
    cursor: 'updated_at',
    map: (r) => ({ ...r, externalEventId: r.externalId }),
  },
  {
    table: 'ties',
    key: 'id',
    cursor: 'updated_at',
    sources: `t.kind <> all($tieKinds::text[]) and ${personInUse('t.a_person_id')} and ${personInUse('t.b_person_id')}`,
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
  {
    table: 'tie_scores',
    key: 'person_id',
    cursor: 'updated_at',
    sources: personInUse('t.person_id'),
    // plan 35 B2: the browser reads a score and its band; the person page asks /scores/explain for the sentences and
    // the contributions behind them, and nothing in the browser reads the features
    omit: ['features', 'contributions', 'explanation'],
  },
  { table: 'tie_labels', key: 'person_id', cursor: 'updated_at', sources: personInUse('t.person_id') },
  {
    table: 'chats',
    key: 'id',
    cursor: 'updated_at',
    // a CoffeeChat: the stored camelCase fields spread under the columns
    map: ({ data, ...rest }) => ({
      ...((data as Record<string, unknown>) ?? {}),
      ...rest,
      ...(rest.orgId ? { organizationId: rest.orgId } : {}),
    }),
  },
  { table: 'stage_events', key: 'id', cursor: 'updated_at' },
  {
    table: 'drafts',
    key: 'id',
    cursor: 'updated_at',
    // the browser's OutboundMessage names: a reply carries its Gmail thread, so it goes out in it, under its subject
    map: (r) => ({
      ...r,
      ...(r.threadExternalId ? { externalThreadId: r.threadExternalId } : {}),
      ...(r.inReplyTo ? { inReplyToMessageId: r.inReplyTo } : {}),
    }),
  },
  { table: 'notes', key: 'id', cursor: 'updated_at' },
  { table: 'uploads', key: 'id', cursor: 'updated_at' },
  { table: 'facts', key: 'id', cursor: 'updated_at', deletedWhen: 't.deleted_at is not null' },
  { table: 'dossiers', key: 'id', cursor: 'updated_at' },
  { table: 'recommendations', key: 'id', cursor: 'updated_at' },
  { table: 'intro_requests', key: 'id', cursor: 'updated_at' },
  // plan 29 §B2.3: the cards and notices the reply funnel raises, in the browser's own shapes
  {
    table: 'suggestions',
    key: 'id',
    cursor: 'updated_at',
    map: (r) => ({ ...r, outboundMessageId: r.draftId ?? undefined, carriedOver: r.carriedOver ?? 0 }),
  },
  { table: 'notifications', key: 'id', cursor: 'updated_at' },
  // plan 43: the student's optional sources, their attached accounts, the "same person" questions, the lookups (status
  // and result only) and the texts a browser sent (counts, never words); core's mappers give the browser's shapes
  {
    table: 'source_states',
    key: 'source',
    cursor: 'updated_at',
    fromRow: (r) => ({ ...sourceStateFromRow(r as unknown as SourceRow.SourceStates) }),
  },
  {
    table: 'social_links',
    key: 'id',
    cursor: 'updated_at',
    sources: `t.platform <> all($hidden::text[]) and ${personInUse('t.person_id')}`,
    fromRow: (r) => ({ ...socialLinkFromRow(r as unknown as SourceRow.SocialLinks) }),
  },
  {
    table: 'social_match_asks',
    key: 'id',
    cursor: 'updated_at',
    sources: `t.platform <> all($hidden::text[]) and ${personInUse('t.person_id')}`,
    fromRow: (r) => ({ ...socialMatchAskFromRow(r as unknown as SourceRow.SocialMatchAsks) }),
  },
  {
    table: 'social_lookups',
    key: 'id',
    cursor: 'updated_at',
    sources: 't.platform <> all($hidden::text[])',
    omit: ['state', 'quoted_usd', 'cost_usd', 'notified', 'target_account_id'],
    fromRow: (r) => ({ ...socialLookupFromRow(r as unknown as SourceRow.SocialLookups) }),
  },
  {
    table: 'text_days',
    key: 'day_key',
    keySql: "t.person_id::text || ':' || t.day::text",
    cursor: 'updated_at',
    sources: `'imessage' <> all($hidden::text[]) and ${personInUse('t.person_id')}`,
    fromRow: (r) => ({ ...textDayFromRow(r as unknown as SourceRow.TextDays) }),
  },
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
  if (t.fromRow) return t.fromRow(r);
  const c = toCamel(r);
  return t.map ? t.map(c) : c;
}
