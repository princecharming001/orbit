/**
 * Finding new people on LinkedIn without an Orbit account: with LinkedIn connected live in this browser, the search
 * runs from the student's own LinkedIn (second- and third-degree people, so the results are people they do not know
 * yet), and the ones they pick become people in Orbit with a chat at "to contact". The sample student searches a
 * mock pool.
 */
import type { CoffeeChat, User } from '@orbit/core';
import { newId, roleFromHeadline } from '@orbit/core';
import { db } from '../db/schema';
import { mockLinkedInSearchPage, usesMockConnectors } from '../integrations/connectorsMock';
import { callApi, isServerUser } from '../integrations/orbitApi';
import {
  type LinkedInFound,
  type LinkedInSearchQuery,
  SEARCH_LIMIT_STATUS,
  searchLinkedIn,
  unipileConfigured,
} from '../integrations/unipile';
import { updateEdgesFor } from './graph';
import { LIVE_SOON, liveLinkedInAccount } from './linkedinLive';
import { addPersonByHand } from './people';
import { freshPhoto } from './photos';

/** Ids of search results start with this, so add_sourced can tell them from the server's recommendations. */
export const LINKEDIN_FOUND_PREFIX = 'li:';

/** Results of this session's searches, by id, so the student can add the ones they pick. */
const found = new Map<string, LinkedInFound>();

export interface FoundView extends LinkedInFound {
  id: string;
  /** someone Orbit already has */
  knownPersonId?: string;
}

/** A search can run from this browser's LinkedIn: live LinkedIn is connected here (or this is the sample student). */
export async function linkedInSearchReady(user: Pick<User, 'id'>): Promise<boolean> {
  if (isServerUser(user.id)) return false;
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return false;
  return usesMockConnectors(user.id) || (unipileConfigured() && !!row.accessToken);
}

export type LinkedInSearchOutcome =
  | { ok: true; people: FoundView[]; cursor?: string; total?: number }
  | { ok: false; message: string; limit?: boolean };

/** The filters a structured search can add to (or use instead of) keywords; LinkedIn ANDs them. */
export type LinkedInSearchFilters = Pick<LinkedInSearchQuery, 'title' | 'company' | 'school' | 'location'>;

/**
 * One page of a LinkedIn people search from the student's own account (second and third degree). Keywords alone
 * (chat, the Map) or with filters (Discover); `cursor` asks for the page after the one that returned it.
 */
export async function searchLinkedInLive(
  user: Pick<User, 'id'>,
  keywords: string | undefined,
  opts: { fetch?: typeof fetch; filters?: LinkedInSearchFilters; cursor?: string } = {},
): Promise<LinkedInSearchOutcome> {
  const row = await liveLinkedInAccount(user.id);
  if (!row?.externalAccountId) return { ok: false, message: 'Connect LinkedIn in Settings first.' };
  let people: LinkedInFound[];
  let cursor: string | undefined;
  let total: number | undefined;
  const filters = Object.fromEntries(
    Object.entries(opts.filters ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()),
  ) as LinkedInSearchFilters;
  if (usesMockConnectors(user.id)) {
    const page = mockLinkedInSearchPage({ keywords, ...filters }, opts.cursor);
    people = page.people;
    cursor = page.cursor;
    total = page.total;
  } else {
    const r = await searchLinkedIn(
      row.externalAccountId,
      { keywords: keywords?.trim() || undefined, ...filters, distance: [2, 3], cursor: opts.cursor },
      { token: row.accessToken, fetch: opts.fetch },
    );
    if (!r.ok)
      return {
        ok: false,
        message: r.reason === 'unconfigured' ? LIVE_SOON : r.message,
        limit: r.status === SEARCH_LIMIT_STATUS || undefined,
      };
    people = r.value.people;
    cursor = r.value.cursor;
    total = r.value.total;
  }
  const mine = await db.people.where('userId').equals(user.id).toArray();
  const known = new Map(mine.filter((p) => p.linkedinMemberId).map((p) => [p.linkedinMemberId!, p]));
  // someone Orbit already has, found again: a fresh LinkedIn photo, and the headline where Orbit had none
  for (const f of people) {
    const p = known.get(f.memberId);
    if (p && (freshPhoto(p.photoUrl, f.pictureUrl) !== p.photoUrl || (!p.headline && f.headline)))
      await db.people.update(p.id, {
        photoUrl: freshPhoto(p.photoUrl, f.pictureUrl),
        headline: p.headline ?? f.headline,
      });
  }
  return {
    ok: true,
    people: people.map((p) => {
      const id = `${LINKEDIN_FOUND_PREFIX}${p.memberId}`;
      found.set(id, p);
      return { ...p, id, knownPersonId: known.get(p.memberId)?.id };
    }),
    cursor,
    total,
  };
}

/**
 * Make a result found earlier (Discover keeps its pages in this browser) addable again in this session: the add
 * reads this session's results, and a reload starts with none.
 */
export function rememberFound(f: LinkedInFound): string {
  const id = `${LINKEDIN_FOUND_PREFIX}${f.memberId}`;
  if (!found.has(id)) found.set(id, f);
  return id;
}

export type AddFoundOutcome =
  | { ok: true; people: { id: string; displayName: string; chatId: string }[] }
  | { ok: false; message: string };

/**
 * Add people a LinkedIn search found: each becomes a person with a chat at "to contact", to write to on LinkedIn.
 * Their edges (colleagues, classmates) are worked out at once, so the Map has routes to them straight away; their
 * member id is kept, so their LinkedIn mutuals can be looked up too.
 */
export async function addLinkedInFound(
  user: Pick<User, 'id' | 'school'>,
  ids: string[],
  now = new Date(),
): Promise<AddFoundOutcome> {
  const picked = ids.map((id) => found.get(id)).filter((p): p is LinkedInFound => !!p);
  if (!picked.length) return { ok: false, message: 'Search again, then pick who to add.' };
  const out: { id: string; displayName: string; chatId: string }[] = [];
  for (const f of picked) {
    const { title, org: company } = roleFromHeadline(f.headline);
    // saved to contact, not someone the student knows: the company and reach views say so
    const r = await addPersonByHand(
      user.id,
      { name: f.name, linkedinUrl: f.profileUrl, title, company, source: 'linkedin_search' },
      user.school,
    );
    if (!r) continue;
    const person = r.person;
    await db.people.update(person.id, {
      linkedinMemberId: f.memberId,
      photoUrl: freshPhoto(person.photoUrl, f.pictureUrl),
      headline: person.headline ?? f.headline,
    });
    let chat = await db.chats
      .where('personId')
      .equals(person.id)
      .filter((c) => c.stage !== 'archived')
      .first();
    if (!chat) {
      const at = now.toISOString();
      chat = {
        id: newId('c'),
        userId: user.id,
        personId: person.id,
        organizationId: person.currentOrganizationId,
        stage: 'identified',
        stageEnteredAt: at,
        source: 'manual',
        goalTags: [],
        outreachChannel: 'linkedin',
        bumpCount: 0,
        priority: 2,
        createdAt: at,
        updatedAt: at,
      } satisfies CoffeeChat;
      await db.chats.add(chat);
      await db.stageEvents.add({
        id: newId('se'),
        userId: user.id,
        chatId: chat.id,
        toStage: 'identified',
        status: 'applied',
        actor: 'user',
        reason: 'linkedin_search:added',
        createdAt: at,
        decidedAt: at,
      });
    }
    out.push({ id: person.id, displayName: person.displayName, chatId: chat.id });
  }
  if (!out.length) return { ok: false, message: 'None of them could be added.' };
  await updateEdgesFor(
    user.id,
    out.map((p) => p.id),
  );
  return { ok: true, people: out };
}

export type PeopleLookup =
  | { ok: true; people: FoundView[] }
  | { ok: false; reason: 'not_connected' | 'limit' | 'unavailable' };

/** One search's answer per query in this session: typing the same name again asks LinkedIn nothing. */
const lookups = new Map<string, Promise<PeopleLookup>>();

/**
 * People on LinkedIn a typed name or role finds, for Add a person: photo, name and headline, any degree. With an
 * account the server searches from the LinkedIn connected there; otherwise the LinkedIn connected in this browser
 * does (the sample student searches its mock pool). Each result can be added with addLinkedInFound.
 */
export function lookUpLinkedInPeople(user: Pick<User, 'id'>, q: string): Promise<PeopleLookup> {
  const key = `${user.id}|${q.trim().toLowerCase()}`;
  const hit = lookups.get(key);
  if (hit) return hit;
  const run = (async (): Promise<PeopleLookup> => {
    let people: LinkedInFound[];
    if (isServerUser(user.id)) {
      const r = await callApi('/linkedin/search', { q: q.trim() });
      if (!r.ok) return { ok: false, reason: 'unavailable' };
      if (!r.value.ok)
        return {
          ok: false,
          reason:
            r.value.reason === 'not_connected' || r.value.reason === 'limit' ? r.value.reason : 'unavailable',
        };
      people = r.value.people;
    } else {
      if (!(await linkedInSearchReady(user))) return { ok: false, reason: 'not_connected' };
      const r = await searchLinkedInLive(user, q);
      if (!r.ok) return { ok: false, reason: r.limit ? 'limit' : 'unavailable' };
      people = r.people;
    }
    const mine = await db.people.where('userId').equals(user.id).toArray();
    const known = new Map(mine.filter((p) => p.linkedinMemberId).map((p) => [p.linkedinMemberId!, p.id]));
    return {
      ok: true,
      people: people.map((p) => ({ ...p, id: rememberFound(p), knownPersonId: known.get(p.memberId) })),
    };
  })();
  lookups.set(key, run);
  // a failure is not kept: the next keystroke may find LinkedIn back
  void run.then((r) => {
    if (!r.ok) lookups.delete(key);
  });
  return run;
}
