/**
 * Rows from the server under the browser's names: a role's company (so About shows where and its logo), a merge
 * suggestion's two people, a thread's dates; rows stored before the server sent them are repaired; and a company's
 * LinkedIn logo, kept in this browser only, survives a newer row of the company from the server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { repairStoredNames, withBrowserNames, writeFromServer } from './serverSync';

const U = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  await wipeDatabase();
});
afterEach(async () => {
  await wipeDatabase();
});

describe('server rows under the browser names', () => {
  it('gives a role its company, a merge suggestion its people, a thread its dates', () => {
    expect(withBrowserNames('affiliations', { orgRaw: 'Jobright.ai', orgId: O })).toMatchObject({
      nameRaw: 'Jobright.ai',
      organizationId: O,
    });
    expect(withBrowserNames('affiliations', { orgRaw: null })).toMatchObject({ nameRaw: '' });
    expect(
      withBrowserNames('merge_suggestions', { personA: 'a', personB: 'b', status: 'open' }),
    ).toMatchObject({
      personAId: 'a',
      personBId: 'b',
      status: 'pending',
    });
    expect(withBrowserNames('threads', { firstAt: 'f', lastAt: 'l' })).toMatchObject({
      firstMessageAt: 'f',
      lastMessageAt: 'l',
    });
    // the browser's own name wins when the server already sends it
    expect(withBrowserNames('affiliations', { orgRaw: 'Old', nameRaw: 'New' }).nameRaw).toBe('New');
  });

  it('writes a pulled role with its company, and repairs one stored without it', async () => {
    await writeFromServer(
      'affiliations',
      [
        {
          id: 'a1',
          personId: P,
          kind: 'employment',
          title: 'Co-Founder',
          orgRaw: 'Jobright.ai',
          orgId: O,
          isCurrent: true,
          source: 'linkedin',
        },
      ],
      U,
    );
    expect(await db.affiliations.get('a1')).toMatchObject({ nameRaw: 'Jobright.ai', organizationId: O });
    // stored by an older build, with only the server's names
    await db.affiliations.put({
      id: 'a2',
      userId: U,
      personId: P,
      kind: 'employment',
      orgRaw: 'Box',
      orgId: O,
    } as never);
    await db.merges.put({ id: 'm1', userId: U, personA: P, personB: 'x', status: 'open' } as never);
    expect(await repairStoredNames()).toBeGreaterThanOrEqual(2);
    expect(await db.affiliations.get('a2')).toMatchObject({ nameRaw: 'Box', organizationId: O });
    expect(await db.merges.get('m1')).toMatchObject({ personAId: P, personBId: 'x', status: 'pending' });
  });

  it("keeps a company's LinkedIn logo when the server sends the company again", async () => {
    await db.organizations.put({
      id: O,
      name: 'Jobright.ai',
      nameNormalized: 'jobright.ai',
      domains: [],
      logoUrl: 'https://logos.example/jobright.png',
      linkedinCompanyId: '123',
    } as never);
    await writeFromServer(
      'organizations',
      [{ id: O, name: 'Jobright.ai', nameNorm: 'jobright.ai', domains: [], linkedinSlug: null }],
      U,
    );
    expect(await db.organizations.get(O)).toMatchObject({
      logoUrl: 'https://logos.example/jobright.png',
      linkedinCompanyId: '123',
    });
  });

  it("keeps a person's renewed photo when the server's row has none or an expired one", async () => {
    const fresh = 'https://media.licdn.com/dms/image/new/0?e=4102444800&v=beta&t=a';
    const old = 'https://media.licdn.com/dms/image/old/0?e=1600000000&v=beta&t=b';
    await db.people.put({ id: P, userId: U, displayName: 'Bo', photoUrl: fresh } as never);
    await writeFromServer('people', [{ id: P, displayName: 'Bo', photoUrl: old }], U);
    expect((await db.people.get(P))!.photoUrl).toBe(fresh);
    await writeFromServer('people', [{ id: P, displayName: 'Bo', photoUrl: null }], U);
    expect((await db.people.get(P))!.photoUrl).toBe(fresh);
    // a working photo from the server is the server's to set
    const theirs = 'https://media.licdn.com/dms/image/theirs/0?e=4102444800&v=beta&t=c';
    await writeFromServer('people', [{ id: P, displayName: 'Bo', photoUrl: theirs }], U);
    expect((await db.people.get(P))!.photoUrl).toBe(theirs);
  });
});
