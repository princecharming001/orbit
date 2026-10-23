import type { LinkedInConnectionRow, Person, PersonField, PersonSource, User } from '@orbit/core';
import {
  isRecruiter,
  newId,
  normalizeCompany,
  parseConnectedOn,
  parseConnectionsCsv,
  roleFromHeadline,
} from '@orbit/core';
import { addTouchpoint, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { generateBrief, recommendationsRefresh } from './brief';
import { recomputeEdges } from './graph';
import { loadPeopleCache, suggestDuplicateMerges, upsertOrganization, upsertPerson } from './people';
import { freshPhoto } from './photos';

export async function importConnectionsCsv(
  user: User,
  csvText: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; updated: number; skipped: number }> {
  const { rows, skipped } = parseConnectionsCsv(csvText);
  const { imported, updated } = await importConnectionRows(user, rows, onProgress);
  return { imported, updated, skipped };
}

/**
 * The shared import path for LinkedIn connections, from the CSV export or a live sync: upsert each person (a
 * re-import never duplicates), notice job changes, record the connection date, then recompute closeness, the graph
 * and duplicate suggestions. Returns the person id each row landed on, in row order.
 */
async function importConnectionRows(
  user: User,
  rows: LinkedInConnectionRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; updated: number; personIds: string[] }> {
  const personIds: string[] = [];
  let imported = 0;
  let updated = 0;
  let i = 0;
  const cache = await loadPeopleCache(user.id);
  for (const r of rows) {
    const { person, created } = await upsertPerson(
      {
        userId: user.id,
        // first and last stay separate so "Lee, Jr." is read as a suffix, not as "Last, First"
        displayName: `${r.firstName} ${r.lastName}`.trim(),
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        linkedinUrl: r.url,
        companyRaw: r.company,
        position: r.position,
        connectedOn: r.connectedOn,
        source: 'linkedin_csv',
        userSchool: user.school,
        firstSeenAt: r.connectedOn ? `${r.connectedOn}T00:00:00.000Z` : undefined,
      },
      cache,
    );
    personIds.push(person.id);
    if (created) imported++;
    else updated++;
    if (r.company) {
      const existing = await db.affiliations
        .where('personId')
        .equals(person.id)
        .filter((a) => a.kind === 'employment' && a.isCurrent)
        .first();
      // a re-import that shows a new company or title is a job change: close the old role, open the new one
      // dated today (drafting reads it as the news for a congratulate note)
      // differences in case, spacing, punctuation, legal suffixes or a level ("Engineer II") are not a job change
      const changed =
        !!existing &&
        (normalizeCompany(existing.nameRaw) !== normalizeCompany(r.company) ||
          (!!existing.title && !!r.position && sameTitleKey(existing.title) !== sameTitleKey(r.position)));
      if (changed) {
        const today = new Date().toISOString().slice(0, 10);
        await db.affiliations.update(existing!.id, { isCurrent: false, endDate: today });
        await db.affiliations.add({
          id: newId('aff'),
          userId: user.id,
          personId: person.id,
          kind: 'employment',
          organizationId: person.currentOrganizationId,
          nameRaw: r.company,
          title: r.position,
          startDate: today,
          isCurrent: true,
          source: 'linkedin_csv',
        });
      }
      if (!existing)
        await db.affiliations.add({
          id: newId('aff'),
          userId: user.id,
          personId: person.id,
          kind: 'employment',
          organizationId: person.currentOrganizationId,
          nameRaw: r.company,
          title: r.position,
          isCurrent: true,
          source: 'linkedin_csv',
        });
    }
    if (r.connectedOn)
      await addTouchpoint({
        userId: user.id,
        personId: person.id,
        kind: 'linkedin_connected',
        occurredAt: `${r.connectedOn}T12:00:00.000Z`,
        refTable: 'linkedin_csv',
        refId: person.id,
        summary: 'Connected on LinkedIn',
        weight: 0.2,
      });
    i++;
    if (i % 25 === 0) onProgress?.(i, rows.length);
  }
  await recomputeAllStrengths(user.id);
  await recomputeEdges(user.id);
  await suggestDuplicateMerges(user.id);
  return { imported, updated, personIds };
}

/**
 * Import connections pulled live from Unipile (see integrations/unipile.ts, or the sample student's mock). They go
 * through the same tested path as the CSV export, and each person keeps LinkedIn's member id, which the CSV cannot
 * carry, so mutual-connection lookups can name them later. Recording the integration and refreshing the rest of Orbit
 * is the caller's job (engine/linkedinLive.ts).
 */
export async function importLiveConnections(
  user: User,
  connections: {
    firstName: string;
    lastName: string;
    position?: string;
    company?: string;
    url?: string;
    connectedOn?: string;
    memberId?: string;
    photoUrl?: string;
  }[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; updated: number; skipped: number }> {
  const kept = connections.filter((c) => c.firstName.trim() || c.lastName.trim());
  // A live connection's "position" is LinkedIn's headline when no company comes with it ("Former Analyst at
  // Goldman | MBA @ Wharton"): what they wrote about themselves, not their profile's current role. It is kept as
  // the headline and only fills a missing title or company (below), never overrides one, and never reads as a job
  // change; a title or company from their profile's experience (enrichment) or the student always wins.
  const headlines = kept.map((c) => (!c.company?.trim() && c.position?.trim()) || undefined);
  const rows: LinkedInConnectionRow[] = kept.map((c, i) => ({
    firstName: c.firstName.trim(),
    lastName: c.lastName.trim(),
    url: c.url?.trim() || undefined,
    company: c.company?.trim() || undefined,
    position: headlines[i] ? undefined : c.position?.trim() || undefined,
    // LinkedIn's export uses "DD Mon YYYY"; Unipile gives ISO. Both read the same way.
    connectedOn: parseConnectedOn(c.connectedOn),
  }));
  const r = await importConnectionRows(user, rows, onProgress);
  const at = new Date().toISOString();
  for (let i = 0; i < kept.length; i++) {
    const { memberId, photoUrl } = kept[i]!;
    const headline = headlines[i];
    const id = r.personIds[i];
    if ((!memberId && !photoUrl && !headline) || !id) continue;
    const p = await db.people.get(id);
    if (!p) continue;
    const patch: Partial<typeof p> = {};
    if (memberId && p.linkedinMemberId !== memberId) patch.linkedinMemberId = memberId;
    // their LinkedIn photo (the map and every list show it); a newer link replaces an expiring one
    const photo = freshPhoto(p.photoUrl, photoUrl);
    if (photo !== p.photoUrl) patch.photoUrl = photo;
    if (headline) Object.assign(patch, await roleFromLiveHeadline(p, headline));
    if (Object.keys(patch).length) await db.people.update(id, { ...patch, updatedAt: at });
  }
  return { imported: r.imported, updated: r.updated, skipped: connections.length - kept.length };
}

/** Fields a written-to-the-student or profile source owns: a headline never overwrites them. */
const ABOVE_HEADLINE = new Set<PersonSource>(['manual', 'enrichment', 'imessage', 'tracker_import', 'note']);

/**
 * What a live connection's headline adds to a person: the headline itself, and the role in its first part only where
 * the person has no title or company yet ("Former Analyst at Goldman" adds neither). A title older versions copied
 * from the whole headline is replaced by the role it names.
 */
export async function roleFromLiveHeadline(
  p: Pick<
    Person,
    'headline' | 'currentTitle' | 'currentOrganizationId' | 'fieldSources' | 'relationshipType' | 'sources'
  >,
  headline: string,
): Promise<Partial<Person>> {
  const patch: Partial<Person> = {};
  const owner = (f: PersonField) => p.fieldSources?.[f];
  const mayWrite = (f: PersonField) => !ABOVE_HEADLINE.has(owner(f) as PersonSource);
  if (headline !== p.headline && mayWrite('headline')) patch.headline = headline;
  const role = roleFromHeadline(headline);
  // a title that is the whole headline came from older syncs: read it again
  const copied = !!p.currentTitle && p.currentTitle.trim() === headline.trim() && mayWrite('currentTitle');
  if (copied) patch.currentTitle = role.title;
  else if (!p.currentTitle && role.title) patch.currentTitle = role.title;
  if (!p.currentOrganizationId && role.org) {
    const org = await upsertOrganization(role.org);
    if (org) {
      patch.currentOrganizationId = org.id;
      patch.currentOrganizationRaw = org.name;
    }
  }
  const title = 'currentTitle' in patch ? patch.currentTitle : p.currentTitle;
  if (p.relationshipType === 'unknown' && isRecruiter(title)) patch.relationshipType = 'recruiter';
  // a recruiter label that only came from the old headline-as-title reading
  if (copied && p.relationshipType === 'recruiter' && !isRecruiter(title)) patch.relationshipType = 'unknown';
  return patch;
}

/** A title reduced to what a job change would alter: "Sr. Analytics Engineer II" and "senior analytics engineer" match. */
export function sameTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\b\.?/g, 'senior')
    .replace(/\bjr\b\.?/g, 'junior')
    .replace(/\beng\b\.?/g, 'engineer')
    .replace(/\bmgr\b\.?/g, 'manager')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(i{1,3}|iv|v|[1-5]|l[1-9])\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Upload of a LinkedIn Connections.csv from anywhere in the app: import it, record the integration, and bring the
 * rest of Orbit up to date at once (recommendations on Discover and, after setup, first-message cards on Today), so
 * the student is never told "nobody matches" by a list that simply has not been rebuilt yet.
 */
export async function importLinkedInExport(
  user: User,
  csvText: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; updated: number; skipped: number; recommended: number }> {
  const r = await importConnectionsCsv(user, csvText, onProgress);
  const existing = await db.integrations
    .where('userId')
    .equals(user.id)
    .filter((i) => i.provider === 'linkedin_csv')
    .first();
  const at = new Date().toISOString();
  await db.integrations.put({
    id: existing?.id ?? newId('int'),
    userId: user.id,
    provider: 'linkedin_csv',
    status: 'active',
    scopes: [],
    syncState: { rows: r.imported + r.updated },
    connectedAt: existing?.connectedAt ?? at,
    lastSyncedAt: at,
  });
  const fresh = (await db.users.get(user.id)) ?? user;
  let recommended = 0;
  if (r.imported + r.updated > 0) {
    await recommendationsRefresh(fresh);
    recommended = await db.recommendations
      .where('userId')
      .equals(user.id)
      .filter((x) => x.status === 'new' || x.status === 'saved')
      .count();
    if (fresh.onboardingCompletedAt) await generateBrief(fresh, 'daily');
  }
  return { ...r, recommended };
}

/**
 * The text of Connections.csv from what the student picked: the CSV itself, or LinkedIn's whole ZIP (a phone cannot
 * easily take one file out of a ZIP). Anything else that is not text is refused with what to upload instead, so a
 * ZIP is never read as a CSV and imported as a person named "PK…".
 */
export async function connectionsText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await bytesOf(file));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return csvFromZip(bytes);
  // NUL bytes mean a binary file (a PDF, an image), not a spreadsheet export
  if (bytes.subarray(0, 4096).includes(0))
    throw new Error('That is not a CSV file. Upload Connections.csv from the LinkedIn export.');
  return new TextDecoder().decode(bytes);
}

const NO_CSV_IN_ZIP =
  'That ZIP has no Connections.csv in it. Request the export with Connections ticked, then upload the new file.';

/** Find Connections.csv in a ZIP (stored or deflated) by its central directory. */
async function csvFromZip(b: Uint8Array): Promise<string> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // the end-of-central-directory record sits in the last 64 KB
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('That ZIP file looks damaged. Download it from LinkedIn again.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/(^|\/)connections\.csv$/i.test(name)) continue;
    if (v.getUint32(local, true) !== 0x04034b50) break;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = b.subarray(start, start + size);
    if (method === 0) return new TextDecoder().decode(data);
    if (method !== 8 || typeof DecompressionStream === 'undefined')
      throw new Error('Orbit cannot open this ZIP here. Unzip it and upload Connections.csv from it.');
    const out = new Response(data.slice()).body!.pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(out).text();
  }
  throw new Error(NO_CSV_IN_ZIP);
}

/** A file's bytes; older engines (and the test DOM) have FileReader but no Blob.arrayBuffer. */
function bytesOf(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
