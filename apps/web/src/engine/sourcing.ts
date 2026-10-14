/**
 * Finding new people for a goal (plan 16 §6) from the browser's side, account mode only: the search runs on orbit-api
 * across its providers, the student adds the ones they want, and the new people and chats arrive with a pull.
 */
import type { GoalKind, SourcedCandidate, SourceSearchResponse, User } from '@orbit/core';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { pullNow } from './serverSync';

/** The providers by the names a student would know. */
export const PROVIDER_LABELS: Record<string, string> = {
  unipile: 'LinkedIn search',
  apollo: 'Apollo',
  exa: 'Web search',
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

export async function searchPeople(
  user: Pick<User, 'id'>,
  q: { purpose: GoalKind; query?: string; goalId?: string; limit?: number },
): Promise<SearchOutcome> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/source/search', {
    purpose: q.purpose,
    query: q.query?.trim() || undefined,
    goalId: q.goalId,
    limit: q.limit ?? 20,
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: r.value };
}

export type AddOutcome =
  | { ok: true; people: { id: string; displayName: string; chatId: string }[] }
  | { ok: false; message: string };

/** Add sourced candidates: each becomes a person with a chat at "to contact", and research starts on them. */
export async function addSourced(user: Pick<User, 'id'>, recommendationIds: string[]): Promise<AddOutcome> {
  if (!isServerUser(user.id)) return notHere();
  if (!recommendationIds.length) return { ok: false, message: 'Pick someone to add first.' };
  const r = await callApi('/source/add', { recommendationIds });
  if (!r.ok) return { ok: false, message: r.message };
  // the new people and their chats come down with the next pull; do it now so their pages open
  await pullNow(user.id).catch(() => undefined);
  return { ok: true, people: r.value.people };
}

/** One candidate as a line: "Maya Chen, Partner at Seed Fund (fit 0.82)". */
export function candidateLine(c: SourcedCandidate): string {
  const role = [c.title, c.org].filter(Boolean).join(' at ');
  return `${c.name}${role ? `, ${role}` : ''}`;
}
