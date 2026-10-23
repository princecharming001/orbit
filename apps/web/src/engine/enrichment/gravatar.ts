/**
 * Gravatar (step 1 of the waterfall): the free photo some people attach to their email address. Gravatar documents
 * the lookup as the SHA-256 of the trimmed, lower-cased address (https://docs.gravatar.com/api/avatars/hash/), so no
 * library is needed: the browser's own WebCrypto hashes it. `d=404` makes a missing photo a failed load, which an
 * <img> probe tells apart without fetch (Orbit's content policy allows images from any https host, not fetches).
 *
 * A Gravatar only fills a missing photo; a LinkedIn photo replaces it later (engine/photos.ts).
 */

export async function gravatarHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function gravatarUrl(hash: string, size = 200): string {
  return `https://gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/** Whether an image loads: true for a photo, false for a 404 or no answer in time. */
export type ImageProbe = (url: string) => Promise<boolean>;

export const probeImage: ImageProbe = (url) =>
  new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(false);
      return;
    }
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 8000);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth > 0);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    img.src = url;
  });

/** The first of these addresses with a Gravatar photo, as the link to show, or undefined. */
export async function findGravatar(
  emails: (string | undefined)[],
  probe: ImageProbe = probeImage,
): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const e of emails) {
    const addr = e?.trim().toLowerCase();
    if (!addr?.includes('@') || seen.has(addr)) continue;
    seen.add(addr);
    const url = gravatarUrl(await gravatarHash(addr));
    if (await probe(url)) return url;
  }
  return undefined;
}
