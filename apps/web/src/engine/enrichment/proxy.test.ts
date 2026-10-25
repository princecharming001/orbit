import { describe, expect, it } from 'vitest';
import {
  accountToken,
  type ConnectorDeps,
  defaultOrigins,
  makeHandler,
  mapProfile,
  memoryTake,
} from '../../../../../supabase/functions/orbit-connectors/connectors';

/**
 * The connector proxy's enrichment routes (plan 17 E): /profile and /company (Unipile), /web (Exa) and /providers.
 * Unipile is stubbed by URL, as in chat/__tests__/connectors-proxy.test.ts.
 */
const ORIGIN = 'https://princecharming001.github.io';
const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const SIGNING = 'test-signing-key-not-a-real-one';
const TOKEN = await accountToken('a1', SIGNING);
const licdn = (n: string) => `https://media.licdn.com/dms/image/v2/${n}?e=1900000000&v=beta&t=x`;

/** A LinkedIn profile as Unipile returns it (fields per its API reference and unipile-node-sdk's types). */
const UNIPILE_PROFILE = {
  object: 'UserProfile',
  provider: 'LINKEDIN',
  provider_id: 'ACoAAA123',
  public_identifier: 'omar-haddad',
  first_name: 'Omar',
  last_name: 'Haddad',
  headline: "President at Enactus Berkeley | Haas '26",
  location: 'Berkeley, California',
  summary: 'I build things.',
  profile_picture_url: licdn('small'),
  profile_picture_url_large: licdn('large'),
  network_distance: 'FIRST_DEGREE',
  websites: [],
  contact_info: { emails: ['omar@berkeley.edu', 'not an email'], phones: ['+1 510 555 0100'] },
  work_experience: [
    {
      position: 'President',
      company: 'Enactus Berkeley',
      company_id: '777',
      company_url: 'https://www.linkedin.com/company/enactus-berkeley/',
      company_picture_url: licdn('enactus'),
      current: true,
      start: '5/2025',
      end: null,
    },
    {
      position: 'Intern',
      company: 'Acme',
      company_picture_url: 'https://evil.example/x.png',
      start: '2024',
      end: '2024',
    },
  ],
  education: [
    {
      school: 'University of California, Berkeley',
      school_id: '2517',
      school_picture_url: licdn('cal'),
      degree: 'BS',
      field_of_study: 'Business',
      start: { year: 2022, month: 8 },
      end: { year: 2026 },
    },
  ],
  throttled_sections: [],
};

function harness(over: Partial<ConnectorDeps> = {}, answer?: (url: string, init: RequestInit) => Response) {
  const upstream: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const deps: ConnectorDeps = {
    unipileKey: 'u-key',
    unipileBase: 'https://api1.unipile.com:443',
    villageKey: undefined,
    villageBase: undefined,
    origins: defaultOrigins,
    signingKey: SIGNING,
    fetch: (async (url: string, init: RequestInit = {}) => {
      upstream.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (answer) return answer(url, init);
      if (url.includes('/api/v1/users/')) return new Response(JSON.stringify(UNIPILE_PROFILE));
      if (url.includes('/api/v1/linkedin/company/'))
        return new Response(
          JSON.stringify({
            object: 'CompanyProfile',
            id: '777',
            name: 'Enactus Berkeley',
            public_identifier: 'enactus-berkeley',
            logo: licdn('enactus-big'),
            website: 'https://enactusberkeley.org',
            industry: ['Non-profit Organizations'],
          }),
        );
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
    ...over,
  };
  return { handler: makeHandler(deps), upstream };
}

const post = (path: string, body: unknown, ip = '203.0.113.9') =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

describe('enrichment routes of the connector proxy', () => {
  it('reads a full profile with the sections asked for, and answers small', async () => {
    const { handler, upstream } = harness();
    const res = await handler(
      post('/profile', {
        accountId: 'a1',
        token: TOKEN,
        identifier: 'omar-haddad',
        sections: ['experience', 'education', 'about', 'nonsense'],
      }),
    );
    expect(res.status).toBe(200);
    const url = new URL(upstream[0]!.url);
    expect(url.pathname).toBe('/api/v1/users/omar-haddad');
    expect(url.searchParams.get('account_id')).toBe('a1');
    // only known sections, joined with commas as Unipile's SDK sends them
    expect(url.searchParams.get('linkedin_sections')).toBe('experience,education,about');
    expect(upstream[0]!.headers['X-API-KEY']).toBe('u-key');
    const b = (await res.json()) as { ok: boolean; profile: ReturnType<typeof mapProfile> };
    expect(b.ok).toBe(true);
    expect(b.profile).toEqual({
      providerId: 'ACoAAA123',
      publicIdentifier: 'omar-haddad',
      firstName: 'Omar',
      lastName: 'Haddad',
      headline: "President at Enactus Berkeley | Haas '26",
      location: 'Berkeley, California',
      about: 'I build things.',
      pictureUrl: licdn('large'),
      distance: 1,
      experience: [
        {
          title: 'President',
          company: 'Enactus Berkeley',
          companyId: '777',
          companySlug: 'enactus-berkeley',
          logoUrl: licdn('enactus'),
          location: undefined,
          current: true,
          start: '5/2025',
          end: undefined,
        },
        {
          title: 'Intern',
          company: 'Acme',
          companyId: undefined,
          companySlug: undefined,
          // an image from anywhere but LinkedIn is never passed on
          logoUrl: undefined,
          location: undefined,
          current: false,
          start: '2024',
          end: '2024',
        },
      ],
      education: [
        {
          school: 'University of California, Berkeley',
          schoolId: '2517',
          logoUrl: licdn('cal'),
          degree: 'BS',
          field: 'Business',
          start: '2022-08',
          end: '2026',
        },
      ],
      contact: { emails: ['omar@berkeley.edu'], phones: ['+1 510 555 0100'] },
      throttled: [],
    });
  });

  it('passes on throttled sections, and says not found, throttled and refused apart', async () => {
    expect(mapProfile({ throttled_sections: ['experience', 'education'] }).throttled).toEqual([
      'experience',
      'education',
    ]);
    const statuses: Record<number, string> = {
      404: 'not_found',
      422: 'not_found',
      429: 'throttled',
      403: 'refused',
    };
    for (const [status, reason] of Object.entries(statuses)) {
      const { handler } = harness(
        {},
        () => new Response(JSON.stringify({ title: 'nope' }), { status: Number(status) }),
      );
      const b = await (
        await handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x' }))
      ).json();
      expect(b).toMatchObject({ ok: false, reason });
    }
    const { handler } = harness({}, () => new Response('{}', { status: 500 }));
    expect((await handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x' }))).status).toBe(
      502,
    );
  });

  it('needs the account token, and stops an account at its daily profile reads', async () => {
    const at = new Date('2026-10-22T09:00:00Z');
    const { handler, upstream } = harness({
      ledger: { profile: 1 },
      now: () => at,
      take: memoryTake(() => at.getTime()),
    });
    expect((await handler(post('/profile', { accountId: 'a1', identifier: 'x' }))).status).toBe(403);
    expect(upstream).toHaveLength(0);
    const read = () => handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x' }));
    expect(await (await read()).json()).toMatchObject({ ok: true });
    expect(await (await read()).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(upstream).toHaveLength(1);
  });

  it('reads follower and connection counts, and recommendations when asked: who and when, never the text', async () => {
    const withRecs = {
      ...UNIPILE_PROFILE,
      follower_count: 1234,
      connections_count: '500+',
      recommendations: {
        received: [
          {
            text: 'SECRET_RECOMMENDATION_TEXT Omar is a brilliant operator.',
            caption:
              'June 12, 2023, Ana managed Omar directly and this caption keeps going well past eighty chars',
            actor: { provider_id: 'ACoAna', first_name: 'Ana', last_name: 'Ruiz', public_identifier: 'ana' },
          },
          { text: 'no actor at all' },
        ],
      },
      recommendations_given: [{ text: 'SECRET_GIVEN_TEXT', actor: { provider_id: 'ACoSam' } }],
    };
    const { handler, upstream } = harness({}, () => new Response(JSON.stringify(withRecs)));
    const raw = await (
      await handler(
        post('/profile', {
          accountId: 'a1',
          token: TOKEN,
          identifier: 'omar-haddad',
          sections: ['experience'],
          recommendations: true,
          purpose: 'route',
        }),
      )
    ).text();
    expect(raw).not.toContain('SECRET_');
    const b = JSON.parse(raw) as { profile: Record<string, unknown> };
    expect(new URL(upstream[0]!.url).searchParams.get('linkedin_sections')).toBe(
      'experience,recommendations_received,recommendations_given',
    );
    expect(b.profile.followerCount).toBe(1234);
    expect(b.profile.connectionsCount).toBe(500);
    expect(b.profile.recommendations).toEqual([
      {
        direction: 'received',
        actorId: 'ACoAna',
        actorName: 'Ana Ruiz',
        year: 2023,
        caption: 'June 12, 2023, Ana managed Omar directly and this caption keeps going well past ',
      },
      { direction: 'given', actorId: 'ACoSam' },
    ]);
    // not asked: no recommendation sections, and none come back
    const plain = harness({}, () => new Response(JSON.stringify(withRecs)));
    const p2 = (await (
      await plain.handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'omar-haddad' }))
    ).json()) as { profile: Record<string, unknown> };
    expect(new URL(plain.upstream[0]!.url).searchParams.has('linkedin_sections')).toBe(false);
    expect(p2.profile.recommendations).toBeUndefined();
    expect(p2.profile.followerCount).toBe(1234);
  });

  it('fetches a photo link from the plain profile, with no sections, and says who they are on LinkedIn', async () => {
    const { handler, upstream } = harness();
    const res = await handler(post('/photo', { accountId: 'a1', token: TOKEN, identifier: 'ACoAAA123' }));
    expect(res.status).toBe(200);
    const url = new URL(upstream[0]!.url);
    expect(url.pathname).toBe('/api/v1/users/ACoAAA123');
    expect(url.searchParams.get('account_id')).toBe('a1');
    expect(url.searchParams.has('linkedin_sections')).toBe(false);
    // the large picture, the link only: no experience, education or contact details travel
    expect(await res.json()).toEqual({
      ok: true,
      photo: { pictureUrl: licdn('large'), providerId: 'ACoAAA123', publicIdentifier: 'omar-haddad' },
    });
    // no photo on LinkedIn, or one from elsewhere: no link
    const none = harness(
      {},
      () =>
        new Response(JSON.stringify({ provider_id: 'x', profile_picture_url: 'https://evil.example/x.png' })),
    );
    expect(
      await (await none.handler(post('/photo', { accountId: 'a1', token: TOKEN, identifier: 'x' }))).json(),
    ).toEqual({ ok: true, photo: { pictureUrl: undefined, providerId: 'x', publicIdentifier: undefined } });
    const gone = harness({}, () => new Response('{}', { status: 404 }));
    expect(
      await (await gone.handler(post('/photo', { accountId: 'a1', token: TOKEN, identifier: 'x' }))).json(),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('needs the account token for a photo too, and shares one profile ledger by priority', async () => {
    const at = new Date('2026-10-22T09:00:00Z');
    // a ledger of 10: enrichment may fill it to 7, photos to 8, a route the student is looking at to all 10
    const { handler, upstream } = harness({
      ledger: { profile: 10 },
      now: () => at,
      take: memoryTake(() => at.getTime()),
    });
    expect((await handler(post('/photo', { accountId: 'a1', identifier: 'x' }))).status).toBe(403);
    expect((await handler(post('/photo', { accountId: 'a1' }))).status).toBe(403);
    expect(upstream).toHaveLength(0);
    const photo = () => handler(post('/photo', { accountId: 'a1', token: TOKEN, identifier: 'x' }));
    const read = () => handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x' }));
    const company = () => handler(post('/company', { accountId: 'a1', token: TOKEN, identifier: '777' }));
    const route = () =>
      handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x', purpose: 'route' }));
    for (let i = 0; i < 6; i++) expect(await (await read()).json()).toMatchObject({ ok: true });
    expect(await (await company()).json()).toMatchObject({ ok: true });
    expect(await (await read()).json()).toEqual({
      ok: false,
      reason: 'limit',
      message: 'Orbit has read as much from LinkedIn as it allows today. It carries on tomorrow.',
    });
    expect(await (await company()).json()).toMatchObject({ ok: false, reason: 'limit' });
    // photos go a little further, and a refused one costs the route reads nothing
    expect(await (await photo()).json()).toMatchObject({ ok: true });
    expect(await (await photo()).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(await (await photo()).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(await (await route()).json()).toMatchObject({ ok: true });
    expect(await (await route()).json()).toMatchObject({ ok: true });
    expect(await (await route()).json()).toMatchObject({ ok: false, reason: 'limit' });
    expect(upstream).toHaveLength(10);
  });

  it("reads a company's page: its LinkedIn id, public name and logo", async () => {
    const { handler, upstream } = harness();
    const b = await (
      await handler(post('/company', { accountId: 'a1', token: TOKEN, identifier: '777' }))
    ).json();
    expect(new URL(upstream[0]!.url).pathname).toBe('/api/v1/linkedin/company/777');
    expect(b).toEqual({
      ok: true,
      company: {
        id: '777',
        name: 'Enactus Berkeley',
        publicIdentifier: 'enactus-berkeley',
        logoUrl: licdn('enactus-big'),
        website: 'https://enactusberkeley.org',
        industry: 'Non-profit Organizations',
      },
    });
  });

  it('says which providers are set up, and the web lookup is unconfigured without an Exa key', async () => {
    const { handler, upstream } = harness();
    const status = await (await handler(post('/providers', {}))).json();
    expect(status).toEqual({
      linkedin: true,
      exa: false,
      firecrawl: false,
      apollo: false,
      peopleDataLabs: false,
    });
    const web = await handler(post('/web', { name: 'Omar Haddad' }));
    expect(web.status).toBe(503);
    expect(web.headers.get('x-orbit-connector')).toBe('unconfigured');
    expect(upstream).toHaveLength(0);
    // without Unipile the LinkedIn routes are unconfigured too
    const none = harness({ unipileKey: undefined });
    expect(
      (await none.handler(post('/profile', { accountId: 'a1', token: TOKEN, identifier: 'x' }))).status,
    ).toBe(503);
  });

  it('asks Exa with the key when one is set, and keeps only https links', async () => {
    const { handler, upstream } = harness(
      { enrichment: { exaKey: 'exa-key' } },
      () =>
        new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://omar.dev',
                title: 'Omar Haddad',
                text: 'Omar Haddad, President of Enactus Berkeley',
              },
              { url: 'javascript:alert(1)', title: 'bad' },
            ],
          }),
        ),
    );
    const b = await (
      await handler(post('/web', { name: 'Omar Haddad', company: 'Enactus Berkeley' }))
    ).json();
    expect(upstream[0]!.url).toBe('https://api.exa.ai/search');
    expect(upstream[0]!.headers['x-api-key']).toBe('exa-key');
    expect(upstream[0]!.body).toMatchObject({ query: '"Omar Haddad" Enactus Berkeley', type: 'auto' });
    expect(b).toEqual({
      ok: true,
      results: [
        {
          url: 'https://omar.dev',
          title: 'Omar Haddad',
          snippet: 'Omar Haddad, President of Enactus Berkeley',
        },
      ],
    });
  });
});
