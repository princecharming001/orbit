import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { loadDemo } from '../../engine/demo';
import { connectLinkedInLive, linkedInLiveStatus } from '../../engine/linkedinLive';
import { setConnectorsMockForTests } from '../../integrations/connectorsMock';
import { writePrefs } from '../../integrations/prefs';
import { setUnipileUrlForTests } from '../../integrations/unipile';
import { setVillageUrlForTests } from '../../integrations/village';
import { execute, modelResult } from '../registry';
import { makeCtx, NOW, nextToolUseId } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

afterEach(() => {
  vi.unstubAllGlobals();
  setUnipileUrlForTests(undefined);
  setVillageUrlForTests(undefined);
  setConnectorsMockForTests(undefined);
});

const person = async (name: string) =>
  (await db.people.where('userId').equals(user.id).toArray()).find((p) => p.displayName === name)!;

describe('live LinkedIn from the chat (the sample student, on the mock connector)', () => {
  it('show_setup linkedin offers the live connect button first', async () => {
    const env = await execute('show_setup', { what: 'linkedin' }, makeCtx(user));
    expect(env.kind).toBe('setup');
    expect(env.data).toMatchObject({
      what: 'linkedin',
      live: { available: true, connected: false, demo: true },
    });
    expect(env.summary).toMatch(/Connect LinkedIn button/);
  });

  it('sync_linkedin shows the setup widget until LinkedIn is connected live, then syncs', async () => {
    const before = await execute('sync_linkedin', {}, makeCtx(user));
    expect(before.kind).toBe('setup');
    expect(before.summary).toMatch(/not connected live yet/);
    const r = await connectLinkedInLive(user);
    expect(r.ok).toBe(true);
    const env = await execute('sync_linkedin', {}, makeCtx(user));
    expect(env.kind).toBe('import');
    expect(env.summary).toMatch(/^LinkedIn synced: \d+ connections, 0 new, \d+ updated\.$/);
    expect(modelResult('sync_linkedin', env).data).toMatchObject({ source: 'LinkedIn', added: 0 });
    const settings = await execute('get_settings', { sections: ['integrations'] }, makeCtx(user));
    const integ = (modelResult('get_settings', settings).data as { integrations: Record<string, unknown> })
      .integrations;
    expect(integ.linkedinLive).toMatchObject({ available: true, connected: true, status: 'active' });
    expect((integ.linkedinLive as { lastSync?: string }).lastSync).toBeTruthy();
    expect(integ.warmIntros).toMatchObject({ on: true, offered: true });
  }, 60_000);

  it('get_mutual_connections names who the student knows who knows that person, wrapped for the model', async () => {
    const maya = await person('Maya Chen');
    const ctx = makeCtx(user);
    const env = await execute('get_mutual_connections', { personId: maya.id }, ctx);
    expect(env.kind).toBe('people');
    expect(env.summary).toMatch(/mutual connections? with Maya Chen/);
    const ui = (env.data as { ui: { people: { name: string }[] } }).ui;
    expect(ui.people.map((p) => p.name)).toContain('Daniel Okafor');
    const model = JSON.stringify(modelResult('get_mutual_connections', env));
    expect(model).toContain(`<untrusted_${ctx.nonce}`);
    expect(model).not.toContain('"forModel"');
  });

  it('disconnect_linkedin asks first, then unlinks and keeps everyone', async () => {
    const people = await db.people.where('userId').equals(user.id).count();
    const ctx = makeCtx(user, { conversationId: 'conv_li' });
    const ask = await execute('disconnect_linkedin', {}, ctx);
    expect(ask.kind).toBe('needs_confirmation');
    expect(ask.summary).toMatch(
      /Disconnect LinkedIn\. Orbit stops syncing your connections; everyone already imported stays\./,
    );
    expect((await linkedInLiveStatus(user)).connected).toBe(true);
    const done = await execute(
      'disconnect_linkedin',
      {},
      makeCtx(user, {
        conversationId: 'conv_li',
        confirmation: ask.confirmationId,
        toolUseId: nextToolUseId(),
      }),
    );
    expect(done.kind).toBe('settings');
    expect(done.summary).toBe('Disconnected LinkedIn. Everyone already imported stays in Orbit.');
    expect((await linkedInLiveStatus(user)).connected).toBe(false);
    expect(await db.people.where('userId').equals(user.id).count()).toBe(people);
    // nothing left to disconnect: the Approve card says why
    const again = await execute('disconnect_linkedin', {}, makeCtx(user, { conversationId: 'conv_li2' }));
    expect(again.summary).toMatch(/blocked right now: LinkedIn is not connected live/);
  });
});

describe('find_routes with warm intros', () => {
  it('adds warm intros to a person, with warmth in words and the hops, and says so', async () => {
    const daniel = await person('Daniel Okafor');
    const ctx = makeCtx(user);
    const env = await execute('find_routes', { personId: daniel.id }, ctx);
    expect(env.kind).toBe('routes');
    const ui = (env.data as { ui: { warmIntros: { warmthWord: string; hops: string[] }[] } }).ui;
    expect(ui.warmIntros.length).toBeGreaterThan(0);
    expect(['warm', 'good', 'a stretch']).toContain(ui.warmIntros[0]!.warmthWord);
    expect(ui.warmIntros[0]!.hops[0]).toBe('You');
    expect(env.summary).toMatch(/warm intros? too, the best through .+ \((warm|good|a stretch)\)\./);
    const model = modelResult('find_routes', env).data as { warmIntros: { warmth: string; hops: string }[] };
    expect(['warm', 'good', 'a stretch']).toContain(model.warmIntros[0]!.warmth);
    expect(model.warmIntros[0]!.hops).toContain(`<untrusted_${ctx.nonce}`);
  });

  it('adds warm intros to a company too', async () => {
    const env = await execute('find_routes', { company: 'Stripe' }, makeCtx(user));
    expect(env.kind).toBe('company');
    const ui = (env.data as { ui: { warmIntros: { hops: string[] }[] } }).ui;
    expect(ui.warmIntros.length).toBeGreaterThan(0);
    expect(ui.warmIntros[0]!.hops.at(-1)).toBe('Stripe');
    expect(env.summary).toMatch(/^Stripe: .*warm intros? too/);
  });

  it('returns Village-only results when Orbit has no route of its own', async () => {
    const other = await createLocalUser({ fullName: 'Sam Lee', firstName: 'Sam' });
    await db.people.put({
      id: 'v_target',
      userId: other.id,
      displayName: 'Dana Fox',
      firstName: 'Dana',
      lastName: 'Fox',
      nameNormalized: 'dana fox',
      emails: [],
      currentOrganizationRaw: 'Stripe',
      relationshipType: 'unknown',
      strength: 0,
      interactionCount: 0,
      sources: ['manual'],
      isHuman: true,
      tags: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    setConnectorsMockForTests(false);
    setVillageUrlForTests('https://proxy.test/functions/v1/orbit-connectors');
    writePrefs({ warmIntros: true });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            paths: [
              { introducer: { name: 'Lee Park' }, warmth: 0.75, hops: ['You', 'Lee Park', 'Dana Fox'] },
            ],
          }),
          { status: 200 },
        ),
    );
    const env = await execute('find_routes', { personId: 'v_target' }, makeCtx(other));
    writePrefs({ warmIntros: undefined });
    expect(env.kind).toBe('routes');
    const ui = (env.data as { ui: { routes: unknown[]; warmIntros: { warmthWord: string }[] } }).ui;
    expect(ui.routes).toEqual([]);
    expect(ui.warmIntros).toMatchObject([{ warmthWord: 'warm', introducer: { name: 'Lee Park' } }]);
    expect(env.summary).toBe(
      'No route to Dana Fox through people you know yet. One warm intro too, the best through Lee Park (warm).',
    );
  });
});
