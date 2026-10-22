/**
 * Contacts exported from the Mac's Contacts app (File, Export, Export vCard): who each phone number and address
 * belongs to, so the texts Orbit imports are filed on named people. Read here; nothing is uploaded.
 */

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
 * A phone number in one form: +15551234567. Ten US digits get +1; a leading 00 is an international prefix; short codes
 * (verification texts, 5 or 6 digits) are not people and come back undefined.
 */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const plus = raw.trim().startsWith('+');
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 7) return undefined;
  if (!plus && d.length === 10) return `+1${d}`;
  if (!plus && d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
}

const vText = (v: string) =>
  v
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();

export function parseVCards(text: string): VCardContact[] {
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
      const p = normalizePhone(value);
      if (p && !cur.phones.includes(p)) cur.phones.push(p);
    } else if (key === 'EMAIL') {
      const e = vText(value).toLowerCase();
      if (e.includes('@') && !cur.emails.includes(e)) cur.emails.push(e);
    } else if (key === 'ORG') cur.org = vText(value.split(';')[0] ?? '') || undefined;
    else if (key === 'TITLE') cur.title = vText(value) || undefined;
  }
  return out;
}
