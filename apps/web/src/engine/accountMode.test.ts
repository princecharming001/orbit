import { beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { wipeDatabase } from '../db/schema';
import type { AccountUser } from '../integrations/orbitApi';
import { createLocalUser, ONBOARDING_DONE_STEP } from './account';
import { AFTER_GOOGLE_STEP, adoptAccountUser } from './accountMode';

const account = (patch: Partial<AccountUser> = {}): AccountUser => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'sam@cornell.edu',
  fullName: 'Sam Lee',
  firstName: 'Sam',
  lastName: 'Lee',
  avatarUrl: null,
  school: 'Cornell University',
  gradYear: 2027,
  timezone: 'America/New_York',
  autonomyLevel: 1,
  settings: {},
  onboarding: {},
  createdAt: '2026-10-01T00:00:00Z',
  ...patch,
});

describe('logging in with Google', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });

  it('a new account starts setup after the Google step', async () => {
    const u = await adoptAccountUser(account());
    expect(u.onboardingCompletedAt).toBeUndefined();
    expect(u.onboardingStep).toBe(AFTER_GOOGLE_STEP);
  });

  it('an account that finished setup on another device goes straight to Orbit', async () => {
    const u = await adoptAccountUser(account({ onboarding: { completed_at: '2026-10-05T12:00:00Z' } }));
    expect(u.onboardingCompletedAt).toBe('2026-10-05T12:00:00Z');
    expect(u.onboardingStep).toBe(ONBOARDING_DONE_STEP);
  });

  it('logging in from the demo carries nothing of the sample student over', async () => {
    await createLocalUser({
      id: 'demo-user',
      school: 'Demo University',
      onboardingStep: ONBOARDING_DONE_STEP,
      onboardingCompletedAt: '2026-10-01T00:00:00Z',
    });
    await setCurrentUserId('demo-user');
    const u = await adoptAccountUser(account({ school: null }));
    expect(u.onboardingCompletedAt).toBeUndefined();
    expect(u.school).toBe('');
  });
});
