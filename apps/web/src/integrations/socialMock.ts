/**
 * The sample student's made-up Instagram and X (plan 43 §8.7), so connecting, reading, matching, checking, sending,
 * switching off and removing can all be shown and tested with no server and no network. Built from the demo's own
 * people, the same way connectorsMock.ts fakes live LinkedIn:
 *
 * - Instagram: the student's handle; DMs with their two closest people (a day each way, a few weeks of them); their
 *   closest people's accounts attached by proof; one account Orbit attached by score to the wrong person (so "Not
 *   their account" can be shown); one "is this the same person" question; and Jules Moreau, a designer the student is
 *   going after, whose LinkedIn lists her handle. Checking Instagram for Jules finds the student's closest friend
 *   follows her and she follows back.
 * - X: the student's handle, two attached accounts by public proof, and a priced check for Jules that finds a second
 *   bridge.
 *
 * Reading takes a few seconds, step by step, like the first days on Instagram do in a few hours. Nothing leaves the
 * browser.
 */
import type { Person } from '@orbit/core';
import { newId } from '@orbit/core';
import { db, type SocialLinkRow, type SocialLookupRow } from '../db/schema';
import { recomputeEdges } from '../engine/graph';
import { setSourceState } from '../engine/sources';
import type { InstagramStatusResponse, SocialStep, XStatusResponse } from './orbitApi';

type Platform = 'instagram' | 'x';

interface MockState {
  instagram?: { connectedAt: string; username: string; status: 'active' | 'not_connected' };
  x?: { connectedAt: string; username: string; status: 'active' | 'not_connected'; spentUsd: number };
}

const KEY = (userId: string) => `socialMock:${userId}`;
/** The demo's own target, made when Instagram connects: someone the student is going after and does not know. */
export const MOCK_TARGET_ID = 'p_social_jules';
/** How long each of Instagram's four steps takes in the demo. */
export const MOCK_STEP_MS = 1200;
export const MOCK_LOOKUP_MS = 1500;
export const MOCK_X_LIMIT_USD = 15;
export const MOCK_X_QUOTE = { quoteUsd: 4, list: 'following', size: 400 };

let stepMs = MOCK_STEP_MS;
let lookupMs = MOCK_LOOKUP_MS;
/** Tests: how long the made-up reads take. */
export function setSocialMockTimingForTests(t: { stepMs?: number; lookupMs?: number } | undefined): void {
  stepMs = t?.stepMs ?? MOCK_STEP_MS;
  lookupMs = t?.lookupMs ?? MOCK_LOOKUP_MS;
}

async function load(userId: string): Promise<MockState> {
  return ((await db.kv.get(KEY(userId)))?.value as MockState | undefined) ?? {};
}
async function save(userId: string, s: MockState): Promise<void> {
  await db.kv.put({ key: KEY(userId), value: s });
}

const handleFor = (p: Pick<Person, 'firstName' | 'lastName'>, extra = '') =>
  `${p.firstName}.${p.lastName}${extra}`.toLowerCase().replace(/[^a-z0-9._]/g, '');

/** The demo's people the student knows best, closest first (never the target). */
async function closest(userId: string): Promise<Person[]> {
  const people = await db.people.where('userId').equals(userId).toArray();
  return people
    .filter((p) => p.isHuman && !p.hiddenAt && p.id !== MOCK_TARGET_ID && p.firstName && p.lastName)
    .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
}

// ---- status -------------------------------------------------------------------------------------------------------

export async function instagramStatus(userId: string, now = Date.now()): Promise<InstagramStatusResponse> {
  const s = (await load(userId)).instagram;
  if (s?.status === 'active') {
    const at = Math.floor((now - Date.parse(s.connectedAt)) / stepMs);
    const step = (i: number): SocialStep => (at > i ? 'done' : at === i ? 'reading' : 'waiting');
    return {
      status: 'active',
      username: s.username,
      steps: { profile: step(0), chats: step(1), following: step(2), followers: step(3) },
    };
  }
  return {
    status: 'not_connected',
    steps: { profile: 'waiting', chats: 'waiting', following: 'waiting', followers: 'waiting' },
  };
}

export async function xStatus(userId: string): Promise<XStatusResponse> {
  const s = (await load(userId)).x;
  return {
    status: s?.status === 'active' ? 'active' : 'not_connected',
    ...(s?.status === 'active' ? { username: s.username } : {}),
    spentThisMonthUsd: s?.spentUsd ?? 0,
    limitUsd: MOCK_X_LIMIT_USD,
    orbitLimitReached: false,
  };
}

// ---- connecting ---------------------------------------------------------------------------------------------------

export async function connectInstagram(
  userId: string,
  _opts: { replace?: boolean } = {},
): Promise<{ ok: true; status: 'active' }> {
  const user = await db.users.get(userId);
  const s = await load(userId);
  s.instagram = {
    connectedAt: new Date().toISOString(),
    username: user ? handleFor(user) : 'alex.student',
    status: 'active',
  };
  await save(userId, s);
  await seedInstagram(userId);
  await setSourceState('instagram', 'on', userId);
  return { ok: true, status: 'active' };
}

export async function connectX(userId: string): Promise<void> {
  const user = await db.users.get(userId);
  const s = await load(userId);
  s.x = {
    connectedAt: new Date().toISOString(),
    username: user
      ? `${user.firstName}${user.lastName}`.toLowerCase().replace(/[^a-z0-9_]/g, '')
      : 'alexstudent',
    status: 'active',
    spentUsd: s.x?.spentUsd ?? 0,
  };
  await save(userId, s);
  await seedX(userId);
  await setSourceState('x', 'on', userId);
}

export async function disconnect(userId: string, p: Platform): Promise<void> {
  const s = await load(userId);
  const one = s[p];
  if (one) one.status = 'not_connected';
  await save(userId, s);
}

/** Removed: the made-up account is gone, and so is the target only Instagram knew. */
export async function removeAll(userId: string, p: Platform): Promise<void> {
  const s = await load(userId);
  delete s[p];
  await save(userId, s);
  if (p === 'instagram' && (await db.people.get(MOCK_TARGET_ID))) {
    const chat = await db.chats.where('personId').equals(MOCK_TARGET_ID).first();
    if (!chat) {
      await db.people.delete(MOCK_TARGET_ID);
      await recomputeEdges(userId);
    }
  }
}

// ---- what the made-up accounts hold -------------------------------------------------------------------------------

const DAY = 86_400_000;

function link(
  userId: string,
  platform: Platform,
  person: Pick<Person, 'id'>,
  username: string,
  name: string,
  via: SocialLinkRow['via'],
  extra: Partial<SocialLinkRow> = {},
): SocialLinkRow {
  const at = new Date().toISOString();
  return {
    id: `sl_${platform}_${person.id}`,
    userId,
    platform,
    accountId: `${platform === 'instagram' ? 'ig' : 'x'}_${username.replace(/\W/g, '')}`,
    personId: person.id,
    username,
    name,
    via,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

async function ensureTarget(userId: string): Promise<Person> {
  const had = await db.people.get(MOCK_TARGET_ID);
  if (had) return had;
  const at = new Date().toISOString();
  const p: Person = {
    id: MOCK_TARGET_ID,
    userId,
    firstName: 'Jules',
    lastName: 'Moreau',
    displayName: 'Jules Moreau',
    nameNormalized: 'jules moreau',
    emails: [],
    currentTitle: 'Product Designer',
    currentOrganizationRaw: 'Arcade',
    headline: 'Product Designer at Arcade',
    location: 'San Francisco, CA',
    linkedinUrl: 'https://www.linkedin.com/in/jules-moreau-design',
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['instagram'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  };
  await db.people.put(p);
  return p;
}

async function seedInstagram(userId: string): Promise<void> {
  const people = await closest(userId);
  const [bridge, friend, asked, wrong] = people;
  const target = await ensureTarget(userId);
  const links: SocialLinkRow[] = [
    // her LinkedIn lists her handle: hard proof (plan 43 §3.4)
    link(userId, 'instagram', target, 'jules.makes', 'Jules Moreau', 'proof', {
      proof: 'own_links',
      followsYou: false,
    }),
  ];
  if (bridge)
    links.push(
      link(userId, 'instagram', bridge, handleFor(bridge), bridge.displayName, 'proof', {
        proof: 'address_book',
        followsYou: true,
      }),
    );
  if (friend)
    links.push(
      link(userId, 'instagram', friend, handleFor(friend), friend.displayName, 'proof', {
        proof: 'links_back',
        followsYou: true,
      }),
    );
  // attached by score, to the wrong person: the one "Not their account" undoes
  if (wrong)
    links.push(
      link(
        userId,
        'instagram',
        wrong,
        handleFor(wrong, '.photo'),
        `${wrong.firstName} ${wrong.lastName}`,
        'score',
        {
          score: 0.96,
          followsYou: false,
        },
      ),
    );
  await db.socialLinks.bulkPut(links);
  if (asked) {
    const at = new Date().toISOString();
    await db.socialAsks.put({
      id: `sa_instagram_${asked.id}`,
      userId,
      platform: 'instagram',
      accountId: `ig_${handleFor(asked, '22').replace(/\W/g, '')}`,
      personId: asked.id,
      username: handleFor(asked, '22'),
      name: asked.displayName,
      personName: asked.displayName,
      score: 0.82,
      signals: {
        for: [
          'The same name',
          ...(asked.currentOrganizationRaw ? [`The bio names ${asked.currentOrganizationRaw}`] : []),
          'You follow 6 of the same people',
        ],
        against: ['The handle has numbers in it, so it counts for little'],
      },
      status: 'open',
      createdAt: at,
      updatedAt: at,
    });
  }
  // DMs: a day each way, every few days for six weeks, with the two closest
  const now = Date.now();
  for (const [i, p] of [bridge, friend].entries()) {
    if (!p) continue;
    for (let d = 0; d < 6; d++) {
      const day = new Date(now - (3 + d * 7 + i) * DAY);
      for (const kind of ['instagram_in', 'instagram_out'] as const)
        await db.touchpoints.put({
          id: `tp_ig_${p.id}_${d}_${kind}`,
          userId,
          personId: p.id,
          kind,
          occurredAt: day.toISOString(),
          refTable: 'instagram',
          refId: `${p.id}:${d}:${kind}`,
          summary: kind === 'instagram_in' ? 'Instagram message from them' : 'Instagram message to them',
          weight: 0.3,
          words: true,
          group: 2,
          accountId: `ig_${handleFor(p).replace(/\W/g, '')}`,
        });
    }
  }
  await recomputeEdges(userId);
}

async function seedX(userId: string): Promise<void> {
  const people = await closest(userId);
  const second = people[1];
  const target = (await db.people.get(MOCK_TARGET_ID)) ?? (await ensureTarget(userId));
  const links: SocialLinkRow[] = [
    // X accounts are attached from public proof only (plan 43 §5): her site links it
    link(userId, 'x', target, 'julesmoreau', 'Jules Moreau', 'proof', {
      proof: 'links_back',
      acceptsDms: false,
    }),
  ];
  if (second)
    links.push(
      link(
        userId,
        'x',
        second,
        `${second.firstName}${second.lastName}`.toLowerCase(),
        second.displayName,
        'proof',
        {
          proof: 'own_links',
          acceptsDms: true,
        },
      ),
    );
  await db.socialLinks.bulkPut(links);
}

// ---- people --------------------------------------------------------------------------------------------------------

export async function detach(userId: string, linkId: string): Promise<void> {
  const l = await db.socialLinks.get(linkId);
  if (!l || l.userId !== userId) return;
  await db.socialLinks.delete(linkId);
  await db.socialTies
    .where('userId')
    .equals(userId)
    .filter((t) => t.platform === l.platform && (t.aId === l.personId || t.bId === l.personId))
    .delete();
}

export async function attach(
  userId: string,
  a: { platform: Platform; accountId: string; personId: string },
): Promise<{ ok: true; linkId: string } | { ok: false; message: string }> {
  const p = await db.people.get(a.personId);
  if (!p) return { ok: false, message: 'Orbit could not find that person.' };
  if (a.platform === 'x') return { ok: false, message: 'An X account is attached only from public proof.' };
  const row = link(userId, a.platform, p, a.accountId.replace(/^ig_/, ''), p.displayName, 'student');
  row.accountId = a.accountId;
  await db.socialLinks.put(row);
  return { ok: true, linkId: row.id };
}

export async function answer(
  userId: string,
  askId: string,
  answer: 'yes' | 'no',
): Promise<{ ok: true } | { ok: false; message: string }> {
  const a = await db.socialAsks.get(askId);
  if (!a || a.userId !== userId) return { ok: false, message: 'That question is gone.' };
  await db.socialAsks.update(askId, { status: answer, updatedAt: new Date().toISOString() });
  if (answer === 'yes') {
    const p = await db.people.get(a.personId);
    if (p) {
      const row = link(userId, a.platform, p, a.username ?? a.accountId, a.name ?? p.displayName, 'student', {
        followsYou: true,
      });
      row.accountId = a.accountId;
      await db.socialLinks.put(row);
    }
  }
  return { ok: true };
}

// ---- checks -------------------------------------------------------------------------------------------------------

export async function startLookup(
  userId: string,
  platform: Platform,
  personId: string,
  opts: { confirm?: boolean } = {},
): Promise<
  | { ok: true; lookupId: string }
  | { ok: true; quote: typeof MOCK_X_QUOTE }
  | { ok: false; message: string; code?: 'source_off' | 'no_account' }
> {
  const s = await load(userId);
  if (s[platform]?.status !== 'active')
    return { ok: false, code: 'source_off', message: `${platform === 'x' ? 'X' : 'Instagram'} is not on.` };
  const target = await db.socialLinks
    .where('personId')
    .equals(personId)
    .filter((l) => l.platform === platform)
    .first();
  if (!target)
    return {
      ok: false,
      code: 'no_account',
      message: `Orbit does not know their ${platform === 'x' ? 'X' : 'Instagram'} account for sure, so it cannot look.`,
    };
  // X shows its price first and reads nothing until the student says go (plan 43 §5)
  if (platform === 'x' && !opts.confirm) return { ok: true, quote: { ...MOCK_X_QUOTE } };
  if (platform === 'x') {
    s.x!.spentUsd = Math.round(((s.x!.spentUsd ?? 0) + MOCK_X_QUOTE.quoteUsd) * 100) / 100;
    await save(userId, s);
  }
  const at = new Date().toISOString();
  const row: SocialLookupRow = {
    id: newId('lk'),
    userId,
    platform,
    targetPersonId: personId,
    status: 'running',
    createdAt: at,
    updatedAt: at,
  };
  await db.socialLookups.put(row);
  setTimeout(() => void finishLookup(userId, row.id), lookupMs);
  return { ok: true, lookupId: row.id };
}

/** The made-up answer: the target follows back the student's closest friend (Instagram) or second closest (X). */
async function finishLookup(userId: string, lookupId: string): Promise<void> {
  const l = await db.socialLookups.get(lookupId);
  if (!l || l.status === 'done') return;
  const people = await closest(userId);
  const bridge = l.platform === 'instagram' ? people[0] : people[1];
  const fan = l.platform === 'instagram' ? people[2] : people[0];
  const at = new Date().toISOString();
  const result: NonNullable<SocialLookupRow['result']> = { bridges: [], oneWay: [], partial: false };
  const kinds =
    l.platform === 'instagram'
      ? ({ mutual: 'instagram_mutual', follow: 'instagram_follow' } as const)
      : ({ mutual: 'x_mutual', follow: 'x_follow' } as const);
  if (l.targetPersonId === MOCK_TARGET_ID && bridge) {
    result.bridges.push({
      personId: bridge.id,
      accountId: `${l.platform}_${bridge.id}`,
      name: bridge.displayName,
    });
    await db.socialTies.put({
      id: `st_${kinds.mutual}_${bridge.id}_${l.targetPersonId}`,
      userId,
      platform: l.platform,
      kind: kinds.mutual,
      aId: bridge.id,
      bId: l.targetPersonId,
      createdAt: at,
    });
    if (fan && fan.id !== bridge.id) {
      result.oneWay.push({ personId: fan.id, accountId: `${l.platform}_${fan.id}`, followerId: fan.id });
      await db.socialTies.put({
        id: `st_${kinds.follow}_${fan.id}_${l.targetPersonId}`,
        userId,
        platform: l.platform,
        kind: kinds.follow,
        aId: fan.id,
        bId: l.targetPersonId,
        followerId: fan.id,
        createdAt: at,
      });
    }
  } else result.partial = l.platform === 'instagram';
  await db.socialLookups.update(lookupId, { status: 'done', result, updatedAt: at });
}
