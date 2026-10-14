import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSecret } from '../../functions/_shared/secrets.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

describe('resolveSecret', () => {
  it('prefers the environment, falls back to the Vault secret the migration generated, and is undefined without either', async () => {
    const none = () => undefined;
    expect(await resolveSecret(() => 'from-env', t.db, 'ORBIT_SESSION_SECRET', 'orbit_session_secret')).toBe(
      'from-env',
    );
    const fromVault = await resolveSecret(none, t.db, 'ORBIT_SESSION_SECRET', 'orbit_session_secret');
    expect(fromVault).toMatch(/^[0-9a-f]{64}$/);
    expect(await resolveSecret(none, t.db, 'X', 'orbit_no_such_secret')).toBeUndefined();
    expect(await resolveSecret(none, undefined, 'X', 'orbit_session_secret')).toBeUndefined();
  });
});
