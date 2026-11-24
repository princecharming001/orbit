/**
 * Finding new people for a goal (plan 16 §6) from the browser's side, account mode only: the search runs on orbit-api
 * across its providers, the student adds the ones they want, and the new people and chats arrive with a pull.
 */
import type {
  GoalKind,
  SourceConnectCode,
  SourcedCandidate,
  SourceEmailResponse,
  SourceSearchResponse,
  User,
} from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { blockForStatus } from './linkedinSendWords';
import { freshLinkedinStatus, pullNow, serverIdOf } from './serverSync';

/** The providers by the names a student would know. */
export const PROVIDER_LABELS: Record<string, string> = {
  unipile: 'LinkedIn search',
  apollo: 'Apollo',
  exa: 'Exa',
  web: 'Web search',
  semantic_scholar: 'Semantic Scholar',
  village: 'Village',
};

/** "a list of keys" → "LinkedIn search and Apollo" */
export function providerNames(ids: string[]): string {
  const names = ids.map(
    (id) =>
      PROVIDER_LABELS[id.toLowerCase()] ??
      PROVIDER_LABELS[id.toLowerCase().replace(/_api_key$/, '')] ??
      'one source',
  );
  const unique = [...new Set(names)];
  return unique.length <= 1 ? (unique[0] ?? '') : `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

export type SearchOutcome = { ok: true; value: SourceSearchResponse } | { ok: false; message: string };

function notHere(): { ok: false; message: string } {
  return { ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER };
}

export interface SearchFilters {
  schools?: string[];
  organizations?: string[];
  keywords?: string[];
  titles?: string[];
  locations?: string[];
  seniority?: string[];
}

export async function searchPeople(
  user: Pick<User, 'id'>,
  q: {
    purpose: GoalKind;
    query?: string;
    goalId?: string;
    limit?: number;
    filters?: SearchFilters;
    /** checks each person found is read against; a must-have "no" leaves them out */
    criteria?: { text: string; need?: 'must' | 'nice' }[];
    /** people only: no funds or companies in the answer */
    peopleOnly?: boolean;
  },
): Promise<SearchOutcome> {
  if (!isServerUser(user.id)) return notHere();
  const clean = (xs?: string[]) => {
    const out = (xs ?? []).map((x) => x.trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const filters = {
    schools: clean(q.filters?.schools),
    organizations: clean(q.filters?.organizations),
    keywords: clean(q.filters?.keywords),
    titles: clean(q.filters?.titles),
    locations: clean(q.filters?.locations),
    seniority: clean(q.filters?.seniority),
  };
  // the hometown lives in the browser; the server reads it for the shared-background tier
  const homeCity = (await db.users.get(user.id).catch(() => undefined))?.homeCity?.trim() || undefined;
  const r = await callApi('/source/search', {
    purpose: q.purpose,
    query: q.query?.trim() || undefined,
    homeCity,
    goalId: q.goalId,
    limit: q.limit ?? 20,
    ...(Object.values(filters).some(Boolean) ? { filters } : {}),
    ...(q.criteria?.length ? { criteria: q.criteria.slice(0, 6) } : {}),
    ...(q.peopleOnly ? { peopleOnly: true } : {}),
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: r.value };
}

export type AddOutcome =
  | { ok: true; people: { id: string; displayName: string; chatId: string }[] }
  | { ok: false; message: string };

const PULL_WAITS_MS = [0, 1500, 2500, 4000];

/** Pulls until every one of these people is in the browser's own copy, a few tries, then gives up quietly. */
export async function pullUntilHere(
  userId: string,
  personIds: string[],
  waits: number[] = PULL_WAITS_MS,
): Promise<boolean> {
  for (const wait of waits) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    await pullNow(userId).catch(() => undefined);
    const here = await db.people.bulkGet(personIds);
    if (here.every(Boolean)) return true;
  }
  return false;
}

/**
 * Save sourced candidates the student picked to People: each becomes a person with a chat that waits for a first
 * message. Nothing is sent and no research starts.
 */
export async function addSourced(user: Pick<User, 'id'>, recommendationIds: string[]): Promise<AddOutcome> {
  if (!isServerUser(user.id)) return notHere();
  if (!recommendationIds.length) return { ok: false, message: 'Pick someone to save first.' };
  const r = await callApi('/source/add', { recommendationIds });
  if (!r.ok) return { ok: false, message: r.message };
  // The new people and their chats come down with a pull, and a pull leaves out rows written in the last couple of
  // seconds (they may still be mid-transaction). So pull until they are here: "Saved, open" must open a page.
  await pullUntilHere(
    user.id,
    r.value.people.map((p) => p.id),
  );
  return { ok: true, people: r.value.people };
}

/**
 * What Connect did. The person is in People either way; `sent` says whether a LinkedIn connection request went out
 * on this click, and when it did not, `reason` says why in words to show as they are. `requested`: a request from the
 * student is waiting with them (this one, or one sent before), so the row reads "Request sent".
 */
export type ConnectOutcome =
  | {
      ok: true;
      person: { id: string; displayName: string; chatId: string };
      sent: boolean;
      requested: boolean;
      code?: SourceConnectCode;
      reason?: string;
    }
  | { ok: false; message: string };

/**
 * Connect with someone a search found: the server saves them to People and sends one LinkedIn connection request,
 * with no note, from the student's own LinkedIn. The click is the approval of that one request; no message and no
 * follow-up goes with it. The server sends at most one request per person, so a retry never sends a second.
 */
export async function connectSourced(
  user: Pick<User, 'id'>,
  recommendationId: string,
): Promise<ConnectOutcome> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/source/connect', { recommendationId });
  if (!r.ok) return { ok: false, message: r.message };
  await pullUntilHere(user.id, [r.value.person.id]);
  const { person, sent, code, reason } = r.value;
  return {
    ok: true,
    person,
    sent,
    requested: sent || code === 'already_requested',
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Whether Connect is offered on people a search found: an Orbit account whose own LinkedIn is connected and active
 * (the server sends the request from it). Not connected, paused, signed out, a copy with no account, the sample
 * student: the button is Save instead. The same status rule as a LinkedIn message (`linkedInSendWay`).
 */
export async function canConnectOnLinkedIn(user: Pick<User, 'id'>): Promise<boolean> {
  if (!isServerUser(user.id)) return false;
  const { status, asked } = await freshLinkedinStatus().catch(() => ({ status: undefined, asked: false }));
  return asked && !blockForStatus(status);
}

/**
 * The people, of these, with a connection request waiting: one went from Connect (their chat says when) and they are
 * not a connection yet.
 */
export async function requestsWaiting(personIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!personIds.length) return out;
  const chats = await db.chats.where('personId').anyOf(personIds).toArray();
  const asked = [
    ...new Set(chats.filter((c) => c.connectionRequestedAt && !c.archivedAt).map((c) => c.personId)),
  ];
  const people = await db.people.bulkGet(asked);
  asked.forEach((id, i) => {
    if (people[i] && !people[i]!.linkedinConnectedOn) out.add(id);
  });
  return out;
}

/**
 * Look up one sourced candidate's address on demand (plan 35 C3): a search no longer pays for every result's email,
 * so the student asks for the ones they will write to. Adding someone looks theirs up on the server already.
 */
export async function findEmail(
  user: Pick<User, 'id'>,
  who: string | { recommendationId: string } | { personId: string },
): Promise<{ ok: true; value: SourceEmailResponse } | { ok: false; message: string }> {
  if (!isServerUser(user.id)) return notHere();
  const body =
    typeof who === 'string'
      ? { recommendationId: who }
      : 'personId' in who
        ? { personId: serverIdOf(who.personId) ?? who.personId }
        : who;
  const r = await callApi('/source/email', body);
  if (!r.ok) return { ok: false, message: r.message };
  // someone the student already has: the address is on their row on the server now, so bring it down
  if ('personId' in body && r.value.email) await pullNow(user.id).catch(() => undefined);
  return { ok: true, value: r.value };
}

/** One candidate as a line: "Maya Chen, Partner at Seed Fund". */
export function candidateLine(c: SourcedCandidate): string {
  const role = [c.title, c.org].filter(Boolean).join(' at ');
  return `${c.name}${role ? `, ${role}` : ''}`;
}

/** The tier as a short chip: "Intro via Sam", "Shared background", "Open to students"; nothing for a cold match. */
export function tierChip(c: SourcedCandidate): string | undefined {
  if (c.knownPersonId || c.tier === 1) return 'You know them';
  if (c.tier === 2) return c.bridge ? `Intro via ${c.bridge.name.split(/\s+/)[0]}` : 'Intro possible';
  if (c.tier === 3) return 'Shared background';
  if (c.tier === 4) return 'Open to students';
  return undefined;
}

/** How sure Orbit is of the email, in words: verified, on their page, from the company pattern, or a guess. */
export function emailNote(c: SourcedCandidate): string | undefined {
  if (!c.email) return undefined;
  if (c.emailConfidence === 'verified') return `${c.email} (verified)`;
  if (c.emailConfidence === 'pattern') return `${c.email} (the company's usual address pattern)`;
  if (c.emailConfidence === 'guess') return `${c.email} (a guess, not confirmed)`;
  return `${c.email} (on their page)`;
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
for (const table of [PROVIDER_LABELS]) Object.setPrototypeOf(table, null);
