/**
 * People's photos from LinkedIn. LinkedIn's photo links expire after a few weeks, so a newer one from a sync, a
 * search or a lookup replaces one that came from LinkedIn; a photo from anywhere else (the student's own) is kept.
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

/** The photo to keep: the incoming LinkedIn one when there is none yet or the current one is an older LinkedIn link. */
export function freshPhoto(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current;
  return !current || (isLinkedInPhoto(current) && current !== incoming) ? incoming : current;
}
