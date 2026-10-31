import { beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
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

  it('takes the one rulebook’s settings from the server: the ladder’s kinds, the mode, a pause and the limits', async () => {
    const u = await adoptAccountUser(
      account({
        settings: {
          auto_kinds: ['bump', 'thank_you', 'not_a_kind'],
          autopilot_mode: 'assist',
          autopilot_paused_until: '2026-11-03T00:00:00.000Z',
          daily_send_cap_gmail: 8,
          daily_send_cap_linkedin: 4,
        },
      }),
    );
    const s = (await db.settings.get(u.id))!;
    expect(s.autoKinds).toEqual(['bump', 'thank_you']);
    expect(s.autopilotMode).toBe('assist');
    expect(s.autopilotPausedUntil).toBe('2026-11-03T00:00:00.000Z');
    expect(s.dailySendCapGmail).toBe(8);
    expect(s.dailySendCapLinkedin).toBe(4);
    // an account that never chose: the browser's defaults stand
    const plain = await adoptAccountUser(
      account({ id: '22222222-2222-4222-8222-222222222222', settings: {} }),
    );
    const p = (await db.settings.get(plain.id))!;
    expect(p.autopilotMode).toBeUndefined();
    expect(p.autoKinds).toBeUndefined();
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
