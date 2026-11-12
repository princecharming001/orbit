/**
 * Contacts exported from the Mac's Contacts app (File, Export, Export vCard): who each phone number and address
 * belongs to, so the texts Orbit imports are filed on named people. Read here; nothing is uploaded.
 */
import { DEFAULT_PHONE_REGION, handlesIn, normalizeHandle, type SocialPlatform, toE164 } from '@orbit/core';

export interface VCardContact {
  name: string;
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  org?: string;
  title?: string;
  /**
   * Instagram and X handles the card lists (a social profile, a messaging address, a link or the note): hard proof
   * for matching an account to someone the student knows (plan 43 §3.4)
   */
  handles: Record<SocialPlatform, string[]>;
}

const HANDLE_SHAPE: Record<SocialPlatform, RegExp> = {
  instagram: /^[a-z0-9._]{1,30}$/,
  x: /^[a-z0-9_]{1,15}$/,
};

/** The platform a profile's type names: Apple writes "instagram", "twitter" or "x". */
function platformOf(type: string | undefined): SocialPlatform | undefined {
  const parts = (type ?? '').toLowerCase().split(',');
  if (parts.some((t) => t.includes('instagram'))) return 'instagram';
  if (parts.some((t) => t === 'x' || t.includes('twitter'))) return 'x';
  return undefined;
}

/**
 * Handles in one card line. X-SOCIALPROFILE and IMPP name their platform in a parameter and carry the handle as
 * `x-user=`, as an "x-apple:handle" value or as a profile link; URL and NOTE are read for links and "ig: @name".
 */
export function handlesFromLine(
  key: string,
  params: Record<string, string>,
  value: string,
): { platform: SocialPlatform; handle: string }[] {
  const out: { platform: SocialPlatform; handle: string }[] = [];
  const add = (platform: SocialPlatform, raw: string | undefined) => {
    const h = raw ? normalizeHandle(raw) : '';
    if (h && HANDLE_SHAPE[platform].test(h)) out.push({ platform, handle: h });
  };
  const text = vText(value);
  if (key === 'X-SOCIALPROFILE' || key === 'IMPP') {
    const named = platformOf(params.type ?? params['x-service-type']) ?? platformOf(text.split(':')[0]);
    const platforms: SocialPlatform[] = named ? [named] : ['instagram', 'x'];
    for (const p of platforms) {
      const fromLink = handlesIn(text, p);
      if (fromLink.length) {
        for (const h of fromLink) add(p, h);
        continue;
      }
      if (!named) continue;
      if (params['x-user']) add(p, params['x-user']);
      else if (!/^https?:/i.test(text)) add(p, text.replace(/^[a-z-]+:/i, ''));
    }
    return out;
  }
  if (key === 'URL' || key === 'NOTE')
    for (const p of ['instagram', 'x'] as const) for (const h of handlesIn(text, p)) add(p, h);
  return out;
}

/**
 * A phone number in one form, E.164 (+15551234567), read with libphonenumber-js in `region` (the country the
 * student's numbers are written for; core `phoneRegionFor`) when it has no country code: "(555) 123-4567" is
 * +15551234567 in the US and "020 7946 0958" is +442079460958 in the UK. A leading 00 is an international prefix;
 * short codes (verification texts, 5 or 6 digits) are not people and come back undefined.
 */
export function normalizePhone(
  raw: string | undefined,
  region: string = DEFAULT_PHONE_REGION,
): string | undefined {
  return toE164(raw, region);
}

const vText = (v: string) =>
  v
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();

export function parseVCards(text: string, region: string = DEFAULT_PHONE_REGION): VCardContact[] {
  // folded lines continue with a leading space or tab
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const out: VCardContact[] = [];
  let cur: VCardContact | undefined;
  for (const line of lines) {
    const t = line.trim();
    if (/^BEGIN:VCARD$/i.test(t)) {
      cur = { name: '', phones: [], emails: [], handles: { instagram: [], x: [] } };
      continue;
    }
    if (/^END:VCARD$/i.test(t)) {
      if (cur) {
        cur.name ||= [cur.firstName, cur.lastName].filter(Boolean).join(' ');
        if (cur.name && (cur.phones.length || cur.emails.length)) out.push(cur);
      }
      cur = undefined;
      continue;
    }
    if (!cur) continue;
    const colon = t.indexOf(':');
    if (colon < 0) continue;
    // "item1.TEL;type=CELL" → "TEL"
    const head = t.slice(0, colon).split(';');
    const key = head[0]!.split('.').pop()!.toUpperCase();
    const value = t.slice(colon + 1);
    if (key === 'X-SOCIALPROFILE' || key === 'IMPP' || key === 'URL' || key === 'NOTE') {
      const params: Record<string, string> = {};
      for (const p of head.slice(1)) {
        const eq = p.indexOf('=');
        const k = eq > 0 ? p.slice(0, eq).toLowerCase() : 'type';
        const v = (eq > 0 ? p.slice(eq + 1) : p).replace(/^"|"$/g, '');
        params[k] = params[k] ? `${params[k]},${v}` : v;
      }
      for (const { platform, handle } of handlesFromLine(key, params, value))
        if (!cur.handles[platform].includes(handle)) cur.handles[platform].push(handle);
      if (key !== 'NOTE') continue;
    }
    if (key === 'FN') cur.name = vText(value);
    else if (key === 'N') {
      const [last, first] = value.split(';').map(vText);
      cur.lastName = last || undefined;
      cur.firstName = first || undefined;
    } else if (key === 'TEL') {
      const p = normalizePhone(value, region);
      if (p && !cur.phones.includes(p)) cur.phones.push(p);
    } else if (key === 'EMAIL') {
      const e = vText(value).toLowerCase();
      if (e.includes('@') && !cur.emails.includes(e)) cur.emails.push(e);
    } else if (key === 'ORG') cur.org = vText(value.split(';')[0] ?? '') || undefined;
    else if (key === 'TITLE') cur.title = vText(value) || undefined;
  }
  return out;
}
