import type { User } from '@orbit/core';
import { newId, normalizeCompany, parseConnectionsCsv } from '@orbit/core';
import { addTouchpoint, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
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
