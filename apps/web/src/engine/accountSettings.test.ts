import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import { type FakeOrbitApi, fakeAccountUser } from '../test/fakeOrbitApi';
import { createLocalUser } from './account';
import { outreachSettings, setPostalAddress } from './outreach';
import { savePreferences, setSchedulingLink, updateProfile } from './settings';

describe('profile settings reach the server in account mode', () => {
  let api: FakeOrbitApi;
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    ({ api, user } = await signInToFakeApi());
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  const profileCalls = () => api.calls.filter((c) => c.route === '/settings/profile').map((c) => c.body);

  it('the postal address: saved here and on the server, cleared on both, unchanged sends nothing', async () => {
    await setPostalAddress(user.id, '  1 Main St, Ithaca, NY 14850 ');
    expect((await outreachSettings(user.id)).postalAddress).toBe('1 Main St, Ithaca, NY 14850');
    expect(api.state.profile.postalAddress).toBe('1 Main St, Ithaca, NY 14850');
    await setPostalAddress(user.id, '1 Main St, Ithaca, NY 14850');
    await setPostalAddress(user.id, '');
    expect(api.state.profile.postalAddress).toBeNull();
    expect(profileCalls()).toEqual([
      { postalAddress: '1 Main St, Ithaca, NY 14850' },
      { postalAddress: null },
    ]);
  });

  it('the scheduling link, from Settings and from the setup step', async () => {
    await setSchedulingLink(user.id, 'https://cal.com/maya/20min');
    expect(api.state.profile.schedulingLink).toBe('https://cal.com/maya/20min');
    await savePreferences(user.id, { schedulingLink: ' ', briefTimeLocal: '08:00' });
    expect(api.state.profile.schedulingLink).toBeNull();
    expect((await db.settings.get(user.id))?.schedulingLink).toBeUndefined();
    // the brief time alone is the browser's own: nothing goes up
    await savePreferences(user.id, { briefTimeLocal: '09:00' });
    expect(profileCalls()).toHaveLength(2);
    // the server refuses an http link; the local copy is kept all the same
    await setSchedulingLink(user.id, 'http://cal.com/maya');
    expect((await db.settings.get(user.id))?.schedulingLink).toBe('http://cal.com/maya');
    expect(api.state.profile.schedulingLink).toBeNull();
  });

  it('the time zone, only when it changes', async () => {
    await updateProfile(user.id, { fullName: 'Maya Lin', timezone: user.timezone });
    expect(profileCalls()).toEqual([]);
    await updateProfile(user.id, { timezone: 'America/Los_Angeles' });
    expect(api.state.profile.timezone).toBe('America/Los_Angeles');
    expect((await db.users.get(user.id))?.timezone).toBe('America/Los_Angeles');
    expect(profileCalls()).toEqual([{ timezone: 'America/Los_Angeles' }]);
  });
});

describe('profile settings in local mode', () => {
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  it('stay in the browser', async () => {
    const user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex', school: 'Cornell' });
    await setPostalAddress(user.id, '1 Main St');
    await setSchedulingLink(user.id, 'https://cal.com/alex');
    expect((await outreachSettings(user.id)).postalAddress).toBe('1 Main St');
    expect((await db.settings.get(user.id))?.schedulingLink).toBe('https://cal.com/alex');
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it("copies the server's postal address and booking link where this browser has none", async () => {
    const { user } = await signInToFakeApi({
      user: fakeAccountUser({
        settings: { postal_address: '20 Elm St, Ithaca, NY', scheduling_link: 'https://cal.com/maya' },
      }),
    });
    expect((await outreachSettings(user.id)).postalAddress).toBe('20 Elm St, Ithaca, NY');
    expect((await db.settings.get(user.id))?.schedulingLink).toBe('https://cal.com/maya');
  });
});

describe('typing a link', () => {
  beforeEach(async () => {
    await wipeDatabase();
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('saves on every key, and the server ends on the last value with the sends in order', async () => {
    const { api, user } = await signInToFakeApi();
    const link = 'https://cal.com/maya';
    await Promise.all([...link].map((_, i) => setSchedulingLink(user.id, link.slice(0, i + 1))));
    expect(api.state.profile.schedulingLink).toBe(link);
    const sent = api.calls
      .filter((c) => c.route === '/settings/profile')
      .map((c) => String(c.body.schedulingLink ?? ''));
    // one send at a time, never an older value after a newer one
    expect(sent.at(-1)).toBe(link);
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.length).toBeGreaterThan(sent[i - 1]!.length);
  });
});
