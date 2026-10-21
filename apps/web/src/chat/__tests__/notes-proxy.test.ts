import { describe, expect, it, vi } from 'vitest';
import {
  bookingUrl,
  CALCOM_EVENT_TYPES_VERSION,
  defaultOrigins,
  makeHandler,
  mapFathomMeeting,
  memoryTake,
} from '../../../../../supabase/functions/orbit-notes/notes';

const ORIGIN = 'https://tryorbit.today';
const KEY = 'fathom_test_key_123456';

function handler(fetchImpl: typeof fetch, limits = { perMinute: 30, perDay: 400 }) {
  return makeHandler({ origins: defaultOrigins, take: memoryTake(), fetch: fetchImpl, limits });
}

const post = (path: string, body: unknown, origin = ORIGIN) =>
  new Request(`https://x.supabase.co/functions/v1/orbit-notes${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify(body),
  });

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fathomItem = {
  recording_id: 4242,
  title: 'Coffee chat',
  meeting_title: 'Alex <> Priya',
  url: 'https://fathom.video/calls/1',
  share_url: 'https://fathom.video/share/abc',
  created_at: '2026-10-10T16:30:00Z',
  scheduled_start_time: '2026-10-10T16:00:00Z',
  recording_start_time: '2026-10-10T16:01:00Z',
  calendar_invitees: [
    { name: 'Alex Rivera', email: 'alex@cornell.edu', is_external: false },
    { name: 'Priya Ahmed', email: 'priya@stripe.com', is_external: true },
  ],
  recorded_by: { name: 'Alex', email: 'alex@cornell.edu' },
  default_summary: { template_name: 'General', markdown_formatted: '## Notes\n- Priya leads onboarding' },
  action_items: [
    { description: 'Send Priya the project link', completed: false, assignee: { name: 'Alex Rivera' } },
    { description: '', completed: false },
  ],
};

describe('orbit-notes proxy', () => {
  it('answers preflight from Orbit and refuses other sites', async () => {
    const h = handler(vi.fn() as unknown as typeof fetch);
    const pre = (origin: string) =>
      h(
        new Request('https://x/functions/v1/orbit-notes/fathom/meetings', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      );
    expect((await pre(ORIGIN)).status).toBe(204);
    expect((await pre('https://evil.example.com')).status).toBe(403);
    expect((await h(post('/fathom/meetings', { apiKey: KEY }, 'https://evil.example.com'))).status).toBe(403);
  });

  it('forwards the Fathom key with summaries and action items, and trims each meeting', async () => {
    const f = vi.fn(async () => ok({ items: [fathomItem], next_cursor: 'c2', limit: 10 }));
    const res = await handler(f as unknown as typeof fetch)(
      post('/fathom/meetings', { apiKey: KEY, createdAfter: '2026-09-01T00:00:00Z' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; meetings: unknown[]; nextCursor: string };
    expect(body).toMatchObject({ ok: true, nextCursor: 'c2' });
    expect(body.meetings).toEqual([
      {
        id: '4242',
        title: 'Alex <> Priya',
        url: 'https://fathom.video/share/abc',
        startAt: '2026-10-10T16:01:00Z',
        invitees: [
          { name: 'Alex Rivera', email: 'alex@cornell.edu', external: false },
          { name: 'Priya Ahmed', email: 'priya@stripe.com', external: true },
        ],
        recordedBy: 'alex@cornell.edu',
        summary: '## Notes\n- Priya leads onboarding',
        actionItems: [{ text: 'Send Priya the project link', done: false, assignee: 'Alex Rivera' }],
      },
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://api.fathom.ai/external/v1/meetings?');
    expect(url).toContain('include_summary=true');
    expect(url).toContain('include_action_items=true');
    expect(url).toContain('created_after=2026-09-01T00%3A00%3A00.000Z');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(KEY);
  });

  it('says plainly when Fathom refuses the key, and never echoes it', async () => {
    const f = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 }));
    const res = await handler(f as unknown as typeof fetch)(post('/fathom/meetings', { apiKey: KEY }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, reason: 'bad_key' });
    expect(text).not.toContain(KEY);
  });

  it('needs a key, and only on known routes', async () => {
    const h = handler(vi.fn() as unknown as typeof fetch);
    expect((await h(post('/fathom/meetings', {}))).status).toBe(400);
    expect((await h(post('/fathom/meetings', { apiKey: 'has spaces in it' }))).status).toBe(400);
    expect((await h(post('/elsewhere', { apiKey: KEY }))).status).toBe(404);
  });

  it('counts calls per visitor', async () => {
    const f = vi.fn(async () => ok({ items: [] }));
    const h = handler(f as unknown as typeof fetch, { perMinute: 1, perDay: 10 });
    expect((await h(post('/fathom/meetings', { apiKey: KEY }))).status).toBe(200);
    const limited = await h(post('/fathom/meetings', { apiKey: KEY }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-orbit-limit')).toBe('minute');
  });

  it('lists Cal.com event types with their booking links', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/v2/me')
        ? ok({ status: 'success', data: { username: 'alex-rivera', email: 'alex@cornell.edu' } })
        : ok({
            status: 'success',
            data: [
              {
                id: 1,
                title: '30 min coffee chat',
                slug: '30min',
                lengthInMinutes: 30,
                hidden: false,
                bookingUrl: 'https://cal.com/alex-rivera/30min',
              },
              { id: 2, title: 'Quick call', slug: '15min', lengthInMinutes: 15, hidden: true },
            ],
          }),
    );
    const res = await handler(f as unknown as typeof fetch)(
      post('/calcom/event-types', { apiKey: 'cal_live_abc123456' }),
    );
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      username: 'alex-rivera',
      eventTypes: [
        {
          id: 1,
          title: '30 min coffee chat',
          slug: '30min',
          minutes: 30,
          hidden: false,
          url: 'https://cal.com/alex-rivera/30min',
        },
        {
          id: 2,
          title: 'Quick call',
          slug: '15min',
          minutes: 15,
          hidden: true,
          url: 'https://cal.com/alex-rivera/15min',
        },
      ],
    });
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer cal_live_abc123456');
    expect((calls[1]![1].headers as Record<string, string>)['cal-api-version']).toBe(
      CALCOM_EVENT_TYPES_VERSION,
    );
  });

  it('maps edge cases: a meeting with no id is skipped; a booking link falls back to cal.com/user/slug', () => {
    expect(mapFathomMeeting({ title: 'x' })).toBeUndefined();
    expect(bookingUrl('sam', { slug: 'chat' })).toBe('https://cal.com/sam/chat');
    expect(bookingUrl('sam', { slug: 'chat', bookingUrl: 'https://book.sam.dev/chat' })).toBe(
      'https://book.sam.dev/chat',
    );
    expect(bookingUrl(undefined, { slug: 'chat' })).toBeUndefined();
  });
});
