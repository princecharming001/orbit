/**
 * Account mode's sync with orbit-api (plan 16 §11.3, §12): the server is the source of truth and the browser's
 * Dexie database is its cache.
 *
 * - Pull: POST /sync/pull with the cursor kept in `kv`, page by page, writing the rows (already shaped as the core
 *   types) into their tables in dependency order and deleting the ids the server says are gone.
 * - Push: the student's own changes (chats, stage events, notes, people they added and the hand-edited fields of
 *   people, resumes, draft edits and discards, closeness ratings, forgotten memories) are noted in the `outbox` table
 *   by Dexie hooks on the tables they live in, wherever in the app the write happens, and go up through POST
 *   /sync/push every few seconds and when the tab is hidden. Rows written by a pull are marked, so they never echo
 *   back.
 * - Status: /sync/status every 3 seconds while setup's import runs and every minute after, never while the tab is
 *   hidden; a change in the counts pulls. Each pull pushes the outbox first, so it never writes over a local edit.
 *
 * Ids: the server keys rows by uuid. Rows made in this browser carry a prefixed id ("chat_<uuid>"): they go up under
 * the uuid, and the alias is remembered so the copy that comes back on the next pull keeps the local id.
 */
import type {
  CoffeeChat,
  Goal,
  MeetingNote,
  OutboundMessage,
  Person,
  Resume,
  ResumeFacet,
  StageEvent,
  User,
} from '@orbit/core';
import { chatToRow, normalizeCompany, noteToRow, stageEventToRow } from '@orbit/core';
import Dexie, { type Table, type Transaction } from 'dexie';
import { db, type OutboxRow, type TieLabelRow } from '../db/schema';
import {
  accountUser,
  callApi,
  isAccountMode,
  isSignedIn,
  type PushChange,
  type SyncStatus,
} from '../integrations/orbitApi';
import { endActivity, startActivity } from './activity';
import { linkedInImageExpired } from './photos';

// ---- tables -------------------------------------------------------------------------------------------------------

/** Where each pulled orbit table goes in Dexie, in the order rows are written (parents before children). */
export const PULL_TARGETS: { table: string; dexie: string }[] = [
  { table: 'organizations', dexie: 'organizations' },
  { table: 'people', dexie: 'people' },
  { table: 'person_identities', dexie: 'personIdentities' },
  { table: 'affiliations', dexie: 'affiliations' },
  { table: 'merge_suggestions', dexie: 'merges' },
  { table: 'goals', dexie: 'userGoals' },
  { table: 'threads', dexie: 'threads' },
  { table: 'messages', dexie: 'messages' },
  { table: 'calendar_events', dexie: 'events' },
  { table: 'ties', dexie: 'edges' },
  { table: 'tie_scores', dexie: 'tieScores' },
  { table: 'tie_labels', dexie: 'tieLabels' },
  { table: 'chats', dexie: 'chats' },
  { table: 'stage_events', dexie: 'stageEvents' },
  { table: 'drafts', dexie: 'outbound' },
  { table: 'notes', dexie: 'notes' },
  { table: 'facts', dexie: 'facts' },
  { table: 'dossiers', dexie: 'dossiers' },
  { table: 'recommendations', dexie: 'recommendations' },
  { table: 'intro_requests', dexie: 'introRequests' },
];
const DEXIE_OF = new Map(PULL_TARGETS.map((t) => [t.table, t.dexie]));

/** The order pushes go up in, so a chat exists before its stage events and notes. */
const PUSH_ORDER = [
  'people',
  'goals',
  'chats',
  'stage_events',
  'notes',
  'uploads',
  'tie_labels',
  'drafts',
  'memories',
];

const CURSOR_KEY = 'serverSync.cursor';
const CURSOR_OWNER_KEY = 'serverSync.cursorUser';
const ALIAS_KEY = 'serverSync.aliases';
const MAX_PAGES = 200;
const PULL_LIMIT = 500;

// ---- ids ----------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED = /^[a-z]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** The id a local row goes up under: the uuid itself, or the uuid inside a prefixed id; undefined otherwise. */
export function serverIdOf(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  if (UUID.test(id)) return id.toLowerCase();
  const m = PREFIXED.exec(id);
  return m ? m[1]!.toLowerCase() : undefined;
}

let aliasCache: Record<string, string> | undefined;

async function aliases(): Promise<Record<string, string>> {
  aliasCache ??= ((await db.kv.get(ALIAS_KEY))?.value as Record<string, string> | undefined) ?? {};
  return aliasCache;
}

async function rememberAliases(pairs: [string, string][]): Promise<void> {
  const map = await aliases();
  let changed = false;
  for (const [server, local] of pairs)
    if (server !== local && map[server] !== local) {
      map[server] = local;
      changed = true;
    }
  if (changed) await Dexie.ignoreTransaction(() => db.kv.put({ key: ALIAS_KEY, value: map }));
}

const REF_FIELDS = ['personId', 'chatId', 'goalId', 'threadId'] as const;

/** A pulled row with its id and references mapped back to the local ids of rows made in this browser. */
function localize(row: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.id === 'string' && map[out.id]) out.id = map[out.id];
  for (const f of REF_FIELDS) {
    const v = out[f];
    if (typeof v === 'string' && map[v]) out[f] = map[v];
  }
  if (Array.isArray(out.personIds))
    out.personIds = out.personIds.map((v) => (typeof v === 'string' && map[v]) || v);
  return out;
}

// ---- writes from the server ----------------------------------------------------------------------------------------

/** Transactions that carry rows from the server: the outbox hooks skip them. */
const serverTx = new WeakSet<object>();

function fromServer(trans: Transaction | undefined): boolean {
  let t = trans as (Transaction & { parent?: Transaction }) | undefined;
  for (let i = 0; t && i < 5; i++, t = t.parent) if (serverTx.has(t)) return true;
  const cur = Dexie.currentTransaction as (Transaction & { parent?: Transaction }) | null;
  for (let t2 = cur ?? undefined, i = 0; t2 && i < 5; i++, t2 = t2.parent) if (serverTx.has(t2)) return true;
  return false;
}

function nameParts(displayName: string): { first: string; last: string } {
  const parts = displayName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/**
 * Server column names (generic camelCase) and the names the browser's screens read, per table: a row from a server
 * that does not rename them yet (or one stored before it did) still shows its company, people and dates.
 */
const RENAMED: Record<string, [server: string, browser: string][]> = {
  affiliations: [
    ['orgRaw', 'nameRaw'],
    ['orgId', 'organizationId'],
  ],
  merge_suggestions: [
    ['personA', 'personAId'],
    ['personB', 'personBId'],
  ],
  threads: [
    ['firstAt', 'firstMessageAt'],
    ['lastAt', 'lastMessageAt'],
    ['externalId', 'externalThreadId'],
  ],
  calendar_events: [['externalId', 'externalEventId']],
  chats: [['orgId', 'organizationId']],
};
const MERGE_STATUS: Record<string, string> = { open: 'pending', merged: 'accepted' };

/** The browser's names filled in from the server's, where only the server's are there. */
export function withBrowserNames(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const pairs = RENAMED[table];
  if (!pairs) return row;
  const r = { ...row };
  for (const [from, to] of pairs) if (r[to] === undefined && r[from] != null) r[to] = r[from];
  if (table === 'affiliations' && typeof r.nameRaw !== 'string') r.nameRaw = '';
  if (table === 'merge_suggestions' && typeof r.status === 'string')
    r.status = MERGE_STATUS[r.status] ?? r.status;
  return r;
}

/** Fields the browser's screens rely on, filled where a server row leaves them out. */
function withDefaults(table: string, row: Record<string, unknown>, userId: string): Record<string, unknown> {
  const r: Record<string, unknown> = { userId, ...withBrowserNames(table, row) };
  if (table === 'people') {
    const name = typeof r.displayName === 'string' ? r.displayName : '';
    const { first, last } = nameParts(name);
    const score = typeof r.tieScore === 'number' ? r.tieScore : undefined;
    return {
      firstName: first,
      lastName: last,
      nameNormalized: name.toLowerCase(),
      emails: typeof r.primaryEmail === 'string' && r.primaryEmail ? [r.primaryEmail] : [],
      tags: [],
      sources: [],
      relationshipType: 'unknown',
      interactionCount: 0,
      isHuman: true,
      strength: score !== undefined ? score / 100 : 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...stripNulls(r),
    };
  }
  if (table === 'goals')
    return {
      targets: { organizations: [], roles: [], geographies: [], people: [] },
      criteria: {},
      priority: 2,
      status: 'active',
      source: 'user',
      ...stripNulls(r),
    };
  if (table === 'tie_labels' || table === 'tie_scores') return { updatedAt: new Date().toISOString(), ...r };
  // the map keys a company's wedge by nameNormalized: a server row names it nameNorm
  if (table === 'organizations')
    return stripNulls({ ...r, nameNormalized: r.nameNormalized ?? r.nameNorm ?? companyNorm(r.name) });
  if (table === 'drafts' && typeof r.bodyDraft !== 'string' && typeof r.body === 'string')
    return stripNulls({ ...r, bodyDraft: r.body });
  return stripNulls(r);
}

const companyNorm = (name: unknown) => (typeof name === 'string' ? normalizeCompany(name) : undefined);

/**
 * Companies pulled before the server named nameNormalized carry only nameNorm, so picking one never turned the map to
 * its wedge: fill it in once, as a server write (nothing is queued to go back up).
 */
export async function repairStoredCompanies(): Promise<number> {
  return db.transaction('rw', db.organizations, async (tx) => {
    serverTx.add(tx);
    return db.organizations
      .filter((o) => !o.nameNormalized && !!((o as { nameNorm?: string }).nameNorm || o.name))
      .modify((o) => {
        o.nameNormalized = (o as { nameNorm?: string }).nameNorm || normalizeCompany(o.name);
      });
  });
}

/**
 * Rows pulled before the server sent the browser's names (a role's company, a merge suggestion's two people, a
 * thread's dates) carry only the server's: fill the browser's in once, as a server write. Pulls only send rows that
 * changed, so without this the old ones would stay blank.
 */
export async function repairStoredNames(): Promise<number> {
  let n = 0;
  for (const [table, dexie] of [
    ['affiliations', db.affiliations],
    ['merge_suggestions', db.merges],
    ['threads', db.threads],
    ['calendar_events', db.events],
    ['chats', db.chats],
  ] as const) {
    const t = dexie as unknown as Table<Record<string, unknown>, string>;
    const [server] = RENAMED[table]![0]!;
    n += await db.transaction('rw', t, async (tx) => {
      serverTx.add(tx);
      return t
        .filter((r) => r[server] != null || (table === 'merge_suggestions' && r.status === 'open'))
        .modify((r) => {
          const fixed = withBrowserNames(table, r);
          for (const [k, v] of Object.entries(fixed)) if (r[k] !== v) r[k] = v;
        });
    });
  }
  return n;
}

/** The photos a person's row may carry up: LinkedIn's image host or Gravatar, as the server accepts. */
const PUSHABLE_PHOTO = /^https:\/\/([a-z0-9-]+\.)*(licdn\.com|gravatar\.com)\//;

/** What a company row learns in this browser alone (enrichment/logos adoptCompany), never sent by the server. */
const LOCAL_ORG_FIELDS = ['logoUrl', 'linkedinCompanyId', 'linkedinSlug'];

/** Postgres nulls become absent fields, as the core types expect. */
function stripNulls(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (v !== null) out[k] = v;
  return out;
}

function dexieTable(name: string): Table<Record<string, unknown>, string> {
  return db.table(name) as Table<Record<string, unknown>, string>;
}

/**
 * Write rows that came from the server (a pull, or a route's answer) into Dexie, unchanged but for local ids and
 * defaults, without queueing them to go back up. Tie scores also land on the person, whose strength is score / 100.
 * `pending` holds outbox keys (`${table}:${id}`) whose rows are left as they are: a local edit not yet pushed.
 */
export async function writeFromServer(
  table: string,
  rows: Record<string, unknown>[] | Goal[],
  userId: string,
  deleted: string[] = [],
  pending?: Set<string>,
): Promise<number> {
  const dexie = DEXIE_OF.get(table);
  if (!dexie || (!rows.length && !deleted.length)) return 0;
  const map = await aliases();
  const t = dexieTable(dexie);
  let ready = (rows as Record<string, unknown>[]).map((r) => withDefaults(table, localize(r, map), userId));
  // a closeness rating is queued under its person's id, everything else under its own
  if (pending?.size)
    ready = ready.filter(
      (r) => !pending.has(`${table}:${String(table === 'tie_labels' ? r.personId : r.id)}`),
    );
  // a sourced candidate the server keeps for Find people is not a recommendation from the network yet
  if (table === 'recommendations')
    ready = ready.filter((r) => typeof r.personId === 'string' && typeof r.score === 'number');
  const gone = deleted.map((id) => map[id] ?? id);
  const tables = [t, ...(table === 'tie_scores' ? [db.people] : [])];
  await db.transaction('rw', tables, async (tx) => {
    serverTx.add(tx);
    // a company's LinkedIn logo and id are kept in this browser only (the server has no columns for them): a newer
    // row of the company from the server keeps them, or every pull would blank the logos the queue just fetched
    if (table === 'organizations' && ready.length) {
      const had = await t.bulkGet(ready.map((r) => String(r.id)));
      ready = ready.map((r, i) => {
        const old = had[i];
        if (!old) return r;
        const kept: Record<string, unknown> = {};
        for (const k of LOCAL_ORG_FIELDS) if (r[k] === undefined && old[k] !== undefined) kept[k] = old[k];
        return { ...r, ...kept };
      });
    }
    // a person's photo this browser renewed stays when the server's row has none, or only an expired link
    if (table === 'people' && ready.length) {
      const had = await t.bulkGet(ready.map((r) => String(r.id)));
      ready = ready.map((r, i) => {
        const mine = had[i]?.photoUrl;
        const theirs = r.photoUrl;
        if (typeof mine !== 'string' || mine === theirs || linkedInImageExpired(mine)) return r;
        return typeof theirs !== 'string' || linkedInImageExpired(theirs) ? { ...r, photoUrl: mine } : r;
      });
    }
    if (ready.length) await t.bulkPut(ready);
    if (gone.length) await t.bulkDelete(gone);
    if (table === 'tie_scores')
      for (const s of ready) {
        const score = Number(s.score);
        if (!Number.isFinite(score) || typeof s.personId !== 'string') continue;
        await db.people.update(s.personId, {
          tieScore: score,
          tieBand: s.band as Person['tieBand'],
          tieExplanation: Array.isArray(s.explanation) ? (s.explanation as string[]) : undefined,
          strength: score / 100,
        });
      }
  });
  return ready.length + gone.length;
}

// ---- pull ---------------------------------------------------------------------------------------------------------

export interface PullOutcome {
  ok: boolean;
  /** rows written or deleted */
  changed: number;
  pages: number;
  /** which orbit tables changed */
  tables: string[];
  /** pages remain: the pull stopped at its page cap, and the next pull carries on from the cursor */
  more?: boolean;
  message?: string;
}

let pulling: Promise<PullOutcome> | undefined;

/**
 * Run `fn` holding the cross-tab pull lock (a Web Lock where the browser has them): two tabs pulling at once read
 * the same cursor, fetch the same pages and save each other's cursor back over their own.
 */
function withPullLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (locks?.request) return locks.request('orbit-sync-pull', fn) as Promise<T>;
  return fn();
}

/** Pull every page of changes since the stored cursor. One pull at a time, in this tab and across tabs. */
export function pullNow(userId: string, opts: { signal?: AbortSignal } = {}): Promise<PullOutcome> {
  pulling ??= withPullLock(async () => {
    // local edits go up first, so the rows that come down already carry them
    await pushOutbox().catch(() => undefined);
    // the cursor belongs to the account it was saved for: one saved for another account (or before cursors said whose
    // they were) is dropped, so this account's pull starts from the beginning and nothing older than it is skipped
    const owner = (await db.kv.get(CURSOR_OWNER_KEY))?.value;
    if (owner !== userId) {
      await db.kv.delete(CURSOR_KEY);
      await db.kv.put({ key: CURSOR_OWNER_KEY, value: userId });
    }
    let changed = 0;
    let pages = 0;
    let more = true;
    const tables = new Set<string>();
    for (; pages < MAX_PAGES && more; ) {
      const cursor = (await db.kv.get(CURSOR_KEY))?.value as string | undefined;
      const r = await callApi('/sync/pull', { cursor, limit: PULL_LIMIT }, opts);
      if (!r.ok) return { ok: false, changed, pages, tables: [...tables], message: r.message };
      pages++;
      const { changes, deleted, hasMore } = r.value;
      // what is still queued (the push failed, or an edit since): the server's copy of those rows waits
      await flushQueue();
      const pending = new Set((await db.outbox.toCollection().primaryKeys()) as string[]);
      for (const { table } of PULL_TARGETS) {
        const n = await writeFromServer(
          table,
          changes?.[table] ?? [],
          userId,
          deleted?.[table] ?? [],
          pending,
        );
        if (n) {
          changed += n;
          tables.add(table);
        }
      }
      await db.kv.put({ key: CURSOR_KEY, value: r.value.cursor });
      more = !!hasMore;
    }
    return { ok: true, changed, pages, tables: [...tables], more };
  }).finally(() => {
    pulling = undefined;
  });
  return pulling;
}

/** Forget the cursor and aliases (sign-out, a different account): the next pull starts from the beginning. */
export async function resetSyncState(): Promise<void> {
  aliasCache = undefined;
  await db.kv.bulkDelete([CURSOR_KEY, CURSOR_OWNER_KEY, ALIAS_KEY]);
  await db.outbox.clear();
}

// ---- push ---------------------------------------------------------------------------------------------------------

/**
 * Which Dexie tables feed the outbox, and the orbit table each goes to. `key` names the field that holds the id the
 * change goes up under: a closeness rating goes up as its person, a resume line as its resume (the whole upload is
 * sent again with the line as edited; `owned: false` because a line carries no user id, so the upload's own row is
 * checked when it is built).
 */
const OUTBOX_SOURCES: { dexie: string; table: string; key?: 'personId' | 'resumeId'; owned?: false }[] = [
  { dexie: 'chats', table: 'chats' },
  { dexie: 'stageEvents', table: 'stage_events' },
  { dexie: 'notes', table: 'notes' },
  { dexie: 'people', table: 'people' },
  { dexie: 'outbound', table: 'drafts' },
  { dexie: 'tieLabels', table: 'tie_labels', key: 'personId' },
  { dexie: 'resumes', table: 'uploads' },
  { dexie: 'resumeFacets', table: 'uploads', key: 'resumeId', owned: false },
];

/** Whether a write to this row should go to the server: account mode, signed in, and the student's own row. */
function outboxWanted(row: { userId?: unknown } | undefined, owned = true): boolean {
  if (!isAccountMode() || !isSignedIn()) return false;
  const me = accountUser()?.id;
  if (!me || !row) return false;
  return !owned || row.userId === me;
}

let queued = new Map<string, Pick<OutboxRow, 'table' | 'id' | 'op'>>();
let queueTimer: ReturnType<typeof setTimeout> | undefined;
/** the writes to the outbox table, one after another, so a flush waits for one the timer already started */
let persisting: Promise<void> = Promise.resolve();

function persistSoon(): Promise<void> {
  persisting = persisting.then(persistQueued, persistQueued);
  return persisting;
}

/** Note a change for the outbox; written to the `outbox` table just after the transaction that made it. */
export function queueChange(table: string, id: string, op: OutboxRow['op'] = 'upsert'): void {
  queued.set(`${table}:${id}`, { table, id, op });
  queueTimer ??= setTimeout(() => {
    queueTimer = undefined;
    void persistSoon();
  }, 0);
}

async function persistQueued(): Promise<void> {
  const batch = queued;
  queued = new Map();
  if (!batch.size) return;
  const now = new Date().toISOString();
  await Dexie.ignoreTransaction(async () => {
    const existing = await db.outbox.bulkGet([...batch.keys()]);
    await db.outbox.bulkPut(
      [...batch.entries()].map(([key, c], i) => ({
        key,
        ...c,
        attempts: 0,
        createdAt: existing[i]?.createdAt ?? now,
        updatedAt: now,
      })),
    );
  });
}

/** Resolves when every queued change has reached the outbox table. */
export async function flushQueue(): Promise<void> {
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = undefined;
  }
  await persistSoon();
}

let hooksInstalled = false;

/** Watch the student's tables for changes to send up. Installed once; does nothing outside account mode. */
export function installOutboxHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const src of OUTBOX_SOURCES) {
    const t = dexieTable(src.dexie);
    const idOf = (obj: Record<string, unknown>, key: unknown) =>
      String(src.key ? (obj[src.key] ?? key) : (obj.id ?? key));
    // a resume line changed or removed: its upload goes up again, never deleted for one line
    const delOp: OutboxRow['op'] = src.dexie === 'resumeFacets' ? 'upsert' : 'delete';
    t.hook('creating', function (key, obj, trans) {
      if (fromServer(trans) || !outboxWanted(obj, src.owned ?? true)) return;
      this.onsuccess = () => queueChange(src.table, idOf(obj, key));
    });
    t.hook('updating', function (_mods, key, obj, trans) {
      if (fromServer(trans) || !outboxWanted(obj, src.owned ?? true)) return;
      this.onsuccess = () => queueChange(src.table, idOf(obj, key));
    });
    t.hook('deleting', function (key, obj, trans) {
      if (fromServer(trans) || !outboxWanted(obj, src.owned ?? true)) return;
      this.onsuccess = () => queueChange(src.table, idOf(obj, key), delOp);
    });
  }
}

/** Queue a memory's deletion (the memory itself lives only on the server). */
export function queueMemoryDelete(memoryId: string): void {
  queueChange('memories', memoryId, 'delete');
}

const ACTORS = new Set(['user', 'agent', 'system']);

function pick<T extends Record<string, unknown>>(row: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the student typed about someone they added, in the server's field names; values it would refuse are left out. */
function typedPersonFields(p: Person): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, v: string | undefined, max: number) => {
    const t = v?.trim();
    if (t && t.length <= max) out[key] = t;
  };
  put('firstName', p.firstName, 100);
  put('lastName', p.lastName, 100);
  if (p.primaryEmail && EMAIL.test(p.primaryEmail.trim())) put('primaryEmail', p.primaryEmail, 320);
  put('title', p.currentTitle, 300);
  put('orgRaw', p.currentOrganizationRaw, 300);
  put('linkedinUrl', p.linkedinUrl, 500);
  put('location', p.location, 200);
  return out;
}

export const UPLOAD_TEXT_MAX = 500_000;
export const UPLOAD_PARSED_MAX = 200_000;

/**
 * The facets read from a resume, as the upload's `parsed`, in the server's field names (`org`, which its drafting
 * reads); lines the student unticked are left out, since they must never describe the student. The longest lists are
 * cut to stay under the limit.
 */
export function parsedResume(r: Resume, facets: ResumeFacet[]): Record<string, unknown> | null {
  let kept = facets
    .filter((f) => !f.excluded)
    .map(({ resumeId: _r, organizationName, excluded: _e, ...f }) => ({
      ...f,
      ...(organizationName ? { org: organizationName } : {}),
    }));
  for (;;) {
    const parsed = { parseSource: r.parseSource ?? null, parsedAt: r.parsedAt ?? null, facets: kept };
    if (JSON.stringify(parsed).length <= UPLOAD_PARSED_MAX) return parsed;
    if (!kept.length) return null;
    kept = kept.slice(0, Math.floor(kept.length / 2));
  }
}

/**
 * The change for one outbox entry, built from the row as it is now; undefined when it cannot go to the server (a
 * row the server does not keep, a reference to someone only this browser knows) or when nothing is left to send.
 */
async function buildChange(entry: OutboxRow, pairs: [string, string][]): Promise<PushChange | undefined> {
  const sid = serverIdOf(entry.id);
  if (!sid) return undefined;
  if (sid !== entry.id) pairs.push([sid, entry.id]);
  const ref = (id: string | undefined | null) => (id ? (serverIdOf(id) ?? null) : null);
  if (entry.op === 'delete') {
    // the server deletes notes, uploads, closeness ratings and memories; a chat or a person is never deleted here
    if (!['notes', 'uploads', 'tie_labels', 'memories'].includes(entry.table)) return undefined;
    return { table: entry.table, op: 'delete', id: sid };
  }
  const at = new Date().toISOString();
  switch (entry.table) {
    case 'chats': {
      const c = (await db.chats.get(entry.id)) as CoffeeChat | undefined;
      if (!c) return undefined;
      const r = chatToRow(c);
      const personId = ref(r.person_id);
      if (!personId) return undefined;
      return {
        table: 'chats',
        op: 'upsert',
        id: sid,
        row: {
          personId,
          goalId: ref(r.goal_id),
          orgId: ref(r.org_id),
          stage: r.stage,
          stageEnteredAt: r.stage_entered_at,
          data: r.data,
          archivedAt: r.archived_at,
        },
      };
    }
    case 'stage_events': {
      const e = (await db.stageEvents.get(entry.id)) as StageEvent | undefined;
      if (!e) return undefined;
      const r = stageEventToRow(e, at);
      const chatId = ref(r.chat_id);
      if (!chatId) return undefined;
      const actor = String(r.actor ?? 'user');
      return {
        table: 'stage_events',
        op: 'upsert',
        id: sid,
        row: {
          chatId,
          fromStage: r.from_stage,
          toStage: r.to_stage,
          status: r.status,
          actor: ACTORS.has(actor) ? actor : actor.startsWith('user') ? 'user' : 'system',
          reason: r.reason,
          evidence: r.evidence,
          confidence: r.confidence,
          decidedAt: r.decided_at,
        },
      };
    }
    case 'notes': {
      const n = (await db.notes.get(entry.id)) as MeetingNote | undefined;
      if (!n) return undefined;
      const r = noteToRow(n, at);
      return {
        table: 'notes',
        op: 'upsert',
        id: sid,
        row: {
          personIds: (r.person_ids ?? []).map((p) => serverIdOf(p)).filter((p): p is string => !!p),
          chatId: ref(r.chat_id),
          source: r.source,
          title: r.title,
          occurredAt: r.occurred_at,
          rawText: r.raw_text,
          extraction: r.extraction,
        },
      };
    }
    case 'people': {
      const p = (await db.people.get(entry.id)) as Person | undefined;
      if (!p) return undefined;
      // the hand-edited fields; everything else about a person the server knows is derived there
      const row = pick(p as unknown as Record<string, unknown>, [
        'displayName',
        'notes',
        'tags',
        'relationshipType',
        'hiddenAt',
        'doNotContact',
      ]);
      // a photo this browser fetched (an expired LinkedIn link renewed, a missing one found) goes up while it works,
      // so the next pull, and every other device, shows it instead of initials
      if (p.photoUrl && PUSHABLE_PHOTO.test(p.photoUrl) && !linkedInImageExpired(p.photoUrl))
        row.photoUrl = p.photoUrl;
      // someone added in this browser: the server creates them from what was typed (and ignores these afterwards)
      if (sid !== entry.id) Object.assign(row, { displayName: p.displayName }, typedPersonFields(p));
      return { table: 'people', op: 'upsert', id: sid, row };
    }
    case 'uploads': {
      const r = (await db.resumes.get(entry.id)) as Resume | undefined;
      // a resume line's change names its upload: only the student's own goes up
      if (!r || r.userId !== accountUser()?.id) return undefined;
      const facets = await db.resumeFacets.where('resumeId').equals(entry.id).toArray();
      return {
        table: 'uploads',
        op: 'upsert',
        id: sid,
        row: {
          kind: 'resume',
          filename: r.filename?.slice(0, 300) || null,
          text: r.text.slice(0, UPLOAD_TEXT_MAX),
          parsed: parsedResume(r, facets),
          isCurrent: r.isCurrent,
        },
      };
    }
    case 'drafts': {
      if (sid !== entry.id) return undefined;
      const d = (await db.outbound.get(entry.id)) as OutboundMessage | undefined;
      if (!d) return undefined;
      if (d.status === 'cancelled')
        return { table: 'drafts', op: 'upsert', id: sid, row: { status: 'discarded' } };
      if (d.status !== 'draft') return undefined;
      return {
        table: 'drafts',
        op: 'upsert',
        id: sid,
        row: { body: d.bodyFinal ?? d.bodyDraft, subject: d.subject ?? null },
      };
    }
    case 'tie_labels': {
      const l = (await db.tieLabels.get(entry.id)) as TieLabelRow | undefined;
      if (!l || !isUuid(entry.id)) return undefined;
      return { table: 'tie_labels', op: 'upsert', id: sid, row: { closeness: l.closeness } };
    }
    default:
      return undefined;
  }
}

/** Permanent refusals: the change is dropped. Anything else is tried again later (up to five times). */
const PERMANENT = new Set(['invalid', 'not_allowed', 'not_found', 'conflict']);
const MAX_ATTEMPTS = 5;
const PUSH_BATCH = 500;

export interface PushOutcome {
  ok: boolean;
  sent: number;
  failed: number;
  dropped: number;
  message?: string;
}

let pushing: Promise<PushOutcome> | undefined;

/** Send what the outbox holds through /sync/push. One push at a time. */
export function pushOutbox(): Promise<PushOutcome> {
  pushing ??= (async (): Promise<PushOutcome> => {
    await flushQueue();
    const entries = await db.outbox.orderBy('createdAt').limit(PUSH_BATCH).toArray();
    if (!entries.length) return { ok: true, sent: 0, failed: 0, dropped: 0 };
    const pairs: [string, string][] = [];
    const changes: { entry: OutboxRow; change: PushChange }[] = [];
    const unsendable: string[] = [];
    for (const entry of entries) {
      const change = await buildChange(entry, pairs);
      if (change) changes.push({ entry, change });
      else unsendable.push(entry.key);
    }
    if (unsendable.length) await db.outbox.bulkDelete(unsendable);
    if (!changes.length) return { ok: true, sent: 0, failed: 0, dropped: unsendable.length };
    changes.sort((a, b) => PUSH_ORDER.indexOf(a.change.table) - PUSH_ORDER.indexOf(b.change.table));
    await rememberAliases(pairs);
    const r = await callApi('/sync/push', { changes: changes.map((c) => c.change) });
    if (!r.ok) {
      // nothing went up; everything stays queued for the next try
      return { ok: false, sent: 0, failed: changes.length, dropped: unsendable.length, message: r.message };
    }
    let sent = 0;
    let failed = 0;
    let dropped = unsendable.length;
    const results = r.value.results ?? [];
    for (let i = 0; i < changes.length; i++) {
      const { entry } = changes[i]!;
      const res = results[i];
      // a row edited again while this push was out stays queued: its newer version goes next time
      const now = await db.outbox.get(entry.key);
      if (res?.ok) {
        sent++;
        if (now && now.updatedAt === entry.updatedAt) await db.outbox.delete(entry.key);
      } else if (res?.error && PERMANENT.has(res.error.code)) {
        dropped++;
        if (now && now.updatedAt === entry.updatedAt) await db.outbox.delete(entry.key);
      } else {
        failed++;
        const attempts = (now?.attempts ?? entry.attempts) + 1;
        if (attempts >= MAX_ATTEMPTS) await db.outbox.delete(entry.key);
        else if (now) await db.outbox.update(entry.key, { attempts, lastError: res?.error?.message });
      }
    }
    return { ok: failed === 0, sent, failed, dropped };
  })().finally(() => {
    pushing = undefined;
  });
  return pushing;
}

// ---- status ---------------------------------------------------------------------------------------------------------

let lastStatus: SyncStatus | undefined;
const statusListeners = new Set<(s: SyncStatus | undefined) => void>();

export function syncStatusNow(): SyncStatus | undefined {
  return lastStatus;
}

export function subscribeSyncStatus(fn: (s: SyncStatus | undefined) => void): () => void {
  statusListeners.add(fn);
  // listeners hear only changes, so a new one starts from the latest answer (one that came between its render and
  // this call would otherwise never reach it)
  fn(lastStatus);
  return () => {
    statusListeners.delete(fn);
  };
}

let lastStatusJson = '';

function setStatus(s: SyncStatus | undefined): void {
  // the same answer as last time changes nothing on screen
  const json = JSON.stringify(s ?? null);
  if (json === lastStatusJson) return;
  lastStatusJson = json;
  lastStatus = s;
  // the status line: what the server still has queued for this account (the import, the reads it runs)
  const pending = s?.jobs.pending ?? 0;
  if (pending > 0)
    startActivity(
      'server-jobs',
      `Orbit's server is reading your accounts · ${pending} ${pending === 1 ? 'job' : 'jobs'} left`,
    );
  else endActivity('server-jobs');
  for (const l of statusListeners) l(s);
}

/** Ask the server where the import is; the answer is kept for the Setup line and the progress card. */
export async function refreshSyncStatus(): Promise<SyncStatus | undefined> {
  const r = await callApi('/sync/status', {});
  if (!r.ok) return lastStatus;
  setStatus(r.value);
  return r.value;
}

/** The Google integration as the server sees it. */
export function googleStatus(s: SyncStatus | undefined = lastStatus) {
  return s?.integrations.find((i) => i.provider === 'google');
}

/** Google's import has finished (both the recent and the older email are in). */
export function backfillDone(s: SyncStatus | undefined): boolean {
  const phase = googleStatus(s)?.backfill?.phase;
  return !!phase && phase !== 'recent' && phase !== 'deep';
}

// ---- the loop -------------------------------------------------------------------------------------------------------

export const STATUS_EVERY_ONBOARDING_MS = 3_000;
export const STATUS_EVERY_MS = 60_000;
export const PUSH_EVERY_MS = 10_000;
/** after a pull that changed rows, the brief is rebuilt at most this often */
const DERIVED_EVERY_MS = 5 * 60_000;

export interface SyncLoopOptions {
  user: Pick<User, 'id' | 'onboardingCompletedAt'>;
  /** setup is in progress: poll every 3 seconds until Google's import is done */
  onboarding: boolean;
  /** rebuild the brief and suggestions after rows change (the app passes generateBrief) */
  onPulled?: (outcome: PullOutcome) => Promise<void> | void;
}

let lastDerived = 0;

/**
 * Start syncing for the signed-in user: a pull at once, the status poll (paused while the tab is hidden), the outbox
 * flush on a timer and when the tab hides. Returns a stop function.
 */
export function startServerSync(o: SyncLoopOptions): () => void {
  installOutboxHooks();
  void repairStoredCompanies().catch(() => undefined);
  void repairStoredNames().catch(() => undefined);
  let stopped = false;
  let lastCounts = '';
  const derived = async (out: PullOutcome) => {
    if (!out.changed || !o.onPulled) return;
    const now = Date.now();
    if (now - lastDerived < DERIVED_EVERY_MS && !o.onboarding) return;
    lastDerived = now;
    await o.onPulled(out);
  };
  const pull = async () => {
    if (stopped) return;
    let out = await pullNow(o.user.id).catch(() => undefined);
    // a first pull of a big network runs past the page cap: carry on until the server has nothing more
    for (let changed = out?.changed ?? 0; out?.ok && out.more && !stopped; ) {
      const next = await pullNow(o.user.id).catch(() => undefined);
      if (!next) break;
      changed += next.changed;
      out = { ...next, changed, tables: [...new Set([...out.tables, ...next.tables])] };
    }
    if (out?.ok) await derived(out).catch(() => undefined);
  };
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  let every = o.onboarding ? STATUS_EVERY_ONBOARDING_MS : STATUS_EVERY_MS;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  const poll = async () => {
    if (stopped || hidden()) return;
    const s = await refreshSyncStatus().catch(() => undefined);
    // the import is in: no need to watch it every 3 seconds, even before setup's last step
    if (every !== STATUS_EVERY_MS && backfillDone(s)) {
      every = STATUS_EVERY_MS;
      clearInterval(statusTimer);
      statusTimer = setInterval(poll, every);
    }
    const counts = JSON.stringify(s?.counts ?? {});
    if (s && counts !== lastCounts) {
      lastCounts = counts;
      await pull();
    }
  };
  // an empty outbox makes no request, so the timer runs while hidden too (a send can finish in the background)
  const push = () => {
    if (!stopped) void pushOutbox().catch(() => undefined);
  };
  void (async () => {
    await pull();
    await poll();
  })();
  statusTimer = setInterval(poll, every);
  const pushTimer = setInterval(push, PUSH_EVERY_MS);
  // hiding sends what is queued; coming back checks the server at once instead of waiting for the next tick
  const onVisibility = () => (hidden() ? push() : void poll());
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopped = true;
    clearInterval(statusTimer);
    clearInterval(pushTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Test hook: forget in-memory state (aliases, status, the queue). */
export function resetServerSyncForTests(): void {
  aliasCache = undefined;
  lastStatus = undefined;
  lastStatusJson = '';
  queued = new Map();
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = undefined;
  persisting = Promise.resolve();
  lastDerived = 0;
  statusListeners.clear();
}
