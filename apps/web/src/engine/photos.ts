/**
 * People's photos from LinkedIn. LinkedIn's photo links expire after a few weeks, so a newer one from a sync, a
 * search or a lookup replaces one that came from LinkedIn; a photo from anywhere else (the student's own) is kept.
 *
 * Which photo wins (plan 17 E): one the student set > LinkedIn > Gravatar (found from their email address). A Gravatar
 * only fills a missing photo, and a LinkedIn photo replaces a Gravatar one.
 *
 * Who fetches a missing or expired LinkedIn photo: engine/photoQueue.ts, a few calls a minute while the app is open.
 */
export function isLinkedInPhoto(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'licdn.com' || host.endsWith('.licdn.com');
  } catch {
    return false;
  }
}

/** A photo Orbit found on Gravatar from someone's email address. */
export function isGravatarPhoto(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'gravatar.com' || host.endsWith('.gravatar.com');
  } catch {
    return false;
  }
}

/** The photo to keep: the incoming LinkedIn one when there is none yet, or the current one is an older LinkedIn link or a Gravatar. */
export function freshPhoto(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current;
  return !current || isGravatarPhoto(current) || (isLinkedInPhoto(current) && current !== incoming)
    ? incoming
    : current;
}

/**
 * When a LinkedIn image link stops working: LinkedIn signs its media links with an expiry (`e=`, seconds since 1970).
 * Undefined for a link that carries none (or is not LinkedIn's).
 */
export function linkedInImageExpiry(url: string | undefined): Date | undefined {
  if (!url || !isLinkedInPhoto(url)) return undefined;
  try {
    const e = Number(new URL(url).searchParams.get('e'));
    return Number.isFinite(e) && e > 0 ? new Date(e * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** A LinkedIn image link that has expired, or will within `marginMs` (a day by default): time to fetch a new one. */
export function linkedInImageExpired(
  url: string | undefined,
  now = new Date(),
  marginMs = 86_400_000,
): boolean {
  const at = linkedInImageExpiry(url);
  return !!at && at.getTime() - marginMs <= now.getTime();
}
