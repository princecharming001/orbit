/**
 * The browser's side of an Orbit account (plan 16 §11.3, §17): after Google sign-in the local user row takes the
 * account's id, so every row the server sends (keyed by that user) belongs to it; signing out keeps the data on this
 * device and stops syncing; deleting the account removes it on the server and here.
 */
import type { User, UserSettings } from '@orbit/core';
import { getCurrentUserId, setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';
import {
  type AccountUser,
  callApi,
  clearSession,
  isAccountMode,
  isSignedIn,
  signOutAccount,
} from '../integrations/orbitApi';
import { createLocalUser, deleteAllData } from './account';
import { resetSyncState } from './serverSync';

/** The step setup goes to after Google: You, with the name and email Google gave already filled in. */
export const AFTER_GOOGLE_STEP = 2;

/**
 * Make the signed-in account the current local user. A fresh profile made by "Get started" (no people, setup not
 * finished) is replaced; a returning student on this device keeps their row and their setup progress.
 */
export async function adoptAccountUser(a: AccountUser, now = new Date()): Promise<User> {
  const previousId = await getCurrentUserId();
  const previous = previousId ? await db.users.get(previousId) : undefined;
  const existing = await db.users.get(a.id);
  let user: User;
  if (existing) {
    const patch: Partial<User> = {};
    if (!existing.email) patch.email = a.email;
    if (!existing.fullName && a.fullName) patch.fullName = a.fullName;
    if (!existing.firstName && a.firstName) patch.firstName = a.firstName;
    if (!existing.lastName && a.lastName) patch.lastName = a.lastName;
    if (Object.keys(patch).length) await db.users.update(a.id, patch);
    user = { ...existing, ...patch };
  } else {
    // a different account than the one this browser last synced: start its pull from the beginning
    await resetSyncState();
    user = await createLocalUser({
      id: a.id,
      email: a.email,
      fullName: a.fullName ?? previous?.fullName ?? '',
      firstName: a.firstName ?? previous?.firstName ?? '',
      lastName: a.lastName ?? previous?.lastName ?? '',
      school: a.school ?? previous?.school ?? '',
      graduationYear: a.gradYear ?? previous?.graduationYear,
      timezone: a.timezone || previous?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      avatarUrl: a.avatarUrl ?? undefined,
      onboardingStep: Math.max(previous?.onboardingStep ?? 1, AFTER_GOOGLE_STEP),
      onboardingCompletedAt: previous?.onboardingCompletedAt,
      createdAt: now.toISOString(),
    });
  }
  if (previous && previous.id !== a.id && !previous.onboardingCompletedAt) {
    const people = await db.people.where('userId').equals(previous.id).count();
    if (people === 0) {
      await db.users.delete(previous.id);
      await db.settings.delete(previous.id);
      await db.goals.delete(previous.id);
    }
  }
  // the server's autonomy level is the student's choice; the browser keeps a copy for Settings and the chat
  if (a.autonomyLevel === 0 || a.autonomyLevel === 1 || a.autonomyLevel === 2)
    await db.settings.update(user.id, { autonomyLevel: a.autonomyLevel } as Partial<UserSettings>);
  // the postal address and booking link the server drafts with, where this browser has none yet
  const local = (await db.settings.get(user.id)) as (UserSettings & { postalAddress?: string }) | undefined;
  const fromServer: Record<string, string> = {};
  if (typeof a.settings?.postal_address === 'string' && !local?.postalAddress)
    fromServer.postalAddress = a.settings.postal_address;
  if (typeof a.settings?.scheduling_link === 'string' && !local?.schedulingLink)
    fromServer.schedulingLink = a.settings.scheduling_link;
  if (local && Object.keys(fromServer).length)
    await db.settings.update(user.id, fromServer as Partial<UserSettings>);
  await setCurrentUserId(user.id);
  return user;
}

/** Sign out of Orbit on this device: the session ends, syncing stops, the data already here stays. */
export async function signOutHere(): Promise<void> {
  await signOutAccount();
}

/** Download everything the server holds for the account, as one JSON file. */
export async function exportAccount(): Promise<{ ok: true; json: string } | { ok: false; message: string }> {
  const r = await callApi('/account/export', {});
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, json: JSON.stringify(r.value, null, 2) };
}

/** Delete the account on the server (Google access revoked, LinkedIn unlinked), then everything in this browser. */
export async function deleteAccount(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isAccountMode() || !isSignedIn())
    return { ok: false, message: 'You are not signed in to an Orbit account.' };
  const r = await callApi('/account/delete', { confirm: 'DELETE' });
  if (!r.ok) return { ok: false, message: r.message };
  await clearSession();
  await deleteAllData();
  return { ok: true };
}
