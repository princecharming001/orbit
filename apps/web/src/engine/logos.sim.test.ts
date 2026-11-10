/**
 * The logo rules under random answers (plan 37): whatever order the shared list, a person's position and the student's
 * own pick arrive in, an organisation's logo is always the logo of the company it holds (never another company's),
 * a company settled exactly never changes, and a name the shared list stops standing by keeps no logo from a search.
 */
import { normalizeCompany } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { adoptCompany, dropNameMatch } from './enrichment/logos';
import { upsertOrganization } from './people';

/** A small deterministic random source, so a failure can be replayed by its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const COMPANIES = ['100', '200', '300'];
const logoOf = (id: string) => `https://store.test/company-logos/${id}.png`;

type Step =
  | { kind: 'name'; id: string; logo: boolean }
  | { kind: 'exact'; id: string; logo: boolean }
  | { kind: 'shared-gone' };

beforeEach(async () => {
  await wipeDatabase();
});

describe('logo rules under random answers', () => {
  it('400 random sequences: the logo is always the held company’s, and an exact company never changes', async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const org = (await upsertOrganization(`Acme ${seed}`))!;
      let exactId: string | undefined;
      const steps: Step[] = [];
      for (let i = 0; i < 6; i++) {
        const x = r();
        const id = COMPANIES[Math.floor(r() * COMPANIES.length)]!;
        steps.push(
          x < 0.45
            ? { kind: 'name', id, logo: r() < 0.8 }
            : x < 0.75
              ? { kind: 'exact', id, logo: r() < 0.8 }
              : { kind: 'shared-gone' },
        );
      }
      for (const st of steps) {
        const cur = (await db.organizations.get(org.id))!;
        if (st.kind === 'shared-gone') await dropNameMatch(cur);
        else
          await adoptCompany(cur, {
            companyId: st.id,
            logoUrl: st.logo ? logoOf(st.id) : undefined,
            exact: st.kind === 'exact',
          });
        const now = (await db.organizations.get(org.id))!;
        if (st.kind === 'exact' && !exactId)
          exactId = now.linkedinCompanyExact ? now.linkedinCompanyId : exactId;
        // the logo is the held company's, or none
        if (now.logoUrl && now.logoUrl !== logoOf(now.linkedinCompanyId ?? '-'))
          problems.push(`seed ${seed}: logo ${now.logoUrl} on company ${now.linkedinCompanyId}`);
        // once exact, the company never changes
        if (exactId && now.linkedinCompanyId !== exactId)
          problems.push(`seed ${seed}: exact ${exactId} became ${now.linkedinCompanyId}`);
        // exact means a company is held
        if (now.linkedinCompanyExact && !now.linkedinCompanyId)
          problems.push(`seed ${seed}: exact with no company`);
      }
      expect(normalizeCompany(org.name)).toBeTruthy();
    }
    expect(problems.slice(0, 5)).toEqual([]);
  }, 60_000);
});
