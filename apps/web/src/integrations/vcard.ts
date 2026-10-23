/**
 * Contacts exported from the Mac's Contacts app (File, Export, Export vCard): who each phone number and address
 * belongs to, so the texts Orbit imports are filed on named people. Read here; nothing is uploaded.
 */
import { DEFAULT_PHONE_REGION, toE164 } from '@orbit/core';

export interface VCardContact {
  name: string;
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  org?: string;
  title?: string;
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
      cur = { name: '', phones: [], emails: [] };
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
    const key = t.slice(0, colon).split(';')[0]!.split('.').pop()!.toUpperCase();
    const value = t.slice(colon + 1);
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
