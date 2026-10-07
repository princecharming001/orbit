import type { User, UserSettings } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, wipeDatabase } from '../db/schema';

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
    onboardingStep: 2,
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
