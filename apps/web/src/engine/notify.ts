/**
 * Plan 40: is Orbit ready yet, and how the student hears that it is.
 *
 * Account mode asks orbit-notify (POST /notify/status): the server works readiness out from the import's own state
 * (Gmail's phase, LinkedIn's stage, the jobs still queued) with the same `readiness()` the email uses, and says where
 * "Orbit is ready" goes (the account's email, and a text to the phone number when one is saved and texting is set
 * up). When that function cannot be reached, readiness is worked out here from the /sync/status the app already
 * polls, so the chip never goes blank.
 *
 * Local mode (no account) has no server to tell anyone: the phone number is kept in this browser only.
 */
import type { Readiness, ReadinessInput, User } from '@orbit/core';
import { readiness } from '@orbit/core';
import { db } from '../db/schema';
import {
  callApi,
  isAccountMode,
  isSignedIn,
  type NotifyContactRequest,
  type NotifyStatus,
  type SyncStatus,
} from '../integrations/orbitApi';

export type { NotifyStatus };

const LOCAL_KEY = (userId: string) => `notify:contact:${userId}`;

export interface Contact {
  email: string | null;
  phone: string | null;
  country: string | null;
  emailOn: boolean;
  smsOn: boolean;
}

/** Readiness from a /sync/status answer: what the chip shows when orbit-notify has not answered. */
export function readinessFromSync(s: SyncStatus | undefined): Readiness | undefined {
  if (!s) return undefined;
  const g = s.integrations.find((i) => i.provider === 'google');
  const li = s.integrations.find((i) => i.provider === 'linkedin');
  return readiness({
    google: g
      ? {
          status: g.status,
          phase: g.backfill?.phase ?? (g.status === 'active' ? 'recent' : null),
          done: g.backfill?.done,
          total: g.backfill?.total,
        }
      : undefined,
    linkedin: li
      ? {
          status: li.status,
          // the status says only whether the first pass is still going
          stage: li.importing ? 'relations' : li.lastSyncedAt ? 'done' : 'relations',
          syncedAt: li.importing ? null : li.lastSyncedAt,
        }
      : undefined,
    pending: s.jobs.pending,
    counts: s.counts,
  });
}

/**
 * Plan 43 §6: the Texts step, which this browser knows best (it read the Messages file). Added to an answer that has
 * none; it never changes the state or the progress, so it never holds up "ready".
 */
export function withTextsStep(r: Readiness, texts: ReadinessInput['texts'] | undefined): Readiness {
  if (!texts || r.steps.some((s) => s.key === 'texts')) return r;
  const step = readiness({ pending: 0, texts }).steps.find((s) => s.key === 'texts');
  return step ? { ...r, steps: [...r.steps, step] } : r;
}

/** Where the student's texts stand, for the Texts step: only while they are switched on. */
export async function textsReadiness(userId: string | undefined): Promise<ReadinessInput['texts']> {
  if (!userId) return undefined;
  const { textsStatus } = await import('./imessage');
  const s = await textsStatus({ id: userId });
  if (s.state !== 'on') return undefined;
  return { state: 'on', people: s.people, importedAt: s.imported ? (s.lastSyncedAt ?? null) : null };
}

/** Where the import stands and how the student will hear, from the server; undefined when it cannot say. */
export async function notifyStatus(): Promise<NotifyStatus | undefined> {
  if (!isAccountMode() || !isSignedIn()) return undefined;
  const r = await callApi('/notify/status', {});
  return r.ok ? r.value : undefined;
}

/** The phone number and the ways to be told, as saved (this browser's copy in local mode). */
export async function loadContact(user: Pick<User, 'id' | 'email'>): Promise<Contact> {
  if (isAccountMode() && isSignedIn()) {
    const s = await notifyStatus();
    if (s) return s.contact;
  }
  const row = await db.kv.get(LOCAL_KEY(user.id));
  const saved = (row?.value ?? {}) as Partial<Contact>;
  return {
    email: user.email ?? null,
    phone: saved.phone ?? null,
    country: saved.country ?? null,
    emailOn: saved.emailOn ?? true,
    smsOn: saved.smsOn ?? !!saved.phone,
  };
}

export type SaveContactResult = { ok: true; contact: Contact } | { ok: false; message: string };

/**
 * Save a phone number (E.164, or null to remove it) with the country it was entered for, and which ways to be told.
 * The server checks the number again; a bad one comes back as a plain message.
 */
export async function saveContact(
  user: Pick<User, 'id' | 'email'>,
  req: NotifyContactRequest,
): Promise<SaveContactResult> {
  if (isAccountMode() && isSignedIn()) {
    const r = await callApi('/notify/contact', req);
    if (r.ok) return { ok: true, contact: r.value.contact };
    return { ok: false, message: r.message };
  }
  const now = await loadContact(user);
  const next: Contact = {
    ...now,
    ...(req.phone !== undefined ? { phone: req.phone } : {}),
    ...(req.country !== undefined ? { country: req.country } : {}),
    ...(req.emailOn !== undefined ? { emailOn: req.emailOn } : {}),
    ...(req.smsOn !== undefined ? { smsOn: req.smsOn } : req.phone ? { smsOn: true } : {}),
  };
  await db.kv.put({ key: LOCAL_KEY(user.id), value: next });
  return { ok: true, contact: next };
}
