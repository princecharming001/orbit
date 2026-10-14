/**
 * Small pieces the ingestion modules share: timestamps from either driver as ISO strings, the per-provider
 * `integration_accounts.sync_state` sections (merged one section at a time, so jobs for different providers never
 * overwrite each other's progress), the user's own addresses, and orbit.people rows as core `Person`s.
 */

import { personFromRow, type Row } from '@orbit/core/server/mappers';
import { normalizeEmail } from '@orbit/core/text/normalize';
import type { Person } from '@orbit/core/types';
import type { Db } from '../db.ts';

/** A timestamp from postgres.js or PGlite (Date or text) as an ISO string. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A `date` column as YYYY-MM-DD. */
export function day(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return iso(v)?.slice(0, 10) ?? null;
}

export type Provider = 'google' | 'linkedin';

export interface Account {
  id: string;
  status: string;
  email: string | null;
  scopes: string[];
  externalAccountId: string | null;
  syncState: Record<string, Record<string, unknown>>;
}

export async function loadAccount(db: Db, userId: string, provider: Provider): Promise<Account | null> {
  const [a] = await db.sql<{
    id: string;
    status: string;
    email: string | null;
    scopes: string[];
    external_account_id: string | null;
    sync_state: Record<string, Record<string, unknown>> | null;
  }>`
    select id, status, email, scopes, external_account_id, sync_state from orbit.integration_accounts
     where user_id = ${userId}::uuid and provider = ${provider}`;
  if (!a) return null;
  return {
    id: a.id,
    status: a.status,
    email: a.email,
    scopes: a.scopes ?? [],
    externalAccountId: a.external_account_id,
    syncState: a.sync_state ?? {},
  };
}

/**
 * Merges `patch` into one top-level section of sync_state (gmail, calendar, contacts, linkedin), in one statement.
 * Keys in `patch` replace the section's keys; a null value is stored as null.
 */
export async function patchSyncState(
  db: Db,
  userId: string,
  provider: Provider,
  section: string,
  patch: Record<string, unknown>,
  extra: { lastSyncedAt?: Date; lastError?: string | null } = {},
): Promise<void> {
  await db.sql`
    update orbit.integration_accounts
       set sync_state = coalesce(sync_state, '{}'::jsonb)
             || jsonb_build_object(${section}::text,
                  coalesce(sync_state -> ${section}::text, '{}'::jsonb) || ${patch}::jsonb),
           last_synced_at = coalesce(${extra.lastSyncedAt ?? null}::timestamptz, last_synced_at),
           last_error = case when ${extra.lastError !== undefined}::boolean then ${extra.lastError ?? null}::text
                             else last_error end
     where user_id = ${userId}::uuid and provider = ${provider}`;
}

export interface SelfInfo {
  userId: string;
  selfId: string;
  /** every address the user sends from (normalized): sign-in address and the self person's email identities */
  emails: Set<string>;
  memberIds: Set<string>;
  fullName: string;
  firstName: string;
  school: string | null;
  currentCity: string | null;
  timezone: string;
  settings: Record<string, unknown>;
}

/** The user and their self person (created here when sign-in has not made one yet). */
export async function loadSelf(db: Db, userId: string): Promise<SelfInfo> {
  const [u] = await db.sql<{
    email: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    school: string | null;
    current_city: string | null;
    timezone: string;
    settings: Record<string, unknown> | null;
  }>`
    select email, full_name, first_name, last_name, school, current_city, timezone, settings
      from orbit.users where id = ${userId}::uuid`;
  if (!u) throw new Error('user not found');
  let [self] = await db.sql<{ id: string }>`
    select id from orbit.people where user_id = ${userId}::uuid and is_self`;
  if (!self) {
    const name = u.full_name ?? u.email;
    await db.sql`
      insert into orbit.people (user_id, is_self, display_name, first_name, last_name, name_norm, primary_email,
                                sources, first_seen_at)
      values (${userId}::uuid, true, ${name}, ${u.first_name}, ${u.last_name}, ${name.toLowerCase()},
              ${u.email}, ${['google']}::text[], now())
      on conflict (user_id) where is_self do nothing`;
    [self] = await db.sql<{ id: string }>`
      select id from orbit.people where user_id = ${userId}::uuid and is_self`;
  }
  const ids = await db.sql<{ kind: string; value_norm: string }>`
    select kind, value_norm from orbit.person_identities
     where user_id = ${userId}::uuid and person_id = ${self!.id}::uuid`;
  const emails = new Set([normalizeEmail(u.email)]);
  const memberIds = new Set<string>();
  for (const i of ids) {
    if (i.kind === 'email') emails.add(i.value_norm);
    if (i.kind === 'linkedin_member') memberIds.add(i.value_norm);
  }
  return {
    userId,
    selfId: self!.id,
    emails,
    memberIds,
    fullName: u.full_name ?? '',
    firstName: u.first_name ?? (u.full_name ?? '').split(' ')[0] ?? '',
    school: u.school,
    currentCity: u.current_city,
    timezone: u.timezone,
    settings: u.settings ?? {},
  };
}

/** The columns of orbit.people the resolver and the scorer read. */
export const PERSON_COLUMNS = `p.id, p.user_id, p.is_self, p.display_name, p.first_name, p.last_name, p.name_norm,
  p.primary_email, p.headline, p.title, p.org_id, p.org_raw, p.location, p.timezone, p.school, p.is_alumni,
  p.photo_url, p.linkedin_url, p.linkedin_slug, p.linkedin_member_id, p.relationship_type, p.sources,
  p.first_seen_at, p.last_interaction_at, p.strength, p.summary, p.tags, p.notes, p.do_not_contact, p.hidden_at,
  p.merged_into, p.created_at, p.updated_at, p.deleted_at`;

/** An orbit.people row (either driver) plus its identities as a core Person. */
export function toPerson(
  row: Record<string, unknown>,
  identities: { kind: string; value_norm: string }[] = [],
): Person {
  const r = {
    ...row,
    first_seen_at: iso(row.first_seen_at),
    last_interaction_at: iso(row.last_interaction_at),
    hidden_at: iso(row.hidden_at),
    created_at: iso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: iso(row.updated_at) ?? new Date(0).toISOString(),
    deleted_at: iso(row.deleted_at),
    strength: Number(row.strength ?? 0),
    sources: (row.sources as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
  } as unknown as Row.People;
  return personFromRow(r, {
    identities: identities.map((i) => ({ kind: i.kind, value_norm: i.value_norm })) as Row.PersonIdentities[],
  });
}

/** Chunks of at most n. */
export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** The 10-minute slot of a time, for dedupe keys of periodic work. */
export function slot(d: Date): string {
  return d.toISOString().slice(0, 15);
}
