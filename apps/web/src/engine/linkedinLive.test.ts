import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setUnipileUrlForTests } from '../integrations/unipile';
import {
  autoSyncLinkedInLive,
  checkLinkedInAccount,
  connectLinkedInLive,
  disconnectLinkedInLive,
  LIVE_SOON,
  linkedInLiveStatus,
  linkedInProgress,
  liveLinkedInAccount,
  liveLinkedInAvailable,
  MUTUALS_TIMEOUT_MS,
  mutualsFor,
  readsBackAt,
  resumeLinkedInConnect,
  setLivePollForTests,
  setMutualsTimeoutForTests,
  subscribeLinkedInProgress,
  syncLinkedInLive,
} from './linkedinLive';

const BASE = 'https://proxy.test/functions/v1/orbit-connectors';
const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};

type Answer = { status?: number; body: unknown; headers?: Record<string, string> };
let routes: Record<string, Answer | (() => Answer)>;
let calls: { path: string; body: Record<string, unknown> }[];
const UNCONFIGURED: Answer = {
  status: 503,
  body: { error: 'not configured' },
  headers: { 'x-orbit-connector': 'unconfigured' },
};

const RELATIONS = {
  items: [
    {
      first_name: 'Daniel',
      last_name: 'Okafor',
      position: 'Analyst',
      company: 'Goldman Sachs',
      public_profile_url: 'https://www.linkedin.com/in/daniel-okafor',
      connected_at: '2025-03-12T10:00:00Z',
      member_id: 'm_daniel',
    },
    {
      first_name: 'Sana',
      last_name: 'Ahmed',
      position: 'Business Analyst',
      company: 'McKinsey & Company',
      public_profile_url: 'https://www.linkedin.com/in/sana-ahmed',
      member_id: 'm_sana',
    },
  ],
  cursor: null,
};

let popup: { closed: boolean; close: () => void };

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
  await db.goals.put({
    userId: user.id,
    cycleLabel: 'Summer 2027',
    targetRoles: ['Summer analyst'],
    targetFunctions: ['ib', 'consulting'],
    targetIndustries: [],
    targetLocations: [],
    ambition: 2,
  });
  await db.targetCompanies.put({
    id: 'tc1',
    userId: user.id,
    nameRaw: 'Goldman Sachs',
    priority: 1,
    status: 'researching',
  } as never);
  setUnipileUrlForTests(BASE);
  setConnectorsMockForTests(false);
  setLivePollForTests({ everyMs: 1, tries: 6 });
  calls = [];
  let polls = 0;
  routes = {
    '/connect/start': { body: { url: 'https://unipile/login', ref: 'ref1' } },
    // the first look is still waiting, the second has the account
    '/connect/status': () =>
      ++polls < 2 ? { body: { status: 'pending' } } : { body: { status: 'connected', accountId: 'acc_1' } },
    '/relations': { body: RELATIONS },
    '/disconnect': { body: { ok: true } },
    '/mutuals': {
      body: {
        verified: true,
        mutuals: [{ name: 'Sana Ahmed', member_id: 'm_sana' }, { name: 'Stranger Person' }],
      },
    },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = url.replace(BASE, '');
    calls.push({ path, body: JSON.parse((init.body as string) || '{}') });
    const r = routes[path];
    const a = typeof r === 'function' ? r() : (r ?? { status: 404, body: {} });
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    });
  });
  popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setUnipileUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
  setLivePollForTests(undefined);
});

const people = () => db.people.where('userId').equals(user.id).toArray();

describe('connecting LinkedIn live', () => {
  it('is offered when the proxy is in the build, and says it is switching on soon when the key is not pasted', async () => {
    expect(liveLinkedInAvailable(user)).toBe(true);
    routes['/connect/start'] = UNCONFIGURED;
    expect(await connectLinkedInLive(user)).toEqual({
      ok: false,
      reason: 'unconfigured',
      message: LIVE_SOON,
    });
    expect(window.open).not.toHaveBeenCalled();
    setUnipileUrlForTests(null);
    expect(liveLinkedInAvailable(user)).toBe(false);
    expect(await connectLinkedInLive(user)).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect(await liveLinkedInAccount(user.id)).toBeUndefined();
  });

  it('opens the hosted sign-in, waits for it, records the account and imports with member ids', async () => {
    const progress: number[] = [];
    const r = await connectLinkedInLive(user, { onProgress: (n) => progress.push(n) });
    expect(r).toEqual({ ok: true, rows: 2, added: 2 });
    expect(window.open).toHaveBeenCalledWith('https://unipile/login', 'orbit-linkedin', expect.any(String));
    expect(popup.close).toHaveBeenCalled();
    expect(progress.length).toBeGreaterThan(0);
    const row = await liveLinkedInAccount(user.id);
    expect(row).toMatchObject({
      provider: 'linkedin_live',
      externalAccountId: 'acc_1',
      status: 'active',
      syncState: { rows: 2, lastSyncedAt: expect.any(String) },
    });
    expect(row!.lastSyncedAt).toBe((row!.syncState as { lastSyncedAt: string }).lastSyncedAt);
    const all = await people();
    expect(all.map((p) => [p.displayName, p.linkedinMemberId]).sort()).toEqual([
      ['Daniel Okafor', 'm_daniel'],
      ['Sana Ahmed', 'm_sana'],
    ]);
    // recommendations are rebuilt at once, like an export upload
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    expect(recs.some((x) => x.personId === all.find((p) => p.firstName === 'Daniel')!.id)).toBe(true);
    const st = await linkedInLiveStatus(user);
    expect(st).toMatchObject({ available: true, connected: true, status: 'active', rows: 2, stale: false });
  });

  it('a sign-in LinkedIn finishes after its window closed still connects, and the progress says each step', async () => {
    let polls = 0;
    const connected = routes['/connect/status'];
    routes['/connect/status'] = () =>
      ++polls < 4
        ? { body: { status: 'pending' } }
        : typeof connected === 'function'
          ? connected()
          : connected!;
    popup.closed = true;
    const seen = new Set<string>();
    const watch = setInterval(() => seen.add(linkedInProgress()?.phase ?? ''), 0);
    const r = await connectLinkedInLive(user);
    clearInterval(watch);
    expect(r).toEqual({ ok: true, rows: 2, added: 2 });
    expect(seen.has('finishing')).toBe(true);
    expect(linkedInProgress()).toMatchObject({ phase: 'done', count: 2 });
    expect(localStorage.getItem('orbit.linkedin.pending')).toBeNull();
  });

  it('a sign-in still pending when the page closed is picked back up when Orbit opens', async () => {
    localStorage.setItem(
      'orbit.linkedin.pending',
      JSON.stringify({ userId: user.id, ref: 'orbit_ref', at: Date.now() }),
    );
    const r = await resumeLinkedInConnect(user);
    expect(r).toEqual({ ok: true, rows: 2, added: 2 });
    expect(await liveLinkedInAccount(user.id)).toMatchObject({
      externalAccountId: 'acc_1',
      status: 'active',
    });
    expect(localStorage.getItem('orbit.linkedin.pending')).toBeNull();
    // nothing pending: nothing happens
    expect(await resumeLinkedInConnect(user)).toBeUndefined();
  });

  it('keeps waiting after the window closes, gives up only after the wait, and reports a failed sign-in', async () => {
    routes['/connect/status'] = { body: { status: 'pending' } };
    popup.closed = true;
    expect(await connectLinkedInLive(user)).toMatchObject({
      ok: false,
      reason: 'error',
      message: expect.stringMatching(/approve the sign-in/),
    });
    expect(linkedInProgress()).toMatchObject({ phase: 'failed' });
    routes['/connect/status'] = {
      body: { status: 'error', message: 'LinkedIn did not accept the sign-in.' },
    };
    popup.closed = false;
    expect(await connectLinkedInLive(user)).toEqual({
      ok: false,
      reason: 'error',
      message: 'LinkedIn did not accept the sign-in.',
    });
    expect(await liveLinkedInAccount(user.id)).toBeUndefined();
  });

  it('says so when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await connectLinkedInLive(user)).toMatchObject({
      ok: false,
      reason: 'error',
      message: expect.stringMatching(/blocked the LinkedIn window/),
    });
  });

  it('a stopped connect is cancelled', async () => {
    routes['/connect/status'] = { body: { status: 'pending' } };
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await connectLinkedInLive(user, { signal: ctrl.signal })).toMatchObject({
      ok: false,
      reason: 'cancelled',
    });
  });
});

describe('syncing, disconnecting and the daily re-sync', () => {
  it('a re-sync updates instead of doubling, and notices a job change', async () => {
    await connectLinkedInLive(user);
    routes['/relations'] = {
      body: { items: [{ ...RELATIONS.items[0], position: 'Associate' }], cursor: null },
    };
    const r = await syncLinkedInLive(user);
    expect(r).toMatchObject({ ok: true, rows: 1, added: 0, updated: 1 });
    expect(await people()).toHaveLength(2);
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    expect(daniel.currentTitle).toBe('Associate');
    expect(daniel.linkedinMemberId).toBe('m_daniel');
  });

  it('after the connections, reads the LinkedIn messages for closeness and says how many (plan 17 B)', async () => {
    await connectLinkedInLive(user);
    // the account token /connect/status hands this browser: the message reads need it
    const row = (await liveLinkedInAccount(user.id))!;
    await db.integrations.update(row.id, { accessToken: 'tok_1' });
    routes['/chats/history'] = {
      body: {
        chats: [
          {
            chatId: 'c1',
            memberId: 'm_daniel',
            messages: [
              { id: 'x1', at: '2026-10-01T10:00:00.000Z', out: true, text: 'Hi Daniel' },
              { id: 'x2', at: '2026-10-02T10:00:00.000Z', out: false, text: 'Hi!' },
            ],
          },
        ],
        latest: '2026-10-02T10:00:00.000Z',
        cursor: null,
      },
    };
    routes['/posts/activity'] = { body: { ok: true, items: [], postsRead: [], ownDone: true, cursor: null } };
    const seen: string[] = [];
    const stop = subscribeLinkedInProgress(() => {
      const p = linkedInProgress();
      if (p) seen.push(`${p.phase}:${p.messages ?? ''}`);
    });
    expect(await syncLinkedInLive(user)).toMatchObject({ ok: true, rows: 2 });
    stop();
    // the banner counts the messages while it reads them, then says how many
    expect(seen).toContain('analyzing:2');
    expect(linkedInProgress()).toMatchObject({ phase: 'done', message: expect.stringMatching(/2 messages/) });
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    const kinds = (await db.touchpoints.where('personId').equals(daniel.id).toArray()).map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['linkedin_in', 'linkedin_out']));
    expect(calls.find((c) => c.path === '/chats/history')!.body).toMatchObject({ accountId: 'acc_1' });
  });

  it('marks the account as needing attention on an error, but not when the key is simply not pasted', async () => {
    await connectLinkedInLive(user);
    routes['/relations'] = UNCONFIGURED;
    expect(await syncLinkedInLive(user)).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect((await liveLinkedInAccount(user.id))!.status).toBe('active');
    routes['/relations'] = { status: 502, body: { error: 'unipile 500' } };
    expect(await syncLinkedInLive(user)).toMatchObject({ ok: false, reason: 'error' });
    expect(await liveLinkedInAccount(user.id)).toMatchObject({
      status: 'error',
      lastError: expect.any(String),
    });
    expect((await linkedInLiveStatus(user)).error).toBeTruthy();
  });

  it('cannot sync before connecting', async () => {
    expect(await syncLinkedInLive(user)).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('disconnect unlinks at Unipile and keeps everyone imported', async () => {
    await connectLinkedInLive(user);
    const r = await disconnectLinkedInLive(user);
    expect(r).toEqual({ ok: true, unlinkedAtUnipile: true });
    expect(calls.find((c) => c.path === '/disconnect')!.body).toEqual({ accountId: 'acc_1' });
    expect(await liveLinkedInAccount(user.id)).toMatchObject({ status: 'revoked' });
    expect((await liveLinkedInAccount(user.id))!.externalAccountId).toBeUndefined();
    expect(await people()).toHaveLength(2);
    expect((await linkedInLiveStatus(user)).connected).toBe(false);
    expect(await syncLinkedInLive(user)).toMatchObject({ ok: false, reason: 'not_connected' });
    expect(await disconnectLinkedInLive(user)).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('the switch follows Unipile: signed out by LinkedIn, back again, and gone', async () => {
    routes['/connect/status'] = { body: { status: 'connected', accountId: 'acc_1', token: 'tok_1' } };
    await connectLinkedInLive(user);
    // nothing to say yet: a working account stays as it is
    routes['/account'] = { body: { status: 'connected' } };
    expect(await checkLinkedInAccount(user)).toBe('connected');
    expect(calls.find((c) => c.path === '/account')!.body).toEqual({ accountId: 'acc_1', token: 'tok_1' });
    expect(await linkedInLiveStatus(user)).toMatchObject({ connected: true, signedOut: false });
    routes['/account'] = { body: { status: 'signin' } };
    await checkLinkedInAccount(user);
    expect(await linkedInLiveStatus(user)).toMatchObject({ connected: true, signedOut: true });
    // a check that fails says nothing new
    routes['/account'] = { status: 502, body: { error: 'unipile 500' } };
    expect(await checkLinkedInAccount(user)).toBeUndefined();
    expect((await linkedInLiveStatus(user)).signedOut).toBe(true);
    routes['/account'] = { body: { status: 'connected' } };
    await checkLinkedInAccount(user);
    expect((await liveLinkedInAccount(user.id))!.status).toBe('active');
    expect((await linkedInLiveStatus(user)).signedOut).toBe(false);
    routes['/account'] = { body: { status: 'gone' } };
    await checkLinkedInAccount(user);
    expect((await linkedInLiveStatus(user)).connected).toBe(false);
    expect(await people()).toHaveLength(2);
  });

  it('does not check the demo or an account without its token', async () => {
    await connectLinkedInLive(user);
    expect(await checkLinkedInAccount(user)).toBeUndefined();
    expect(calls.some((c) => c.path === '/account')).toBe(false);
  });

  it('re-syncs on app open only when the last sync is more than a day old', async () => {
    await connectLinkedInLive(user);
    const row = (await liveLinkedInAccount(user.id))!;
    const before = calls.filter((c) => c.path === '/relations').length;
    const soon = new Date(Date.parse(row.lastSyncedAt!) + 60 * 60_000);
    expect(await autoSyncLinkedInLive(user, soon)).toBeUndefined();
    const later = new Date(Date.parse(row.lastSyncedAt!) + 25 * 60 * 60_000);
    expect((await linkedInLiveStatus(user, later)).stale).toBe(true);
    expect(await autoSyncLinkedInLive(user, later)).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.path === '/relations').length).toBe(before + 1);
    expect((await liveLinkedInAccount(user.id))!.lastSyncedAt).toBe(later.toISOString());
  });
});

describe('the daily sync reads only the newest connections', () => {
  it('stops at the first page with a stored connection, and reads everything weekly and on Sync now', async () => {
    await connectLinkedInLive(user);
    const row = (await liveLinkedInAccount(user.id))!;
    const first = Date.parse(row.lastSyncedAt!);
    const NEW = { first_name: 'Lena', last_name: 'Park', company: 'Stripe', member_id: 'm_lena' };
    routes['/relations'] = () => {
      const cursor = calls.filter((c) => c.path === '/relations').at(-1)!.body.cursor;
      return cursor
        ? { body: { items: [RELATIONS.items[1]], cursor: null } }
        : { body: { items: [NEW, RELATIONS.items[0]], cursor: 'c2' } };
    };
    const pages = () => calls.filter((c) => c.path === '/relations').length;
    let before = pages();
    const day = (n: number) => new Date(first + n * 25 * 60 * 60_000);
    expect(await autoSyncLinkedInLive(user, day(1))).toMatchObject({ ok: true, added: 1, rows: 3 });
    expect(pages()).toBe(before + 1);
    // a week after the last full pull, every page again
    before = pages();
    expect(await autoSyncLinkedInLive(user, day(7))).toMatchObject({ ok: true, rows: 3 });
    expect(pages()).toBe(before + 2);
    // Sync now always reads everything
    before = pages();
    expect(await syncLinkedInLive(user, { now: day(8) })).toMatchObject({ ok: true });
    expect(pages()).toBe(before + 2);
  });
});

describe('mutual connections', () => {
  it('waits long enough for the several reads behind it, retries a timeout once, and shares one read', async () => {
    expect(MUTUALS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    await connectLinkedInLive(user);
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    setMutualsTimeoutForTests(60);
    try {
      let asked = 0;
      const answer = { verified: true, mutuals: [{ name: 'Sana Ahmed', member_id: 'm_sana' }] };
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        if (!url.endsWith('/mutuals')) return Promise.resolve(new Response('{}', { status: 404 }));
        asked++;
        // the first read takes longer than Orbit waits; the retry answers at once
        if (asked === 1)
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
      });
      // the Map and the Person page asking at once: one read between them
      const [ra, rb] = await Promise.all([mutualsFor(user, daniel), mutualsFor(user, daniel)]);
      expect(ra).toMatchObject({ ok: true, source: 'linkedin' });
      expect(rb).toMatchObject({ ok: true, source: 'linkedin' });
      expect(ra.mutuals.map((m) => m.name)).toEqual(['Sana Ahmed']);
      expect(asked).toBe(2);
    } finally {
      setMutualsTimeoutForTests(undefined);
    }
  });

  it("today's reads used up: says when they come back, as a limit, not an error to retry", async () => {
    await connectLinkedInLive(user);
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    routes['/mutuals'] = {
      body: {
        ok: false,
        reason: 'limit',
        message: 'Orbit has read as much from LinkedIn as it allows today.',
      },
    };
    const r = await mutualsFor(user, daniel, { now: new Date('2026-10-26T20:00:00Z') });
    expect(r).toMatchObject({ ok: false, reason: 'limit' });
    expect(r.ok ? '' : r.message).toMatch(
      /^Orbit has used today's LinkedIn reads, to keep your account safe\. It carries on (tomorrow )?at \d{1,2}:\d{2} [AP]M\.$/,
    );
    expect(readsBackAt(new Date('2026-10-26T20:00:00Z'))).not.toMatch(/[–—]/);
  });

  it('needs a live connection and the member id from it, then names who Orbit knows', async () => {
    const outsider = {
      id: 'px',
      userId: user.id,
      displayName: 'Priya Shah',
      firstName: 'Priya',
      lastName: 'Shah',
      nameNormalized: 'priya shah',
      emails: [],
      relationshipType: 'unknown',
      strength: 0.2,
      interactionCount: 0,
      sources: ['manual'],
      isHuman: true,
      tags: [],
      createdAt: user.createdAt,
      updatedAt: user.createdAt,
    } as const;
    await db.people.put({ ...outsider, sources: ['manual'], tags: [], emails: [] });
    expect(await mutualsFor(user, (await db.people.get('px'))!)).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
    await connectLinkedInLive(user);
    expect(await mutualsFor(user, (await db.people.get('px'))!)).toMatchObject({
      ok: false,
      reason: 'no_member_id',
    });
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    const r = await mutualsFor(user, daniel);
    if (!r.ok) throw new Error(r.message);
    expect(calls.find((c) => c.path === '/mutuals')!.body).toEqual({
      accountId: 'acc_1',
      targetMemberId: 'm_daniel',
    });
    const sana = (await people()).find((p) => p.firstName === 'Sana')!;
    expect(r.mutuals).toEqual([
      { name: 'Sana Ahmed', memberId: 'm_sana', headline: undefined, url: undefined, personId: sana.id },
      {
        name: 'Stranger Person',
        memberId: undefined,
        headline: undefined,
        url: undefined,
        personId: undefined,
      },
    ]);
  });
});
