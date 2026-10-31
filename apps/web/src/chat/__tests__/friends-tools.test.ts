import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { clearPathCacheForTests } from '../../engine/paths';
import { setOrbitApiBaseForTests } from '../../integrations/orbitApi';
import { leaveFakeApi, signInToFakeApi } from '../../test/account';
import { ANA_USER_ID, type FakeOrbitApi, withFriend } from '../../test/fakeOrbitApi';
import { execute, modelResult } from '../registry';
import type { ResultEnvelope, ToolContext } from '../types';
import { makeCtx, nextToolUseId } from './helpers';

/**
 * The five friends tools (plan 29 §A5) against the fake orbit-api: who the student's friends are and what each shares,
 * an invite, what the student shares back, the ask that goes to the friend and never to the person, and the answer to
 * a friend's ask. Local mode says Friends needs an account, in a line, with no dash or exclamation mark.
 */

const DASH_OR_BANG = /[—–!]/;
const at = '2026-10-06T12:00:00.000Z';

async function addPerson(user: User, id: string, name: string, org: string): Promise<Person> {
  const [first, ...rest] = name.split(' ');
  const p = {
    id,
    userId: user.id,
    displayName: name,
    firstName: first!,
    lastName: rest.join(' '),
    nameNormalized: name.toLowerCase(),
    currentOrganizationRaw: org,
    emails: [],
    relationshipType: 'unknown',
    strength: 0.5,
    interactionCount: 2,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person;
  await db.people.put(p);
  return p;
}

/** Run a tool; a risky one is approved with its token like the Approve button does. */
async function run(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ResultEnvelope> {
  const env = await execute(name, input, ctx);
  if (env.kind !== 'needs_confirmation') return env;
  return execute(name, input, { ...ctx, confirmation: env.confirmationId, toolUseId: nextToolUseId() });
}

function plainSummary(env: ResultEnvelope) {
  expect(env.summary).not.toMatch(DASH_OR_BANG);
  expect(env.summary).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
}

describe('friends tools in local mode', () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    setOrbitApiBaseForTests(null);
    user = await createLocalUser({ fullName: 'Alex Rivera', firstName: 'Alex' });
  });
  afterEach(() => setOrbitApiBaseForTests(undefined));

  it('every friends tool says Friends needs an account, and the risky ones say so on the Approve card', async () => {
    const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });
    const list = await execute('list_friends', {}, ctx());
    expect(list.kind).toBe('text');
    expect(list.summary).toMatch(/Friends needs an Orbit account/);
    plainSummary(list);
    const share = await execute('set_friend_sharing', { mode: 'none' }, ctx());
    expect(share.kind).toBe('text');
    expect(share.summary).toMatch(/needs an Orbit account/);
    for (const [name, input] of [
      ['invite_friend', { email: 'noah@cornell.edu' }],
      ['ask_friend_for_intro', { friendName: 'Ana', targetName: 'Dan Lee', note: 'Junior at Cornell.' }],
      ['respond_to_friend_ask', { action: 'decline' }],
    ] as const) {
      const env = await execute(name, input, ctx());
      expect(env.kind, name).toBe('needs_confirmation');
      expect((env.data as { blockedReason?: string }).blockedReason, name).toMatch(/needs an Orbit account/);
      plainSummary(env);
    }
  });
});

describe('friends tools against the fake orbit-api', () => {
  let api: FakeOrbitApi;
  let user: User;
  const ctx = () => makeCtx(user, { toolUseId: nextToolUseId() });

  beforeEach(async () => {
    await wipeDatabase();
    clearPathCacheForTests();
    ({ api, user } = await signInToFakeApi());
    await addPerson(user, 'p_maya_chen', 'Maya Chen', 'Stripe');
    await addPerson(user, 'p_lena_novak', 'Lena Novak', 'Ramp');
    withFriend(
      api,
      { id: user.id, firstName: 'Maya' },
      (await db.people.where('userId').equals(user.id).toArray()).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        currentTitle: p.currentTitle,
        currentOrganizationRaw: p.currentOrganizationRaw,
      })),
    );
  });
  afterEach(async () => {
    await leaveFakeApi();
  });

  it('list_friends: Ana with her counts, what crosses, and who she knows at a company', async () => {
    const env = await execute('list_friends', {}, ctx());
    expect(env.kind).toBe('list');
    plainSummary(env);
    expect(env.summary).toMatch(
      /1 friend on Orbit: Ana \(shares 120 people · 6 at your targets · knows 2 at Stripe\)/,
    );
    const m = modelResult('list_friends', env) as { data: Record<string, unknown> };
    const friends = m.data.friends as { name: string; shares: number; youShare: string }[];
    expect(friends[0]).toMatchObject({ name: 'Ana Okafor', shares: 120, youShare: 'all' });
    expect(String(m.data.whatAFriendSees)).toMatch(/Never your emails, notes, drafts, scores, addresses/);
    // nothing of Ana's people beyond the projection: no address anywhere
    expect(JSON.stringify(m)).not.toMatch(/@/);
    const stripe = await execute('list_friends', { company: 'Stripe' }, ctx());
    expect(stripe.summary).toMatch(
      /At Stripe: Ana knows Dan Lee \(is close to Dan\), Maya Chen \(knows Maya well\)/,
    );
    const linear = await execute('list_friends', { company: 'Linear' }, ctx());
    expect(linear.summary).toMatch(/Nobody your friends share works at Linear/);
  });

  it('invite_friend asks first, then files the invite and never claims the friend accepted', async () => {
    const first = await execute('invite_friend', { email: 'noah.patel@cornell.edu' }, ctx());
    expect(first.kind).toBe('needs_confirmation');
    expect(first.summary).toMatch(/Invite noah\.patel@cornell\.edu to pool networks/);
    expect(first.summary).toMatch(/nothing else crosses/);
    const env = await run('invite_friend', { email: 'noah.patel@cornell.edu' }, ctx());
    expect(env.kind).toBe('text');
    plainSummary(env);
    expect(env.summary).toMatch(/nothing is shared until they accept/i);
    expect(api.state.friendInvites).toHaveLength(1);
    const m = modelResult('invite_friend', env) as { data: { acceptedYet: boolean } };
    expect(m.data.acceptedYet).toBe(false);
  });

  it('set_friend_sharing: none for Ana at once, companies for all; the friendship stays', async () => {
    const none = await execute('set_friend_sharing', { mode: 'none', friendName: 'Ana' }, ctx());
    expect(none.kind).toBe('settings');
    plainSummary(none);
    expect(none.summary).toMatch(
      /Ana sees nothing of yours now\. It took effect at once; you still see what Ana shares\./,
    );
    expect(api.state.friends[0]!.myMode).toBe('none');
    const some = await execute(
      'set_friend_sharing',
      { mode: 'companies', companies: ['Ramp', 'stripe.com'] },
      ctx(),
    );
    expect(some.kind).toBe('settings');
    expect(api.state.friendShareMode).toBe('companies');
    expect(api.state.friendCompanyDomains).toEqual(['ramp.com', 'stripe.com']);
    expect(some.summary).toMatch(/Your friends see \d+ (person|people) of yours at ramp, stripe/);
    const bad = await execute('set_friend_sharing', { mode: 'companies' }, ctx());
    expect(bad.kind).toBe('error');
    const nobody = await execute('set_friend_sharing', { mode: 'all', friendName: 'Zed' }, ctx());
    expect(nobody.kind).toBe('error');
    expect(nobody.summary).toMatch(/No friend on Orbit named Zed/);
  });

  it('ask_friend_for_intro goes to Ana with the blurb, never a draft to Dan; a vague name is blocked', async () => {
    const note =
      'Junior at Cornell on payments infra, would love 15 minutes on how the team decides what to automate.';
    const card = await execute(
      'ask_friend_for_intro',
      { friendName: 'Ana', targetName: 'Dan Lee', note },
      ctx(),
    );
    expect(card.kind).toBe('needs_confirmation');
    expect(card.summary).toMatch(/Ask Ana to introduce you to Dan Lee at Stripe/);
    expect(card.summary).toMatch(/It goes to Ana, never to Dan/);
    expect((card.data as { blockedReason?: string }).blockedReason).toBeUndefined();
    const env = await run('ask_friend_for_intro', { friendName: 'Ana', targetName: 'Dan Lee', note }, ctx());
    expect(env.kind).toBe('text');
    plainSummary(env);
    expect(env.summary).toMatch(
      /Asked Ana to introduce you to Dan Lee at Stripe\. It waits on Ana; nothing was sent to Dan\./,
    );
    const asks = api.state.friendAsks.filter((a) => a.askerUserId === user.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.note).toBe(note);
    expect([...api.state.drafts.values()].some((d) => /Dan/.test(d.body))).toBe(false);
    const m = modelResult('ask_friend_for_intro', env) as { data: { sentToTarget: boolean } };
    expect(m.data.sentToTarget).toBe(false);
    // a name Ana does not share, and a name that could be several people, are blocked on the card
    const miss = await execute(
      'ask_friend_for_intro',
      { friendName: 'Ana', targetName: 'Zed Q', note },
      ctx(),
    );
    expect((miss.data as { blockedReason?: string }).blockedReason).toMatch(
      /does not share anyone named Zed Q/,
    );
    const many = await execute(
      'ask_friend_for_intro',
      { friendName: 'Ana', targetName: 'Omar', note },
      ctx(),
    );
    expect((many.data as { blockedReason?: string }).blockedReason).toMatch(/more than one person like that/);
  });

  it("respond_to_friend_ask: Ana's ask of me forwards as a draft I approve, with Ana in cc; decline owes no reason", async () => {
    const card = await execute('respond_to_friend_ask', { action: 'forward' }, ctx());
    expect(card.kind).toBe('needs_confirmation');
    expect(card.summary).toMatch(
      /Forward Ana's note to Lena Novak at Ramp: a draft to Lena from you, Ana's words quoted, Ana in cc/,
    );
    expect(card.summary).toMatch(/never on LinkedIn/);
    const env = await run('respond_to_friend_ask', { action: 'forward', askerName: 'Ana' }, ctx());
    expect(env.kind).toBe('text');
    plainSummary(env);
    expect(env.summary).toMatch(
      /Drafted the forward to Lena Novak: Ana's note quoted, Ana in cc\. Nothing is sent until you approve it/,
    );
    expect(api.state.friendAsks.find((a) => a.id === 'ask_ana_lena')?.status).toBe('forwarded');
    const m = modelResult('respond_to_friend_ask', env) as {
      data: { sent: boolean; cc: string; body: string };
    };
    expect(m.data.sent).toBe(false);
    expect(m.data.cc).toBe('Ana Okafor');
    expect(m.data.body).toContain("Cc'ing Ana");
    expect(m.data.body).toContain('<untrusted_');
    // answered once: nothing open is left to decline
    const again = await execute('respond_to_friend_ask', { action: 'decline', askerName: 'Ana' }, ctx());
    expect((again.data as { blockedReason?: string }).blockedReason).toMatch(/No open ask matches/);
  });

  it('find_routes to Stripe lists the people friends know there, asked of the friend', async () => {
    const env = await execute('find_routes', { company: 'Stripe' }, ctx());
    expect(env.kind).toBe('company');
    expect(env.summary).toMatch(
      /Through friends: Dan Lee \(Ana is close to Dan\), Maya Chen \(Ana knows Maya well\); ask the friend, never the person\./,
    );
    const m = modelResult('find_routes', env) as {
      data: { throughFriends: { name: string; friend: string }[] };
    };
    expect(m.data.throughFriends.map((t) => t.name).sort()).toEqual(['Dan Lee', 'Maya Chen']);
    expect(m.data.throughFriends[0]!.friend).toBe('Ana Okafor');
    // to a person the student has: the friend route is marked viaFriend and the next step is the friend
    const person = await execute('find_routes', { personId: 'p_maya_chen' }, ctx());
    expect(person.kind).toBe('routes');
    expect(person.summary).toMatch(/through Ana Okafor, a friend on Orbit who knows Maya well/);
    const pm = modelResult('find_routes', person) as {
      data: { routes: { viaFriend?: { name: string; knows: string }; next?: string }[] };
    };
    expect(pm.data.routes[0]!.viaFriend).toEqual({
      name: 'Ana Okafor',
      userId: ANA_USER_ID,
      knows: 'knows Maya well',
    });
    expect(pm.data.routes[0]!.next).toMatch(/ask_friend_for_intro/);
  });
});
