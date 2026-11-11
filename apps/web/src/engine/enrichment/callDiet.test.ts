import { describe, expect, it } from 'vitest';
import {
  accountToken,
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  memorySharedReads,
  memoryTake,
} from '../../../../../supabase/functions/orbit-connectors/connectors';
import { aliases, type CallCount, covers } from '../../../../../supabase/functions/orbit-connectors/people';

/**
 * Plan 41: Orbit never asks LinkedIn for what it already has. Every read of a person is kept once (what anyone would
 * see for every student, what depends on the reader for that account, the photo copied into storage), and /profile,
 * /photo and /mutuals look there before they read. Unipile is stubbed by URL; every upstream call is recorded.
 */
const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const SIGNING = 'test-signing-key-not-a-real-one';
const TOKEN = await accountToken('a1', SIGNING);
const TOKEN_B = await accountToken('b2', SIGNING);
const licdn = (n: string) => `https://media.licdn.com/dms/image/v2/${n}?e=1900000000&v=beta&t=x`;
const STORED = 'https://orbit.test/storage/v1/object/public/people-photos';

const PROFILE = {
  provider_id: 'ACoAAA123',
  public_identifier: 'omar-haddad',
  first_name: 'Omar',
  last_name: 'Haddad',
  headline: 'President at Enactus Berkeley',
  profile_picture_url: licdn('small'),
  profile_picture_url_large: licdn('large'),
  network_distance: 'SECOND_DEGREE',
  shared_connections_count: 2,
  contact_info: { emails: ['omar@berkeley.edu'] },
  work_experience: [{ position: 'President', company: 'Enactus Berkeley', current: true }],
  throttled_sections: [],
};

function harness(over: Partial<ConnectorDeps> = {}, profile: Record<string, unknown> = PROFILE) {
  const upstream: { url: string; body?: Record<string, unknown> }[] = [];
  const stored: string[] = [];
  const counted: CallCount[] = [];
  const at = new Date('2026-11-11T09:00:00Z');
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: undefined,
    villageBase: undefined,
    origins: defaultOrigins,
    signingKey: SIGNING,
    browserKept: async () => true,
    now: () => at,
    take: memoryTake(() => at.getTime()),
    shared: memorySharedReads(),
    photos: async (name) => {
      stored.push(name);
      return `${STORED}/${name}.jpg`;
    },
    calls: async (row) => {
      counted.push(row);
    },
    fetch: (async (url: string, init: RequestInit = {}) => {
      upstream.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.startsWith('https://media.licdn.com/'))
        return url.includes('/dead')
          ? new Response('gone', { status: 403 })
          : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
      if (url.includes('/api/v1/users/')) return new Response(JSON.stringify(profile));
      if (url.includes('/api/v1/linkedin/search'))
        return new Response(
          JSON.stringify({
            items: [
              { name: 'Mia Chen', member_id: 'ACoMia', network_distance: 'DISTANCE_1' },
              { name: 'Sam Roy', member_id: 'ACoSam', network_distance: 'DISTANCE_1' },
            ],
            cursor: null,
            paging: { total_count: 2 },
            config: { params: { connections_of: ['ACoAAA123'] } },
          }),
        );
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    ...over,
  };
  const handler = makeHandler(deps);
  const post = async (path: string, body: Record<string, unknown>) =>
    (await (
      await handler(
        new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify(body),
        }),
      )
    ).json()) as Record<string, any>;
  /** upstream calls that are reads of LinkedIn through the account (not picture downloads) */
  const reads = () => upstream.filter((u) => u.url.includes('unipile.com'));
  const total = (kind: string, field: 'made' | 'saved' | 'refused') =>
    counted.filter((c) => c.kind === kind).reduce((n, c) => n + (c[field] ?? 0), 0);
  return { post, upstream, reads, stored, counted, total };
}

const A = { accountId: 'a1', token: TOKEN };
const B = { accountId: 'b2', token: TOKEN_B };

describe('what a kept read answers', () => {
  it('a read with more sections answers a request for fewer, never the other way', () => {
    const full = { sections: ['education', 'experience'], recommendations: false };
    expect(covers(full, ['experience'], false)).toBe(true);
    expect(covers(full, [], false)).toBe(true);
    expect(covers(full, ['experience', 'skills'], false)).toBe(false);
    expect(covers(full, [], true)).toBe(false);
    expect(covers({ sections: [], recommendations: true }, [], true)).toBe(true);
  });

  it('one person goes by each of their names once', () => {
    expect(aliases(['omar-haddad', undefined, 'ACoAAA123', ' Omar-Haddad ', ''])).toEqual([
      'omar-haddad',
      'ACoAAA123',
    ]);
  });
});

describe('photos are read from LinkedIn once (plan 41 B)', () => {
  it('copies the picture a read brings into storage, and answers from the copy after that under any name', async () => {
    const h = harness();
    const first = await h.post('/photo', { ...A, identifier: 'ACoAAA123' });
    expect(first.photo.pictureUrl).toMatch(new RegExp(`^${STORED}/[0-9a-f]{40}\\.jpg$`));
    expect(first.photo).toMatchObject({ providerId: 'ACoAAA123', publicIdentifier: 'omar-haddad' });
    expect(h.reads()).toHaveLength(1);
    // by member id again, and by public name: the copy, and nothing read
    const again = await h.post('/photo', { ...A, identifier: 'ACoAAA123' });
    const byName = await h.post('/photo', { ...A, identifier: 'omar-haddad' });
    expect(again.photo).toMatchObject({ pictureUrl: first.photo.pictureUrl, kept: true });
    expect(byName.photo).toMatchObject({ pictureUrl: first.photo.pictureUrl, kept: true });
    // another student's account gets the same copy without a read of their own
    const other = await h.post('/photo', { ...B, identifier: 'omar-haddad' });
    expect(other.photo).toMatchObject({ pictureUrl: first.photo.pictureUrl, kept: true });
    expect(h.reads()).toHaveLength(1);
    expect(h.total('profile', 'made')).toBe(1);
    expect(h.total('profile', 'saved')).toBe(3);
  });

  it('copies a picture link the browser already has, with no read, for that account only', async () => {
    const h = harness();
    const kept = await h.post('/photo', { ...A, identifier: 'ACoMia', known: licdn('mia'), keepOnly: true });
    expect(kept.photo.kept).toBe(true);
    expect(kept.photo.pictureUrl).toMatch(new RegExp(`^${STORED}/a-[0-9a-f]{40}\\.jpg$`));
    expect(h.reads()).toHaveLength(0);
    expect(h.total('profile', 'made')).toBe(0);
    // asked again by the same account: the copy
    expect((await h.post('/photo', { ...A, identifier: 'ACoMia' })).photo).toMatchObject({
      pictureUrl: kept.photo.pictureUrl,
      kept: true,
    });
    expect(h.reads()).toHaveLength(0);
    // what one browser handed over is never what another student is shown: their account reads for itself
    const other = await h.post('/photo', { ...B, identifier: 'ACoMia' });
    expect(other.photo.pictureUrl).not.toBe(kept.photo.pictureUrl);
    expect(h.reads()).toHaveLength(1);
  });

  it('never fetches a picture from anywhere but LinkedIn, and reads nobody for a link that will not copy', async () => {
    const h = harness();
    // a dead link, keep only: nothing copied, nobody read
    expect(
      (await h.post('/photo', { ...A, identifier: 'ACoMia', known: licdn('dead'), keepOnly: true })).photo,
    ).toEqual({ kept: false });
    expect(h.reads()).toHaveLength(0);
    // a link elsewhere is not a known picture at all: it is never fetched, and the person is read as before
    await h.post('/photo', {
      ...A,
      identifier: 'ACoSam',
      known: 'https://evil.example/x.png',
      keepOnly: true,
    });
    expect(h.upstream.some((u) => u.url.includes('evil.example'))).toBe(false);
    expect(h.reads()).toHaveLength(1);
  });

  it('remembers that someone has no picture, so they are not read for one again', async () => {
    const h = harness({}, { provider_id: 'ACoNone', first_name: 'No', last_name: 'Face' });
    const first = await h.post('/photo', { ...A, identifier: 'ACoNone' });
    expect(first.photo.pictureUrl).toBeUndefined();
    const again = await h.post('/photo', { ...A, identifier: 'ACoNone' });
    expect(again.photo).toMatchObject({ kept: true });
    expect(again.photo.pictureUrl).toBeUndefined();
    expect(h.reads()).toHaveLength(1);
    // a link the browser does have is still copied: "no picture" never hides one
    const handed = await h.post('/photo', {
      ...A,
      identifier: 'ACoNone',
      known: licdn('found'),
      keepOnly: true,
    });
    expect(handed.photo.pictureUrl).toMatch(new RegExp(`^${STORED}/a-`));
    expect(h.reads()).toHaveLength(1);
  });

  it('reads again when asked for a fresh answer', async () => {
    const h = harness();
    await h.post('/profile', { ...A, identifier: 'omar-haddad' });
    await h.post('/profile', { ...A, identifier: 'omar-haddad', fresh: true });
    await h.post('/photo', { ...A, identifier: 'omar-haddad', fresh: true });
    expect(h.reads()).toHaveLength(3);
  });
});

describe('one person record for every route (plan 41 A)', () => {
  it('a profile read answers the photo, the plain profile and the same request again without another read', async () => {
    const h = harness();
    const sections = ['experience', 'education'];
    const read = await h.post('/profile', { ...A, identifier: 'omar-haddad', sections });
    expect(read.profile.pictureUrl).toMatch(new RegExp(`^${STORED}/`));
    expect(read.profile).toMatchObject({
      distance: 2,
      mutualCount: 2,
      contact: { emails: ['omar@berkeley.edu'] },
    });
    expect(h.reads()).toHaveLength(1);
    // the same request, a thinner one, and the photo, by either name: all from what was kept
    const again = await h.post('/profile', { ...A, identifier: 'ACoAAA123', sections });
    expect(again).toMatchObject({ ok: true, shared: true });
    expect(again.profile).toMatchObject({ distance: 2, mutualCount: 2, headline: PROFILE.headline });
    expect((await h.post('/profile', { ...A, identifier: 'omar-haddad' })).shared).toBe(true);
    expect((await h.post('/photo', { ...A, identifier: 'omar-haddad' })).photo.kept).toBe(true);
    expect(h.reads()).toHaveLength(1);
    // more than was kept: read
    await h.post('/profile', { ...A, identifier: 'omar-haddad', sections: [...sections, 'skills'] });
    expect(h.reads()).toHaveLength(2);
  });

  it('shares what anyone would see with other students, and nothing that depends on the reader', async () => {
    const h = harness();
    await h.post('/profile', { ...A, identifier: 'omar-haddad', sections: ['experience'] });
    // another student, public parts only: the copy, without distance, contact details or the shared count
    const pub = await h.post('/profile', {
      ...B,
      identifier: 'omar-haddad',
      sections: ['experience'],
      public: true,
    });
    expect(pub.shared).toBe(true);
    expect(pub.profile.headline).toBe(PROFILE.headline);
    expect(pub.profile).not.toHaveProperty('distance');
    expect(pub.profile).not.toHaveProperty('contact');
    expect(pub.profile).not.toHaveProperty('mutualCount');
    expect(h.reads()).toHaveLength(1);
    // the same student wanting their own view of them (distance, contact): their account reads once, then keeps it
    const own = await h.post('/profile', { ...B, identifier: 'omar-haddad', sections: ['experience'] });
    expect(own.shared).toBeUndefined();
    expect(own.profile.distance).toBe(2);
    expect(h.reads()).toHaveLength(2);
    expect((await h.post('/profile', { ...B, identifier: 'omar-haddad' })).shared).toBe(true);
    expect(h.reads()).toHaveLength(2);
  });

  it('keeps a read LinkedIn held sections back on as a plain read only', async () => {
    const h = harness({}, { ...PROFILE, throttled_sections: ['experience'] });
    await h.post('/profile', { ...A, identifier: 'omar-haddad', sections: ['experience'] });
    // the plain profile is answered from it, the held-back section is read again
    expect((await h.post('/profile', { ...A, identifier: 'omar-haddad' })).shared).toBe(true);
    await h.post('/profile', { ...A, identifier: 'omar-haddad', sections: ['experience'] });
    expect(h.reads()).toHaveLength(2);
  });
});

describe('"who knows them" remembers (plan 41 C)', () => {
  it('keeps a checked answer two weeks, and takes the shared count from a read already made', async () => {
    const h = harness();
    const first = await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123' });
    expect(first).toMatchObject({ verified: true, count: 2 });
    expect(first.mutuals.map((m: { name: string }) => m.name)).toEqual(['Mia Chen', 'Sam Roy']);
    // their plain profile for the count, then one page of search
    expect(h.reads()).toHaveLength(2);
    const again = await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123' });
    expect(again).toMatchObject({ verified: true, count: 2, kept: true });
    expect(h.reads()).toHaveLength(2);
    // that one profile read also answers their photo and their plain profile
    expect((await h.post('/photo', { ...A, identifier: 'ACoAAA123' })).photo.kept).toBe(true);
    expect((await h.post('/profile', { ...A, identifier: 'omar-haddad' })).shared).toBe(true);
    expect(h.reads()).toHaveLength(2);
    // asked to look again: LinkedIn is read again
    await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123', fresh: true });
    expect(h.reads()).toHaveLength(4);
    // another student's mutuals are their own
    await h.post('/mutuals', { ...B, targetMemberId: 'ACoAAA123' });
    expect(h.reads()).toHaveLength(6);
  });

  it('spends no profile read when this account read them a moment ago', async () => {
    const h = harness();
    await h.post('/profile', { ...A, identifier: 'ACoAAA123', sections: ['experience'] });
    expect(h.total('profile', 'made')).toBe(1);
    const r = await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123' });
    expect(r).toMatchObject({ verified: true, count: 2 });
    // one search page, and no second profile read
    expect(h.reads()).toHaveLength(2);
    expect(h.total('profile', 'made')).toBe(1);
    expect(h.total('search', 'made')).toBe(1);
    expect(h.counted).toContainEqual({ accountId: 'a1', kind: 'profile', caller: 'mutuals', saved: 1 });
  });

  it('remembers that two people share nobody', async () => {
    const h = harness({}, { ...PROFILE, shared_connections_count: 0 });
    expect(await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123' })).toEqual({
      mutuals: [],
      verified: true,
      count: 0,
    });
    expect(await h.post('/mutuals', { ...A, targetMemberId: 'ACoAAA123' })).toMatchObject({
      count: 0,
      kept: true,
    });
    expect(h.reads()).toHaveLength(1);
  });
});

describe('an honest count (plan 41 F)', () => {
  it('counts reads made, saved and refused per ledger and caller, and a company page as a company read', async () => {
    const h = harness({ ledger: { profile: 2 } });
    await h.post('/company', { ...A, identifier: '777' });
    expect(h.counted).toEqual([{ accountId: 'a1', kind: 'company', caller: 'logos', made: 1 }]);
    // a ledger of 2: enrichment may fill it to 1
    await h.post('/profile', { ...A, identifier: 'x1' });
    const refused = await h.post('/profile', { ...A, identifier: 'x2', sections: ['skills'] });
    expect(refused).toMatchObject({ ok: false, reason: 'limit' });
    expect(h.counted.slice(1)).toEqual([
      { accountId: 'a1', kind: 'profile', caller: 'enrich', made: 1 },
      { accountId: 'a1', kind: 'profile', caller: 'enrich', refused: 1 },
    ]);
  });
});
