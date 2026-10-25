/**
 * What enrichment keeps in this browser (Dexie's key-value table, so no schema change): one record per person (what
 * each step found, with the source and confidence of every field it filled), the day's budget per kind of call, and
 * the queue of who to look at next.
 */
import { db } from '../../db/schema';

/** Where a field came from. `orbit` is what Orbit already had (signatures, calendar, notes, imports). */
export type EnrichSource =
  | 'orbit'
  | 'gravatar'
  | 'linkedin_profile'
  | 'linkedin_search'
  | 'exa'
  | 'firecrawl'
  | 'apollo'
  | 'people_data_labs';

export type EnrichField =
  | 'currentTitle'
  | 'currentOrganizationId'
  | 'headline'
  | 'location'
  | 'photoUrl'
  | 'linkedin'
  | 'experience'
  | 'education'
  | 'contact'
  | 'about'
  | 'web';

export interface Provenance {
  source: EnrichSource;
  /** 0–1: how sure Orbit is that this is right and is this person's */
  confidence: number;
  at: string;
  /** the value, when it is short enough to keep beside the field (for "why does Orbit think this") */
  value?: string;
}

export interface JobChange {
  from: { title?: string; company?: string };
  to: { title?: string; company?: string };
  /** when Orbit saw it */
  observedAt: string;
  /** when the new role started, from LinkedIn */
  startedAt?: string;
}

export interface EnrichmentRecord {
  personId: string;
  userId: string;
  fields: Partial<Record<EnrichField, Provenance>>;
  /** the last full profile read */
  profileAt?: string;
  /** that read had the full experience and education sections, not the previews (the About work history) */
  fullAt?: string;
  /** the last read LinkedIn held sections back on */
  throttledAt?: string;
  searchedAt?: string;
  searchResult?: 'matched' | 'none' | 'ambiguous' | 'suggested';
  gravatarAt?: string;
  webAt?: string;
  web?: { url: string; title?: string; confidence: number }[];
  about?: string;
  /** what LinkedIn shares with the student about a 1st-degree connection; kept to join their mail and texts only */
  contact?: { emails: string[]; phones: string[] };
  jobChange?: JobChange;
}

const recKey = (personId: string) => `enrich:rec:${personId}`;

export async function readRecord(personId: string): Promise<EnrichmentRecord | undefined> {
  return (await db.kv.get(recKey(personId)))?.value as EnrichmentRecord | undefined;
}

export function newRecord(userId: string, personId: string): EnrichmentRecord {
  return { userId, personId, fields: {} };
}

export async function writeRecord(rec: EnrichmentRecord): Promise<void> {
  await db.kv.put({ key: recKey(rec.personId), value: rec });
}

export async function deleteRecord(personId: string): Promise<void> {
  await db.kv.delete(recKey(personId));
}

/** Every record of this student, by person. */
export async function allRecords(userId: string): Promise<Map<string, EnrichmentRecord>> {
  const rows = await db.kv.where('key').startsWith('enrich:rec:').toArray();
  const out = new Map<string, EnrichmentRecord>();
  for (const r of rows) {
    const v = r.value as EnrichmentRecord | undefined;
    if (v?.userId === userId) out.set(v.personId, v);
  }
  return out;
}

/** Note where a field came from, unless a surer note is already there. */
export function noteField(
  rec: EnrichmentRecord,
  field: EnrichField,
  p: Omit<Provenance, 'at'>,
  now: Date,
  force = false,
): void {
  const cur = rec.fields[field];
  if (!force && cur && cur.confidence > p.confidence && cur.source !== 'orbit') return;
  rec.fields[field] = { ...p, value: p.value?.slice(0, 160), at: now.toISOString() };
}

// ---------- the day's budget ----------

/** Kinds of call, each with its own daily allowance. */
export type BudgetKind = 'profile' | 'view' | 'search' | 'company' | 'gravatar' | 'web';

/**
 * Calls a day. LinkedIn notices heavy profile viewing and searching, so these stay well under Orbit's server caps
 * (80 profiles, 40 searches a day per account): background reads first, plus a few more for people the student opens.
 */
export const DAILY: Record<BudgetKind, number> = {
  profile: 30,
  view: 15,
  search: 10,
  company: 20,
  gravatar: 60,
  web: 10,
};

export interface Budget {
  day: string;
  used: Partial<Record<BudgetKind, number>>;
  /** LinkedIn asked to slow down (throttled sections, a 429, Orbit's server limit): no LinkedIn calls until then */
  pausedUntil?: string;
  pauseReason?: string;
}

const budgetKey = (userId: string) => `enrich:budget:${userId}`;
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

export async function readBudget(userId: string, now: Date): Promise<Budget> {
  const b = (await db.kv.get(budgetKey(userId)))?.value as Budget | undefined;
  const day = dayOf(now);
  if (!b) return { day, used: {} };
  return b.day === day ? b : { day, used: {}, pausedUntil: b.pausedUntil, pauseReason: b.pauseReason };
}

export async function writeBudget(userId: string, b: Budget): Promise<void> {
  await db.kv.put({ key: budgetKey(userId), value: b });
}

export function budgetLeft(b: Budget, kind: BudgetKind, limits: Record<BudgetKind, number> = DAILY): number {
  return Math.max(0, (limits[kind] ?? 0) - (b.used[kind] ?? 0));
}

export function linkedInPaused(b: Budget, now: Date): boolean {
  return !!b.pausedUntil && Date.parse(b.pausedUntil) > now.getTime();
}

export async function spend(userId: string, kind: BudgetKind, now: Date): Promise<void> {
  const b = await readBudget(userId, now);
  b.used[kind] = (b.used[kind] ?? 0) + 1;
  await writeBudget(userId, b);
}

/** Stop LinkedIn calls until tomorrow (UTC), with the reason Settings shows. */
export async function pauseLinkedIn(userId: string, now: Date, reason: string): Promise<void> {
  const b = await readBudget(userId, now);
  const until = new Date(`${dayOf(now)}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 1);
  b.pausedUntil = until.toISOString();
  b.pauseReason = reason;
  await writeBudget(userId, b);
}

// ---------- the queue ----------

export interface QueueState {
  builtAt: string;
  ids: string[];
}

const queueKey = (userId: string) => `enrich:queue:${userId}`;

export async function readQueue(userId: string): Promise<QueueState | undefined> {
  return (await db.kv.get(queueKey(userId)))?.value as QueueState | undefined;
}

export async function writeQueue(userId: string, q: QueueState): Promise<void> {
  await db.kv.put({ key: queueKey(userId), value: q });
}

export interface LastRun {
  at: string;
  looked: number;
  profiles: number;
  matched: number;
  stopped?: string;
}

const lastKey = (userId: string) => `enrich:last:${userId}`;

export async function readLastRun(userId: string): Promise<LastRun | undefined> {
  return (await db.kv.get(lastKey(userId)))?.value as LastRun | undefined;
}

export async function writeLastRun(userId: string, r: LastRun): Promise<void> {
  await db.kv.put({ key: lastKey(userId), value: r });
}
