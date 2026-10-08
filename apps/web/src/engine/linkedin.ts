import type { User } from '@orbit/core';
import { newId, normalizeCompany, parseConnectionsCsv } from '@orbit/core';
import { addTouchpoint, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { generateBrief, recommendationsRefresh } from './brief';
import { recomputeEdges } from './graph';
import { loadPeopleCache, suggestDuplicateMerges, upsertPerson } from './people';

export async function importConnectionsCsv(
  user: User,
  csvText: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ imported: number; updated: number; skipped: number }> {
  const { rows, skipped } = parseConnectionsCsv(csvText);
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
  return { imported, updated, skipped };
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
