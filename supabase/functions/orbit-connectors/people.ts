/**
 * Plan 41: what Orbit already knows about a LinkedIn person, read before every LinkedIn read.
 *
 * Every read of a person, whichever route made it, is kept once under each name LinkedIn has for them (their member
 * id and their public name) in the shared store (orbit_private.linkedin_shared):
 *
 * - `pp2:` what anyone would see (name, headline, work, schools), with the sections that read asked for. Shared across
 *   students, 30 days. A kept read with more sections answers a request for fewer.
 * - `pv1:` what depends on the reader (how many connections they share, how far apart they are, contact details).
 *   Per account, 14 days.
 * - `ph1:` their photo, copied into Orbit's storage so the link never expires. Shared, a year. From a read only.
 * - `pa1:` a photo the browser already had (from the connections list, a search row or a chat) and handed over to be
 *   copied. Per account, because the browser said whose it is: one student's browser can never set what another sees.
 * - `mu1:` the answer to "who do I know who knows them". Per account, 14 days.
 *
 * Copying a picture is a download from LinkedIn's image host, not activity on the student's LinkedIn account.
 * Keys are hashes; nothing here says which student asked.
 */

export interface PeopleStore {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  put(key: string, value: Record<string, unknown>, days?: number): Promise<void>;
}

/** Writes a picture's bytes into storage under a name; the address it is served from, or nothing. */
export type PhotoWriter = (
  name: string,
  bytes: ArrayBuffer,
  contentType: string,
) => Promise<string | undefined>;

export const PERSON_DAYS = 30;
export const VIEWER_DAYS = 14;
export const PHOTO_DAYS = 365;
/** Someone LinkedIn has no picture for is not read again for a picture sooner than this. */
export const NO_PHOTO_DAYS = 30;
export const PHOTO_MAX_BYTES = 600_000;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

const norm = (id: string) => id.trim().toLowerCase();

export const personKey = async (id: string) => `pp2:${await sha256(norm(id))}`;
export const viewerKey = async (accountId: string, id: string) =>
  `pv1:${await sha256(`${accountId}|${norm(id)}`)}`;
export const photoKey = async (id: string) => `ph1:${await sha256(norm(id))}`;
export const ownPhotoKey = async (accountId: string, id: string) =>
  `pa1:${await sha256(`${accountId}|${norm(id)}`)}`;
export const mutualsKey = async (accountId: string, target: string) =>
  `mu1:${await sha256(`${accountId}|${norm(target)}`)}`;

/** The names one person goes by, each once, without the empty ones. */
export function aliases(ids: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const v = typeof id === 'string' ? id.trim() : '';
    if (!v || seen.has(norm(v))) continue;
    seen.add(norm(v));
    out.push(v);
  }
  return out;
}

export interface PersonRecord {
  profile: Record<string, unknown>;
  sections: string[];
  recommendations: boolean;
  at: string;
}

export interface ViewerRecord {
  mutualCount?: number;
  distance?: number;
  contact?: unknown;
  at: string;
}

export interface PhotoRecord {
  url?: string;
  /** LinkedIn has no picture for them */
  none?: boolean;
  providerId?: string;
  publicIdentifier?: string;
  at: string;
}

const quiet = async <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

/** Whether a kept read answers a request for these sections. */
export function covers(
  rec: Pick<PersonRecord, 'sections' | 'recommendations'>,
  sections: string[],
  recommendations: boolean,
): boolean {
  if (recommendations && !rec.recommendations) return false;
  const have = new Set(rec.sections);
  return sections.every((s) => have.has(s));
}

export async function getPerson(store: PeopleStore, id: string): Promise<PersonRecord | undefined> {
  const v = await quiet(personKey(id).then((k) => store.get(k)));
  if (!v || typeof v.profile !== 'object' || !v.profile || !Array.isArray(v.sections)) return undefined;
  return {
    profile: v.profile as Record<string, unknown>,
    sections: v.sections.map(String),
    recommendations: v.recommendations === true,
    at: String(v.at ?? ''),
  };
}

/** Keep a read under each of the person's names; a fuller read already kept is never replaced by a thinner one. */
export async function putPerson(store: PeopleStore, ids: string[], rec: PersonRecord): Promise<void> {
  for (const id of aliases(ids)) {
    const had = await getPerson(store, id);
    if (
      had &&
      covers(had, rec.sections, rec.recommendations) &&
      !covers(rec, had.sections, had.recommendations)
    )
      continue;
    await quiet(personKey(id).then((k) => store.put(k, { ...rec }, PERSON_DAYS)));
  }
}

export async function getViewer(
  store: PeopleStore,
  accountId: string,
  id: string,
): Promise<ViewerRecord | undefined> {
  const v = await quiet(viewerKey(accountId, id).then((k) => store.get(k)));
  if (!v) return undefined;
  return {
    mutualCount: typeof v.mutualCount === 'number' ? v.mutualCount : undefined,
    distance: typeof v.distance === 'number' ? v.distance : undefined,
    contact: v.contact ?? undefined,
    at: String(v.at ?? ''),
  };
}

export async function putViewer(
  store: PeopleStore,
  accountId: string,
  ids: string[],
  rec: ViewerRecord,
): Promise<void> {
  const value = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
  for (const id of aliases(ids))
    await quiet(viewerKey(accountId, id).then((k) => store.put(k, value, VIEWER_DAYS)));
}

const photoOf = (v: Record<string, unknown> | undefined): PhotoRecord | undefined => {
  if (!v) return undefined;
  const url = typeof v.url === 'string' && v.url ? v.url : undefined;
  if (!url && v.none !== true) return undefined;
  return {
    url,
    none: v.none === true || undefined,
    providerId: typeof v.providerId === 'string' ? v.providerId : undefined,
    publicIdentifier: typeof v.publicIdentifier === 'string' ? v.publicIdentifier : undefined,
    at: String(v.at ?? ''),
  };
};

/** A kept photo: the one a read brought (shared), else the one this account's browser handed over. */
export async function getPhoto(
  store: PeopleStore,
  accountId: string,
  id: string,
): Promise<PhotoRecord | undefined> {
  const shared = photoOf(await quiet(photoKey(id).then((k) => store.get(k))));
  if (shared?.url) return shared;
  const own = photoOf(await quiet(ownPhotoKey(accountId, id).then((k) => store.get(k))));
  return own?.url ? own : shared;
}

async function copy(
  write: PhotoWriter,
  name: string,
  url: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await doFetch(url);
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await res.arrayBuffer();
    if (!res.ok || !type.startsWith('image/') || !bytes.byteLength || bytes.byteLength > PHOTO_MAX_BYTES)
      return undefined;
    return await write(name, bytes, type);
  } catch {
    return undefined;
  }
}

/**
 * Copy the picture a LinkedIn read returned into storage and keep it for everyone, under each of the person's names.
 * `urls` are tried in order (the large picture, then the small one when the large is too big). The stored address.
 */
export async function keepReadPhoto(
  store: PeopleStore,
  write: PhotoWriter | undefined,
  who: { ids: string[]; providerId?: string; publicIdentifier?: string },
  urls: (string | undefined)[],
  doFetch: typeof fetch,
  now: Date,
): Promise<string | undefined> {
  const ids = aliases(who.ids);
  if (!ids.length) return undefined;
  const base = { providerId: who.providerId, publicIdentifier: who.publicIdentifier, at: now.toISOString() };
  const links = urls.filter((u): u is string => !!u);
  if (!links.length) {
    for (const id of ids)
      await quiet(photoKey(id).then((k) => store.put(k, clean({ ...base, none: true }), NO_PHOTO_DAYS)));
    return undefined;
  }
  if (!write) return undefined;
  const name = (await sha256(norm(who.providerId ?? ids[0]!))).slice(0, 40);
  let kept: string | undefined;
  for (const u of links) {
    kept = await copy(write, name, u, doFetch);
    if (kept) break;
  }
  if (!kept) return undefined;
  for (const id of ids)
    await quiet(photoKey(id).then((k) => store.put(k, clean({ ...base, url: kept }), PHOTO_DAYS)));
  return kept;
}

/** Copy a picture this account's browser already had, for this account only. The stored address. */
export async function keepOwnPhoto(
  store: PeopleStore,
  write: PhotoWriter | undefined,
  accountId: string,
  ids: string[],
  url: string,
  doFetch: typeof fetch,
  now: Date,
): Promise<string | undefined> {
  const names = aliases(ids);
  if (!write || !names.length) return undefined;
  const name = `a-${(await sha256(`${accountId}|${norm(names[0]!)}`)).slice(0, 40)}`;
  const kept = await copy(write, name, url, doFetch);
  if (!kept) return undefined;
  for (const id of names)
    await quiet(
      ownPhotoKey(accountId, id).then((k) => store.put(k, { url: kept, at: now.toISOString() }, PHOTO_DAYS)),
    );
  return kept;
}

const clean = (v: Record<string, unknown>) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

/** People's photos in Orbit's storage (bucket people-photos), written with the service role key. */
export function storagePhotoWriter(
  url: string,
  serviceKey: string,
  doFetch: typeof fetch = fetch,
): PhotoWriter {
  return async (name, bytes, contentType) => {
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const path = `${name.replace(/[^\w-]/g, '')}.${ext}`;
    const r = await doFetch(`${url}/storage/v1/object/people-photos/${path}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': contentType,
        'x-upsert': 'true',
        'cache-control': '31536000',
      },
      body: bytes,
    });
    return r.ok ? `${url}/storage/v1/object/public/people-photos/${path}` : undefined;
  };
}

/** One row of the daily count: reads made, reads answered from what was kept, reads refused. */
export interface CallCount {
  accountId: string;
  kind: string;
  caller: string;
  made?: number;
  saved?: number;
  refused?: number;
}
export type CallSink = (row: CallCount) => Promise<void>;

/** The daily count over PostgREST (orbit.linkedin_calls_daily through one service-role function). */
export function postgrestCallSink(url: string, serviceKey: string, doFetch: typeof fetch = fetch): CallSink {
  return async (row) => {
    await doFetch(`${url}/rest/v1/rpc/orbit_linkedin_calls_add`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_account: row.accountId,
        p_kind: row.kind,
        p_caller: row.caller,
        p_made: row.made ?? 0,
        p_saved: row.saved ?? 0,
        p_refused: row.refused ?? 0,
      }),
    });
  };
}
