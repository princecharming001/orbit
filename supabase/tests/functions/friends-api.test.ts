import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshFriendShares } from '../../functions/_shared/friends/shares.ts';
import { sqlQueue } from '../../functions/_shared/queue.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { addPerson, addTie, api, fakeNet, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

/**
 * Friends over the API (plan 29 §A4, §A7): invite, accept, what each side sees, the friend layer in /paths/find, the
 * ask and the forward, revocation, and the shape of what crosses (never an address, never a score).
 */

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

type Err = { error: { code: string; message: string } };
type Friend = {
  friendshipId: string;
  userId: string;
  name: string;
  shares: number;
  atTargets: number;
  myMode: string;
};
type Share = Record<string, unknown> & { personId: string; displayName: string; closeness: number };
type Found = {
  paths: {
    id: string;
    nodes: string[];
    p: number;
    firstHopId: string;
    reasonText: string;
    names: Record<string, string>;
    hops: {
      fromId: string;
      toId: string;
      p: number;
      via?: { kind: string; userId: string; name: string };
      phrase?: string;
    }[];
  }[];
  sources: string[];
  fallback?: string;
};

const SHARE_KEYS = [
  'closeness',
  'company',
  'companyDomain',
  'displayName',
  'isAlumni',
  'linkedinSlug',
  'personId',
  'school',
  'title',
];

async function visible(viewer: string, owner: string): Promise<boolean> {
  const [r] = await t.db.sql<{
    v: boolean;
  }>`select orbit.friend_visible(${viewer}::uuid, ${owner}::uuid) as v`;
  return r!.v;
}

/** Two signed-in students with a few people each, friends after the invite and the accept. */
async function twoFriends(mode: 'all' | 'companies' | 'none' = 'all') {
  const call = api(t, fakeNet(), { env: {} });
  const maya = await signedInUser(t, { firstName: 'Maya' });
  const ana = await signedInUser(t, { firstName: 'Ana' });
  // Ana knows Dan at Stripe (close, by her own label), Priya at Figma, and a private contact nobody should see
  const dan = await addPerson(t, ana.userId, {
    name: 'Dan Lee',
    title: 'Staff Engineer',
    org: 'Stripe',
    linkedinUrl: 'https://www.linkedin.com/in/dan-lee-stripe',
    email: 'dan@stripe.com',
    score: 85,
  });
  await t.db
    .sql`insert into orbit.tie_labels (user_id, person_id, closeness) values (${ana.userId}::uuid, ${dan}::uuid, 5)`;
  const priya = await addPerson(t, ana.userId, {
    name: 'Priya Raman',
    title: 'Product Manager',
    org: 'Figma',
    linkedinUrl: 'https://www.linkedin.com/in/priya-raman',
    score: 50,
  });
  const secret = await addPerson(t, ana.userId, {
    name: 'Secret Person',
    org: 'Stripe',
    email: 'secret@stripe.com',
  });
  await t.db.sql`update orbit.people set private = true where id = ${secret}::uuid`;
  // Maya knows Sam, who knows Dan on LinkedIn; Maya's Stripe target
  const sam = await addPerson(t, maya.userId, { name: 'Sam Ortiz', score: 40 });
  await call('/goals/upsert', maya.token, {
    goal: { kind: 'recruiting', title: 'PM internships', targets: { organizations: ['Stripe', 'Linear'] } },
  });
  const inv = await call<{ code: string; link: string; status: string; invite: { id: string } }>(
    '/friends/invite',
    maya.token,
    { email: ana.email },
  );
  expect(inv.status).toBe(200);
  expect(inv.body.status).toBe('requested');
  const acc = await call<{ friend: Friend }>('/friends/accept', ana.token, { code: inv.body.code, mode });
  expect(acc.status).toBe(200);
  return { call, maya, ana, dan, priya, secret, sam, friendshipId: acc.body.friend.friendshipId };
}

describe('friends over orbit-api', () => {
  it('invite, accept, and each side sees the other once both share; none turns one direction off', async () => {
    const { call, maya, ana } = await twoFriends();
    expect(await visible(maya.userId, ana.userId)).toBe(true);
    expect(await visible(ana.userId, maya.userId)).toBe(true);
    // the projections are built by the refresh job the accept queued
    const handlers = defaultHandlers({});
    for (const u of [maya, ana])
      await handlers.friend_shares_refresh!(
        {
          queue: 'orbit_score',
          msgId: 1,
          readCt: 1,
          kind: 'friend_shares_refresh',
          userId: u.userId,
          payload: {},
        },
        { db: t.db, queue: null as never, now: () => new Date() },
      );
    const mine = await call<{ friends: Friend[]; pending: unknown[] }>('/friends', maya.token, {});
    expect(mine.status).toBe(200);
    expect(mine.body.friends).toHaveLength(1);
    const ana1 = mine.body.friends[0]!;
    expect(ana1.name).toBe('Ana Rivera');
    // Dan and Priya, never the private one
    expect(ana1.shares).toBe(2);
    expect(ana1.atTargets).toBe(1);
    expect(ana1.myMode).toBe('all');
    // Ana stops sharing: Maya sees nothing of hers, Ana still sees Maya's
    const off = await call<{ mode: string; shares: number }>('/friends/settings', ana.token, {
      friendshipId: ana1.friendshipId,
      mode: 'none',
    });
    expect(off.status).toBe(200);
    expect(off.body.shares).toBe(0);
    expect(await visible(maya.userId, ana.userId)).toBe(false);
    expect(await visible(ana.userId, maya.userId)).toBe(true);
    const after = await call<{ friends: Friend[] }>('/friends', maya.token, {});
    expect(after.body.friends[0]!.shares).toBe(0);
    const denied = await call<Err>('/friends/shares', maya.token, { friendUserId: ana.userId });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    // only at Stripe: Dan shows, Priya does not
    await call('/friends/settings', ana.token, {
      friendshipId: ana1.friendshipId,
      mode: 'companies',
      companyDomains: ['stripe.com'],
    });
    await t.db
      .sql`update orbit.organizations set domains = '{stripe.com}' where user_id = ${ana.userId}::uuid and name_norm = 'stripe'`;
    await refreshFriendShares(t.db, ana.userId, new Date());
    const some = await call<{ shares: Share[]; total: number }>('/friends/shares', maya.token, {
      friendUserId: ana.userId,
    });
    expect(some.status).toBe(200);
    expect(some.body.shares.map((s) => s.displayName)).toEqual(['Dan Lee']);
    // Ana's preview for Maya is that narrower share; her default preview is still everyone
    const forMaya = await call<{ shares: Share[]; mode: string; total: number }>(
      '/friends/preview',
      ana.token,
      {
        friendshipId: ana1.friendshipId,
      },
    );
    expect(forMaya.body.mode).toBe('companies');
    expect(forMaya.body.shares.map((s) => s.displayName)).toEqual(['Dan Lee']);
    const byDefault = await call<{ mode: string; total: number }>('/friends/preview', ana.token, {});
    expect(byDefault.body.mode).toBe('all');
    expect(byDefault.body.total).toBe(2);
    // a friendship that is not Ana's shows nothing
    const notHers = await call<Err>('/friends/preview', maya.token, {
      friendshipId: '00000000-0000-4000-8000-000000000009',
    });
    expect(notHers.status).toBe(403);
  });

  it('a stranger cannot read a projection (403), and nothing Google-derived crosses in what a friend reads', async () => {
    const { call, ana, maya } = await twoFriends();
    await refreshFriendShares(t.db, ana.userId, new Date());
    const stranger = await signedInUser(t, { firstName: 'Zed' });
    const r = await call<Err>('/friends/shares', stranger.token, { friendUserId: ana.userId });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
    const ask = await call<Err>('/friends/asks', stranger.token, {
      friendUserId: ana.userId,
      targetPersonId: '00000000-0000-4000-8000-000000000001',
      note: 'please',
    });
    expect(ask.status).toBe(403);
    const ok = await call<{ shares: Share[] }>('/friends/shares', maya.token, { friendUserId: ana.userId });
    expect(ok.status).toBe(200);
    expect(ok.body.shares.length).toBeGreaterThan(0);
    for (const s of ok.body.shares) {
      expect(Object.keys(s).sort()).toEqual(SHARE_KEYS);
      expect(JSON.stringify(s)).not.toMatch(/@|score|email|phone|note/i);
      expect([1, 2, 3]).toContain(s.closeness);
    }
    // Dan: Ana's label says close, so a friend sees "close"; Priya's score of 50 was built from mail, so "knows"
    const dan = ok.body.shares.find((s) => s.displayName === 'Dan Lee')!;
    expect(dan.closeness).toBe(3);
    expect(dan.linkedinSlug).toBe('dan-lee-stripe');
    // the student's own preview is the same rows, row for row
    const preview = await call<{ shares: Share[]; mode: string }>('/friends/preview', ana.token, {});
    expect(preview.body.mode).toBe('all');
    expect(preview.body.shares.map((s) => s.personId).sort()).toEqual(
      ok.body.shares.map((s) => s.personId).sort(),
    );
    expect(preview.body.shares.map((s) => s.displayName)).not.toContain('Secret Person');
  });

  it("/paths/find ranks the friend route with the student's own and marks its hops `via`", async () => {
    const { call, maya, ana, dan, sam } = await twoFriends();
    await refreshFriendShares(t.db, ana.userId, new Date());
    // Maya has her own Dan (same LinkedIn slug) and Sam is a LinkedIn mutual of his
    const myDan = await addPerson(t, maya.userId, {
      name: 'Dan Lee',
      title: 'Staff Engineer',
      org: 'Stripe',
      linkedinUrl: 'https://www.linkedin.com/in/dan-lee-stripe',
    });
    await addTie(t, maya.userId, sam, myDan, 'linkedin_mutual', 0.3, 0.95);
    const r = await call<Found>('/paths/find', maya.token, { target: { personId: myDan } });
    expect(r.status).toBe(200);
    expect(r.body.sources).toContain('friends');
    const viaAna = r.body.paths.find((p) => p.firstHopId === `friend:${ana.userId}`);
    expect(viaAna).toBeDefined();
    expect(viaAna!.nodes).toEqual(['user', `friend:${ana.userId}`, myDan]);
    expect(viaAna!.hops[0]!.p).toBeCloseTo(0.9);
    expect(viaAna!.hops[1]!.p).toBeCloseTo(0.85);
    expect(viaAna!.hops[0]!.via).toEqual({ kind: 'friend', userId: ana.userId, name: 'Ana Rivera' });
    expect(viaAna!.hops[1]!.via?.kind).toBe('friend');
    expect(viaAna!.hops[1]!.phrase).toBe('is close to Dan');
    expect(viaAna!.reasonText).toBe('Ana (friend) is close to Dan at Stripe.');
    expect(viaAna!.names[`friend:${ana.userId}`]).toBe('Ana Rivera');
    // a close friend's close contact outranks a weak LinkedIn-mutual route
    const viaSam = r.body.paths.find((p) => p.firstHopId === sam);
    expect(viaSam).toBeDefined();
    expect(viaAna!.p).toBeGreaterThan(viaSam!.p);
    expect(r.body.paths[0]!.firstHopId).toBe(`friend:${ana.userId}`);
    // the friend's hop never carries anything of Ana's own history with Dan
    expect(JSON.stringify(viaAna)).not.toMatch(/email|meeting|score/i);
    // a company lookup lists the friend's person Maya does not have as a way in
    const c = await call<Found>('/paths/find', maya.token, { target: { company: 'Figma' } });
    expect(c.status).toBe(200);
    const priyaPath = c.body.paths.find((p) => p.nodes[2]?.startsWith('friend_person:'));
    expect(priyaPath).toBeDefined();
    expect(priyaPath!.names[priyaPath!.nodes[2]!]).toBe('Priya Raman');
    // Priya's 50 was built from mail, which never crosses: to a friend she is someone Ana knows
    expect(priyaPath!.reasonText).toBe('Ana (friend) knows Priya at Figma.');
    void dan;
  });

  it("the ask goes to the friend, the forward is a draft to the friend's contact with the asker in cc, never auto", async () => {
    const { call, maya, ana, dan, friendshipId } = await twoFriends();
    await refreshFriendShares(t.db, ana.userId, new Date());
    const asked = await call<{
      ask: { id: string; status: string; targetName: string; askerPersonId: string | null };
    }>('/friends/asks', maya.token, {
      friendUserId: ana.userId,
      targetPersonId: dan,
      note: 'Junior at Stanford on payments infra; 15 minutes on how the team decides what to automate.',
    });
    expect(asked.status).toBe(200);
    expect(asked.body.ask.status).toBe('asked');
    expect(asked.body.ask.targetName).toBe('Dan Lee');
    // the same ask twice waits on the first
    const again = await call<Err>('/friends/asks', maya.token, {
      friendUserId: ana.userId,
      targetPersonId: dan,
      note: 'again',
    });
    expect(again.status).toBe(409);
    // a person the friend does not share: 404, and nothing about them
    const miss = await call<Err>('/friends/asks', maya.token, {
      friendUserId: ana.userId,
      targetPersonId: '00000000-0000-4000-8000-000000000002',
      note: 'who',
    });
    expect(miss.status).toBe(404);
    // Ana sees it under received
    const lists = await call<{
      asked: { id: string }[];
      received: { id: string; askerName: string; note: string }[];
    }>('/friends/asks', ana.token, {});
    expect(lists.body.received.map((a) => a.id)).toEqual([asked.body.ask.id]);
    expect(lists.body.received[0]!.askerName).toBe('Maya Rivera');
    // Maya cannot answer her own ask
    const notMine = await call<Err>('/friends/asks/respond', maya.token, {
      id: asked.body.ask.id,
      action: 'forward',
    });
    expect(notMine.status).toBe(404);
    const fwd = await call<{
      ask: { status: string; forwardedDraftId: string };
      draft: { id: string; kind: string; channel: string; status: string; body: string; subject: string };
    }>(`/friends/asks/${asked.body.ask.id}/respond`, ana.token, { action: 'forward' });
    expect(fwd.status).toBe(200);
    expect(fwd.body.ask.status).toBe('forwarded');
    expect(fwd.body.draft.kind).toBe('forward_intro');
    expect(fwd.body.draft.channel).toBe('gmail');
    expect(fwd.body.draft.status).toBe('draft');
    expect(fwd.body.draft.subject).toBe('Intro: Maya and Dan');
    expect(fwd.body.draft.body).toContain('Hi Dan,');
    expect(fwd.body.draft.body).toContain("Cc'ing Maya so you two can take it from here");
    expect(fwd.body.draft.body).toContain('Junior at Stanford on payments infra');
    expect(fwd.body.draft.body).not.toMatch(/[—–!]/);
    const [row] = await t.db.sql<{
      via: { cc: string; friendAskId: string };
      user_id: string;
      person_id: string;
    }>`
      select via, user_id, person_id from orbit.drafts where id = ${fwd.body.draft.id}::uuid`;
    expect(row!.user_id).toBe(ana.userId);
    expect(row!.person_id).toBe(dan);
    expect(row!.via.cc).toBe(maya.email);
    expect(row!.via.friendAskId).toBe(asked.body.ask.id);
    // the asker's list says forwarded; Dan's address is nowhere in it
    const mine = await call<{ asked: Record<string, unknown>[] }>('/friends/asks', maya.token, {});
    expect(mine.body.asked[0]!.status).toBe('forwarded');
    expect(JSON.stringify(mine.body)).not.toContain('dan@stripe.com');
    // answered once: a second answer is refused
    const twice = await call<Err>(`/friends/asks/${asked.body.ask.id}/respond`, ana.token, {
      action: 'decline',
    });
    expect(twice.status).toBe(409);
    // ending the friendship ends visibility at once and expires what was still open
    const other = await call<{ ask: { id: string } }>('/friends/asks', maya.token, {
      friendUserId: ana.userId,
      targetPersonId: (
        await t.db.sql<{
          id: string;
        }>`select id from orbit.people where user_id = ${ana.userId}::uuid and display_name = 'Priya Raman'`
      )[0]!.id,
      note: 'and Priya too',
    });
    expect(other.status).toBe(200);
    const ended = await call('/friends/end', maya.token, { friendshipId });
    expect(ended.status).toBe(200);
    expect(await visible(maya.userId, ana.userId)).toBe(false);
    expect(await visible(ana.userId, maya.userId)).toBe(false);
    const [expired] = await t.db.sql<{
      status: string;
    }>`select status from orbit.friend_intro_asks where id = ${other.body.ask.id}::uuid`;
    expect(expired!.status).toBe('expired');
    const gone = await call<Found>('/paths/find', maya.token, { target: { company: 'Figma' } });
    expect(gone.body.sources).not.toContain('friends');
  });

  it('rate limits: twenty invites a day, ten asks a day per friend; a link invite needs no address', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const me = await signedInUser(t, { firstName: 'Lim' });
    const link = await call<{ code: string; link: string; status: string }>('/friends/invite', me.token, {});
    expect(link.status).toBe(200);
    expect(link.body.status).toBe('link');
    expect(link.body.code).toHaveLength(22);
    expect(link.body.link).toContain(`/friends/join/${link.body.code}`);
    for (let i = 1; i < 20; i++) expect((await call('/friends/invite', me.token, {})).status).toBe(200);
    const over = await call<Err>('/friends/invite', me.token, { email: 'one.more@example.com' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    const bad = await call<Err>('/friends/invite', me.token, { email: 'not an address' });
    expect(bad.status).toBe(400);
  });

  it('declining removes the request so a later invite starts clean; a code sent to another address is refused', async () => {
    const call = api(t, fakeNet(), { env: {} });
    const a = await signedInUser(t, { firstName: 'Ade' });
    const b = await signedInUser(t, { firstName: 'Bea' });
    const c = await signedInUser(t, { firstName: 'Cal' });
    const inv = await call<{ code: string; status: string }>('/friends/invite', a.token, { email: b.email });
    expect(inv.body.status).toBe('requested');
    const wrong = await call<Err>('/friends/accept', c.token, { code: inv.body.code, mode: 'all' });
    expect(wrong.status).toBe(403);
    const pending = await call<{ pending: { direction: string; name: string | null }[] }>(
      '/friends',
      b.token,
      {},
    );
    expect(pending.body.pending).toEqual([expect.objectContaining({ direction: 'in', name: 'Ade Rivera' })]);
    const dec = await call('/friends/decline', b.token, { code: inv.body.code });
    expect(dec.status).toBe(200);
    const [rows] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.friendships where a in (${a.userId}::uuid, ${b.userId}::uuid) and b in (${a.userId}::uuid, ${b.userId}::uuid)`;
    expect(rows!.n).toBe(0);
    const inv2 = await call<{ code: string; status: string }>('/friends/invite', a.token, { email: b.email });
    expect(inv2.status).toBe(200);
    expect(inv2.body.status).toBe('requested');
    const acc = await call<{ friend: Friend }>('/friends/accept', b.token, {
      code: inv2.body.code,
      mode: 'none',
    });
    expect(acc.status).toBe(200);
    expect(acc.body.friend.myMode).toBe('none');
    expect(await visible(a.userId, b.userId)).toBe(false);
    expect(await visible(b.userId, a.userId)).toBe(true);
  });

  it('a second change on the same day still refreshes the projection, and a full re-score refreshes it too', async () => {
    const { call, ana } = await twoFriends();
    const queued = async () => {
      const rows = await t.db.sql<{ k: string }>`
        select message ->> 'dedupeKey' as k from pgmq.q_orbit_score
         where message ->> 'kind' = 'friend_shares_refresh' and message ->> 'userId' = ${ana.userId}`;
      return rows.map((r) => r.k);
    };
    // the accept queued one; mark it run, the way the worker records it, and take it off the queue
    const first = await queued();
    expect(first.length).toBeGreaterThan(0);
    for (const k of first)
      await t.db.sql`
        insert into orbit.job_runs (queue, user_id, kind, dedupe_key, status, finished_at)
        values ('orbit_score', ${ana.userId}::uuid, 'friend_shares_refresh', ${k}, 'ok', now())`;
    await t.db.sql`delete from pgmq.q_orbit_score where message ->> 'kind' = 'friend_shares_refresh'`;
    // the same day, Ana narrows what she shares: a refresh is queued again, not dropped as already run
    const set = await call('/friends/settings', ana.token, {
      mode: 'companies',
      companyDomains: ['stripe.com'],
    });
    expect(set.status).toBe(200);
    expect((await queued()).length).toBe(1);
    await t.db.sql`delete from pgmq.q_orbit_score where message ->> 'kind' = 'friend_shares_refresh'`;
    // a full re-score (nightly, or after a backfill) queues one for a student with a friend
    const handlers = defaultHandlers({});
    await handlers['score.user']!(
      { queue: 'orbit_score', msgId: 1, readCt: 1, kind: 'score.user', userId: ana.userId, payload: {} },
      { db: t.db, queue: { ...sqlQueue(t.db), setVt: async () => undefined }, now: () => new Date() },
    );
    expect((await queued()).map((k) => k.split(':')[3])).toEqual(['score']);
  });
});
