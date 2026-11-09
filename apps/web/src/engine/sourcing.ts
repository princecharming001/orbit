/**
 * Finding new people for a goal (plan 16 §6) from the browser's side, account mode only: the search runs on orbit-api
 * across its providers, the student adds the ones they want, and the new people and chats arrive with a pull.
 */
import type {
  GoalKind,
  SourcedCandidate,
  SourceEmailResponse,
  SourceSearchResponse,
  User,
} from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { pullNow } from './serverSync';

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
}

export async function searchPeople(
  user: Pick<User, 'id'>,
  q: { purpose: GoalKind; query?: string; goalId?: string; limit?: number; filters?: SearchFilters },
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
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: r.value };
}

export type AddOutcome =
  | { ok: true; people: { id: string; displayName: string; chatId: string }[] }
  | { ok: false; message: string };

/** Add sourced candidates the student picked: each becomes a person with a chat at "to contact". No research starts. */
export async function addSourced(user: Pick<User, 'id'>, recommendationIds: string[]): Promise<AddOutcome> {
  if (!isServerUser(user.id)) return notHere();
  if (!recommendationIds.length) return { ok: false, message: 'Pick someone to add first.' };
  const r = await callApi('/source/add', { recommendationIds });
  if (!r.ok) return { ok: false, message: r.message };
  // the new people and their chats come down with the next pull; do it now so their pages open
  await pullNow(user.id).catch(() => undefined);
  return { ok: true, people: r.value.people };
}

/**
 * Look up one sourced candidate's address on demand (plan 35 C3): a search no longer pays for every result's email,
 * so the student asks for the ones they will write to. Adding someone looks theirs up on the server already.
 */
export async function findEmail(
  user: Pick<User, 'id'>,
  recommendationId: string,
): Promise<{ ok: true; value: SourceEmailResponse } | { ok: false; message: string }> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/source/email', { recommendationId });
  if (!r.ok) return { ok: false, message: r.message };
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
