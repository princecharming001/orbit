import type { User } from '@orbit/core';
import { newId, parseConnectionsCsv } from '@orbit/core';
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
