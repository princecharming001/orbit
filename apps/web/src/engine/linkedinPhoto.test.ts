import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { createLocalUser } from './account';
import { adoptLinkedInPhoto } from './linkedinLive';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQ';

describe("the student's LinkedIn photo", () => {
  beforeEach(async () => {
    await wipeDatabase();
    setUnipileUrlForTests('https://proxy.test/orbit-connectors');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ firstName: 'Sam', picture: PHOTO }), { status: 200 })),
    );
  });
  afterEach(() => {
    setUnipileUrlForTests(undefined);
    vi.unstubAllGlobals();
  });

  it('becomes their picture as soon as LinkedIn is connected', async () => {
    const u = await createLocalUser({ fullName: 'Sam Lee' });
    expect(await adoptLinkedInPhoto(u.id, 'acc_1', 'tok', { replace: true })).toBe(true);
    expect((await db.users.get(u.id))?.avatarUrl).toBe(PHOTO);
  });

  it('a later sync fills a missing picture but never replaces one from elsewhere', async () => {
    const u = await createLocalUser({
      fullName: 'Sam Lee',
      avatarUrl: 'https://lh3.googleusercontent.com/me.jpg',
    });
    expect(await adoptLinkedInPhoto(u.id, 'acc_1', 'tok')).toBe(false);
    expect((await db.users.get(u.id))?.avatarUrl).toBe('https://lh3.googleusercontent.com/me.jpg');
    const v = await createLocalUser({ fullName: 'Ana Ruiz' });
    expect(await adoptLinkedInPhoto(v.id, 'acc_1', 'tok')).toBe(true);
    expect((await db.users.get(v.id))?.avatarUrl).toBe(PHOTO);
  });

  it('no photo on LinkedIn keeps the initials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ firstName: 'Sam' }), { status: 200 })),
    );
    const u = await createLocalUser({ fullName: 'Sam Lee' });
    expect(await adoptLinkedInPhoto(u.id, 'acc_1', 'tok', { replace: true })).toBe(false);
    expect((await db.users.get(u.id))?.avatarUrl).toBeUndefined();
  });
});
