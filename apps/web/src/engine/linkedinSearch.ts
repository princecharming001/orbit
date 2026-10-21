/**
 * Finding new people on LinkedIn without an Orbit account: with LinkedIn connected live in this browser, the search
 * runs from the student's own LinkedIn (second- and third-degree people, so the results are people they do not know
 * yet), and the ones they pick become people in Orbit with a chat at "to contact". The sample student searches a
 * mock pool.
 */
import type { CoffeeChat, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../db/schema';
import { mockLinkedInSearch, usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import { type LinkedInFound, searchLinkedIn, unipileConfigured } from '../integrations/unipile';
import { LIVE_SOON, liveLinkedInAccount } from './linkedinLive';
import { addPersonByHand } from './people';

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

export type LinkedInSearchOutcome = { ok: true; people: FoundView[] } | { ok: false; message: string };

export async function searchLinkedInLive(
  user: Pick<User, 'id'>,
  keywords: string | undefined,
  opts: { fetch?: typeof fetch } = {},
): Promise<LinkedInSearchOutcome> {
  const row = await liveLinkedInAccount(user.id);
  if (!row?.externalAccountId) return { ok: false, message: 'Connect LinkedIn in Settings first.' };
  let people: LinkedInFound[];
  if (usesMockConnectors(user.id)) people = mockLinkedInSearch(keywords);
  else {
    const r = await searchLinkedIn(
      row.externalAccountId,
      { keywords: keywords?.trim() || undefined, distance: [2, 3] },
      { token: row.accessToken, fetch: opts.fetch },
    );
    if (!r.ok) return { ok: false, message: r.reason === 'unconfigured' ? LIVE_SOON : r.message };
    people = r.value.people;
  }
  const mine = await db.people.where('userId').equals(user.id).toArray();
  const known = new Map(mine.filter((p) => p.linkedinMemberId).map((p) => [p.linkedinMemberId!, p.id]));
  return {
    ok: true,
    people: people.map((p) => {
      const id = `${LINKEDIN_FOUND_PREFIX}${p.memberId}`;
      found.set(id, p);
      return { ...p, id, knownPersonId: known.get(p.memberId) };
    }),
  };
}

export type AddFoundOutcome =
  | { ok: true; people: { id: string; displayName: string; chatId: string }[] }
  | { ok: false; message: string };

/** Add people a LinkedIn search found: each becomes a person with a chat at "to contact", to write to on LinkedIn. */
export async function addLinkedInFound(
  user: Pick<User, 'id' | 'school'>,
  ids: string[],
  now = new Date(),
): Promise<AddFoundOutcome> {
  const picked = ids.map((id) => found.get(id)).filter((p): p is LinkedInFound => !!p);
  if (!picked.length) return { ok: false, message: 'Search again, then pick who to add.' };
  const out: { id: string; displayName: string; chatId: string }[] = [];
  for (const f of picked) {
    const [title, company] = (f.headline ?? '').split(/\s+at\s+/i);
    const r = await addPersonByHand(
      user.id,
      { name: f.name, linkedinUrl: f.profileUrl, title: title?.trim(), company: company?.trim() },
      user.school,
    );
    if (!r) continue;
    const person = r.person;
    await db.people.update(person.id, { linkedinMemberId: f.memberId });
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
  return { ok: true, people: out };
}
