import { describe, expect, it } from 'vitest';
import type { SyncIntegration, SyncStatus } from '../integrations/orbitApi';
import { arriving } from './PeopleArriving';

const integration = (o: Partial<SyncIntegration>): SyncIntegration => ({
  provider: 'google',
  status: 'active',
  email: null,
  scopes: [],
  linked: true,
  lastSyncedAt: null,
  lastError: null,
  watchExpiresAt: null,
  backfill: null,
  ...o,
});
const status = (people: number, integrations: SyncIntegration[] = []): SyncStatus => ({
  counts: { people },
  integrations,
  jobs: { pending: 0 },
});

describe('arriving (the map while people come in)', () => {
  it('says nothing once the map has caught up, or without a server', () => {
    expect(arriving(undefined, 10)).toBeUndefined();
    // the browser also holds the student's own record, which the server's count leaves out
    expect(arriving(status(1198), 1199)).toBeUndefined();
    expect(arriving(status(1200), 1198)).toBeUndefined();
  });

  it('counts the people still on their way, with a bar that fills', () => {
    expect(arriving(status(6046), 1198)).toEqual({
      lead: 'Loading 4,848 more people',
      detail: '1,198 of 6,046 on the map',
      share: 1198 / 6046,
    });
  });

  it("names LinkedIn's import while it runs, without a share since its total still grows", () => {
    const a = arriving(status(1198, [integration({ provider: 'linkedin', importing: true })]), 1198);
    expect(a).toEqual({ lead: 'Bringing in your LinkedIn connections', detail: '1,198 on the map so far' });
  });

  it('names the email import while it reads', () => {
    const a = arriving(
      status(300, [integration({ backfill: { phase: 'deep', done: 400, total: 4000 } })]),
      120,
    );
    expect(a?.lead).toBe('Reading your email for more people');
    expect(a?.detail).toBe('120 of 300 on the map');
    expect(a?.share).toBeUndefined();
  });
});
