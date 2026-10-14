import type { User, UserSettings } from '@orbit/core';
import { newId } from '@orbit/core';
import { CURRENT_USER_KEY } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { disconnectGoogle } from '../integrations/google';
import { clearSession, isSignedIn } from '../integrations/orbitApi';
import { clearPrefs } from '../integrations/prefs';
import { generateBrief, recommendationsRefresh } from './brief';

/** The setup is done: the welcome brief and the first recommendations are built, and the chat opens. */
export const ONBOARDING_DONE_STEP = 11;

export async function createLocalUser(partial: Partial<User> = {}): Promise<User> {
  const now = new Date().toISOString();
  const id = newId('u');
  const user: User = {
    id,
    email: partial.email ?? '',
    fullName: partial.fullName ?? '',
    firstName: partial.firstName ?? '',
    lastName: partial.lastName ?? '',
    school: partial.school ?? '',
    majors: [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    // setup opens on its Welcome step (see pages/onboardingSteps.ts)
    onboardingStep: 1,
    createdAt: now,
    ...partial,
  };
  const settings: UserSettings = {
    userId: id,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app'],
    quietDays: [],
    weeklyOutreachTarget: 4,
    dailySendCapGmail: 15,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 72,
    maxBumps: 2,
    tonePreset: 'warm',
    warmUpEnabled: true,
    warmUpDays: 4,
  };
  await db.users.put(user);
  await db.settings.put(settings);
  return user;
}

/**
 * Leave the demo for the student's own setup: the sample data is cleared from this browser and a new, empty profile
 * starts onboarding. Only the demo's data goes; the demo holds nothing of the student's.
 */
export async function leaveDemoForOwnSetup(): Promise<User> {
  await wipeDatabase();
  return createLocalUser();
}

/** Continue, Back or Skip in setup: the furthest step reached is kept, so a Back never loses progress. */
export async function setOnboardingStep(userId: string, next: number): Promise<number | undefined> {
  const user = await db.users.get(userId);
  if (!user) return undefined;
  const step = Math.max(user.onboardingStep, next);
  await db.users.update(userId, { onboardingStep: step });
  return step;
}

/** Finish setup: the student's recommendations and welcome brief are built from what they entered. */
export async function finishOnboarding(userId: string, now = new Date()): Promise<User | undefined> {
  const user = await db.users.get(userId);
  if (!user) return undefined;
  await db.users.update(userId, {
    onboardingStep: ONBOARDING_DONE_STEP,
    onboardingCompletedAt: now.toISOString(),
  });
  const fresh = (await db.users.get(userId))!;
  await recommendationsRefresh(fresh, now);
  await generateBrief(fresh, 'welcome', now);
  return fresh;
}

/** Everything Orbit stores about the network, table by table (the browser-local prefs, with the key, are not here). */
export async function exportAllData(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of db.tables.map((x) => x.name)) out[t] = await db.table(t).toArray();
  return out;
}

export function exportFilename(now = new Date()): string {
  return `orbit-export-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Delete all Orbit data from this browser: Google is disconnected, the local prefs (the key) cleared, the database
 * wiped and the session ended. Cannot be undone.
 */
export async function deleteAllData(): Promise<void> {
  disconnectGoogle();
  // an Orbit session goes too: this browser forgets the account (the account itself is deleted in Settings, Account)
  if (isSignedIn()) await clearSession();
  await clearPrefs();
  await wipeDatabase();
  await db.kv.delete(CURRENT_USER_KEY);
}
