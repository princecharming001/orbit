import type { User } from '@orbit/core';
import { adoptAccountUser } from '../engine/accountMode';
import { resetServerSyncForTests } from '../engine/serverSync';
import {
  clearSession,
  completeSignIn,
  resetSessionForTests,
  setOrbitApiBaseForTests,
  setOrbitApiFetchForTests,
} from '../integrations/orbitApi';
import { createFakeOrbitApi, type FakeOrbitApi } from './fakeOrbitApi';

/** Turn account mode on against a fake orbit-api and sign in, the way /auth/done does. */
export async function signInToFakeApi(
  opts: Parameters<typeof createFakeOrbitApi>[0] = {},
): Promise<{ api: FakeOrbitApi; user: User }> {
  const api = createFakeOrbitApi(opts);
  setOrbitApiBaseForTests(api.base);
  setOrbitApiFetchForTests(api.fetch);
  resetSessionForTests();
  resetServerSyncForTests();
  const r = await completeSignIn(`#code=${api.code}`);
  if (!r.ok) throw new Error(r.message);
  const user = await adoptAccountUser(r.user);
  return { api, user };
}

/** Back to local mode: the session forgotten and the build's own settings restored. */
export async function leaveFakeApi(): Promise<void> {
  await clearSession();
  resetSessionForTests();
  resetServerSyncForTests();
  setOrbitApiFetchForTests(undefined);
  setOrbitApiBaseForTests(undefined);
}
